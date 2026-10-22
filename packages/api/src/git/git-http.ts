import { Buffer } from "node:buffer";
import git from "isomorphic-git";
import {
  FLUSH,
  GitProtocolError,
  isGitRefName,
  parsePktLines,
  parseReceivePackBody,
  pktLine,
  receivePackResponse,
  ZERO_OID,
  type RefUpdate,
} from "./git-protocol";
import { MAX_GIT_NEGOTIATION_BYTES, MAX_GIT_PUSH_BYTES } from "@beutl/core";
import { GitObjectStore, type GitObjectBucket, type ObjectStore } from "./git-object-store";
import { GitFileSystem } from "./git-filesystem";
import { readRefs } from "./git-refs";
import { GitObjectReader, type PackedGitEntry } from "./object-reader";
import { collectGitObjects, GitObjectGraphError } from "./object-graph";
import { createGitPack, gitPackResponse } from "./pack-writer";
import { GitPackLimitError, GitPackValidationError, validateGitPack, type ValidatedGitObject } from "./pack-validation";

// Incoming pack validation and isomorphic-git indexing read full packs in memory.
// Keep the Git history small; media must go through LFS.
export const MAX_GIT_REPOSITORY_BYTES = 16 * 1024 * 1024;
// Leave room below the object adapter's 10,000-entry listing ceiling, including
// directories. Rejected pushes must leave the repository readable and deletable.
const MAX_GIT_REPOSITORY_OBJECTS = 9_000;
const MAX_GIT_REPOSITORY_REFS = 128;
const GITDIR = "/repo.git";
type CheckedRefUpdate = RefUpdate & { error?: string };

function incomingGitObjectBytes(pack: Uint8Array): number {
  if (pack.byteLength === 0) return 0; // Ref-only update/deletion.
  if (pack.byteLength < 32 || new TextDecoder().decode(pack.subarray(0, 4)) !== "PACK") {
    throw new Error("Invalid Git pack header");
  }
  const header = new DataView(pack.buffer, pack.byteOffset, pack.byteLength);
  if (![2, 3].includes(header.getUint32(4))) throw new Error("Unsupported Git pack version");
  // indexPack writes a v2 index: 8-byte header, 256 fanout entries, 28
  // bytes/object (SHA-1, CRC, offset), and two 20-byte checksums. The incoming
  // 8 MiB bound means offsets never need the additional 64-bit offset table.
  return pack.byteLength + 1072 + header.getUint32(8) * 28;
}

export async function readBodyAtMost(request: Request, limit: number): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      request.signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > limit) throw new RangeError("Git request body is too large");
      chunks.push(next.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

/**
 * The bare repository as stored, without writing anything to it. With loose
 * object hints, reads skip looking for loose objects once a listing shows none.
 */
export function readGitRepository(bucket: GitObjectBucket, repoId: string,
  { store = new GitObjectStore(bucket), looseObjectHints = false }: { store?: ObjectStore; looseObjectHints?: boolean } = {}) {
  const prefix = `git/repos/${repoId}`;
  const fs = new GitFileSystem(store, prefix, looseObjectHints);
  return { store, prefix, fs, repo: { fs, gitdir: GITDIR, cache: {} } };
}

/** Opens the bare repository, writing HEAD/config the first time it is used. */
async function openRepository(bucket: GitObjectBucket, repoId: string) {
  const opened = readGitRepository(bucket, repoId);
  const root = `${opened.prefix}${GITDIR}/`;
  // Check both independently so a failed first initialization can be retried
  // without changing an existing repository's default branch.
  for (const [name, contents] of [
    ["config", "[core]\n\trepositoryformatversion = 0\n\tfilemode = false\n\tbare = true\n"],
    ["HEAD", "ref: refs/heads/main\n"],
  ]) if (!await opened.store.head(root + name)) await opened.store.put(root + name, Buffer.from(contents));
  return opened;
}

export async function initializeGitRepository(bucket: GitObjectBucket, repoId: string): Promise<void> {
  await openRepository(bucket, repoId);
}

export type GitService = "git-upload-pack" | "git-receive-pack";

export function isGitService(value: string | undefined): value is GitService {
  return value === "git-upload-pack" || value === "git-receive-pack";
}

export async function advertiseGitRefs(bucket: GitObjectBucket, repoId: string, service: GitService): Promise<Response> {
  const opened = await openRepository(bucket, repoId), root = `${opened.prefix}${GITDIR}/`;
  const [refs, headBytes] = await Promise.all([readRefs(opened.store, root), opened.store.get(`${root}HEAD`)]);
  const head = headBytes ? Buffer.from(headBytes).toString("utf8").trim() : "";
  const target = head.startsWith("ref: ") && isGitRefName(head.slice(5)) ? head.slice(5) : undefined;
  const headOid = target ? refs.get(target) : /^[0-9a-f]{40}$/u.test(head) ? head : undefined;
  const capabilities = service === "git-upload-pack"
    ? ["multi_ack_detailed", "thin-pack", "side-band", "side-band-64k", "ofs-delta",
      "allow-tip-sha1-in-want", "allow-reachable-sha1-in-want", ...(target ? [`symref=HEAD:${target}`] : [])]
    : ["report-status", "delete-refs", "ofs-delta", "side-band-64k"];
  const entries: [string, string][] = headOid ? [["HEAD", headOid]] : [];
  const reader = new GitObjectReader(opened);
  for (const [name, oid] of [...refs].sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (!isGitRefName(name)) throw new Error("Invalid stored Git ref");
    entries.push([name, oid]);
    if (service === "git-upload-pack" && name.startsWith("refs/tags/")) {
      let peeled = oid;
      for (let depth = 0; (await reader.info(peeled))?.type === "tag"; depth++) {
        if (depth >= 16) throw new Error("Git tag chain is too deep");
        const object = /^object ([0-9a-f]{40})\n/u.exec(Buffer.from(await reader.read(peeled)).toString("utf8"))?.[1];
        if (!object) throw new Error("Invalid Git tag");
        peeled = object;
      }
      if (peeled !== oid) entries.push([`${name}^{}`, peeled]);
    }
  }
  if (!entries.length) entries.push(["capabilities^{}", ZERO_OID]);
  const body = Buffer.concat([pktLine(`# service=${service}\n`), FLUSH, ...entries.map(([name, oid], index) =>
    pktLine(`${oid} ${name}${index === 0 ? `\0${capabilities.join(" ")}` : ""}\n`)), FLUSH]);
  return new Response(body, { headers: { "Content-Type": `application/x-${service}-advertisement`, "Cache-Control": "no-cache" } });
}

// A repository with loose objects reads storage for every unknown have. Haves
// past this many in one request count as unknown: the pack stays correct, at
// worst larger. Git sends its newest commits first, so shared ones come early.
const MAX_CHECKED_HAVES = 1024;
const encodePktLines = (lines: (string | null)[]) => Buffer.concat(lines.map((line) => line === null ? FLUSH : pktLine(line)));
const haveOf = (line: string | null) => line?.startsWith("have ") ? line.slice(5, 45) : undefined;

/** The haves this repository also holds, in request order; their ancestry is common too. */
async function commonObjects(reader: GitObjectReader, haves: string[]): Promise<string[]> {
  const common: string[] = [];
  for (const oid of [...new Set(haves)].slice(0, MAX_CHECKED_HAVES)) {
    if (await reader.info(oid)) common.push(oid);
  }
  return common;
}

export async function uploadGitPack(request: Request, bucket: GitObjectBucket, repoId: string): Promise<Response> {
  const body = await readBodyAtMost(request, MAX_GIT_NEGOTIATION_BYTES);
  let lines: (string | null)[];
  try { lines = parsePktLines(body); }
  catch (error) { if (error instanceof GitProtocolError) return new Response(error.message, { status: 400 }); throw error; }
  const opened = await openRepository(bucket, repoId);
  const objects = await opened.store.list(`${opened.prefix}/repo.git/objects/`);
  if (objects.objects.reduce((size, object) => size + object.size, 0) > MAX_GIT_REPOSITORY_BYTES)
    return new Response("Git history exceeds the serving limit", { status: 413 });
  const wants = lines.filter((line): line is string => line?.startsWith("want ") ?? false).map((line) => line.slice(5, 45));
  const haves = lines.map(haveOf).filter((oid): oid is string => oid !== undefined);
  if ([...wants, ...haves].some((oid) => !/^[0-9a-f]{40}$/u.test(oid)))
    return new Response("Invalid Git object ID", { status: 400 });
  const capabilities = new Set(lines.find((line) => line?.startsWith("want "))?.trimEnd().split(" ").slice(2) ?? []);
  const multiAck = capabilities.has("multi_ack_detailed"), done = lines.some((line) => line?.startsWith("done"));
  const reply = (text: string[]) => new Response(encodePktLines(text) as Uint8Array<ArrayBuffer>, {
    headers: { "Content-Type": "application/x-git-upload-pack-result", "Cache-Control": "no-cache" },
  });
  if (!wants.length || (haves.length && !multiAck && !done)) return reply(["NAK\n"]);
  await opened.fs.detectLooseObjects(GITDIR);
  const reader = new GitObjectReader(opened), common = await commonObjects(reader, haves);
  if (haves.length && multiAck && !done) return reply([...common.map((oid) => `ACK ${oid} common\n`), "NAK\n"]);
  const have = await collectGitObjects(reader, common);
  const want = await collectGitObjects(reader, wants, { exclude: have });
  const selected = new Map<string, PackedGitEntry>(), pending = [...want];
  const thin = capabilities.has("thin-pack");
  for (let oid = pending.pop(); oid !== undefined; oid = pending.pop()) {
    if (selected.has(oid)) continue;
    const entry = await reader.packed(oid); selected.set(oid, entry);
    if (entry.base && (!thin || !have.has(entry.base))) pending.push(entry.base);
  }
  const pack = createGitPack([...selected].map(([oid, entry]) => ({ oid, entry })));
  if (pack.byteLength > MAX_GIT_REPOSITORY_BYTES * 2)
    return new Response("Git pack exceeds the serving limit", { status: 413 });
  return gitPackResponse(pack, pktLine(common.length ? `ACK ${common.at(-1)}\n` : "NAK\n"),
    capabilities.has("side-band-64k") ? 65515 : capabilities.has("side-band") ? 995 : null);
}

/** The caller must hold write scope; reserveHistory admits the push against account storage. */
export async function receiveGitPack(
  request: Request, bucket: GitObjectBucket, repoId: string,
  reserveHistory?: (maxAdditionalBytes: number) => Promise<boolean>,
): Promise<Response> {
  const body = await readBodyAtMost(request, MAX_GIT_PUSH_BYTES);
  let parsed: ReturnType<typeof parseReceivePackBody>;
  try { parsed = parseReceivePackBody(body); }
  catch (error) { if (error instanceof GitProtocolError) return new Response(error.message, { status: 400 }); throw error; }
  const repository = await openRepository(bucket, repoId);
  const { store, prefix, repo } = repository;
  // The Durable Object holds the single-writer queue from this comparison
  // through the ref writes. Stale retries must not store another pack.
  const refs = await readRefs(store, `${prefix}${GITDIR}/`);
  const updates: CheckedRefUpdate[] = parsed.refUpdates.map((update) => ({ ...update,
    error: (refs.get(update.refName) ?? ZERO_OID) !== update.oldOid ? "stale ref" : undefined,
  }));
  if (updates.every((update) => update.error)) return receivePackResponse(updates, parsed.capabilities);
  let additionalBytes: number;
  try { additionalBytes = incomingGitObjectBytes(parsed.packData); }
  catch {
    // Malformed pack metadata is a client protocol error, returned as HTTP 400.
    return new Response("Invalid Git pack header", { status: 400 });
  }
  if (parsed.packData.byteLength > 0 &&
      new DataView(parsed.packData.buffer, parsed.packData.byteOffset).getUint32(8) === 0) {
    // Native Git can send a checksum-bearing, zero-object pack for a ref-only
    // creation. Validate it, then avoid retaining a useless pack/index pair.
    if (parsed.packData.byteLength !== 32) return new Response("Invalid empty Git pack", { status: 400 });
    const checksum = new Uint8Array(await crypto.subtle.digest("SHA-1", Uint8Array.from(parsed.packData.subarray(0, 12))));
    if (!checksum.every((byte, index) => byte === parsed.packData[12 + index])) {
      return new Response("Invalid empty Git pack checksum", { status: 400 });
    }
    parsed.packData = new Uint8Array();
    additionalBytes = 0;
  }
  const looseRefs = await store.list(`${prefix}/repo.git/refs/`);
  const projectedRefs = new Set(looseRefs.objects.map((ref) => ref.key));
  for (const update of updates) {
    if (!update.error && update.newOid !== ZERO_OID) projectedRefs.add(`${prefix}/repo.git/${update.refName}`);
  }
  // Do not credit deletions until they succeed: a stale deletion must not
  // create room for new refs in the same request. Existing refs stay mutable.
  if (projectedRefs.size > looseRefs.objects.length && projectedRefs.size > MAX_GIT_REPOSITORY_REFS) {
    return new Response("Git repository ref count limit exceeded", { status: 413 });
  }
  const objects = await store.list(`${prefix}/repo.git/objects/`);
  const allObjects = await store.list(`${prefix}/repo.git/`);
  const storedBytes = allObjects.objects.reduce((size, object) => size + object.size, 0);
  additionalBytes += Math.max(0, projectedRefs.size - looseRefs.objects.length) * 41;
  if (parsed.packData.byteLength > 0 && objects.objects.length + 2 > MAX_GIT_REPOSITORY_OBJECTS) {
    return new Response("Git history object count limit exceeded", { status: 413 });
  }
  if (storedBytes + additionalBytes > MAX_GIT_REPOSITORY_BYTES) {
    return new Response("Git history quota exceeded; track media with Git LFS", { status: 413 });
  }
  try {
    if (parsed.packData.length && new DataView(parsed.packData.buffer, parsed.packData.byteOffset).getUint32(8) > MAX_GIT_REPOSITORY_OBJECTS)
      throw new GitPackLimitError("Git pack has too many objects");
    // Keep full connectivity checks without a missing-loose-object GET per stored object.
    const validationRepository = readGitRepository(bucket, repoId, { store, looseObjectHints: true });
    await validationRepository.fs.detectLooseObjects(GITDIR);
    const reader = new GitObjectReader(validationRepository);
    const incoming = await validateGitPack(parsed.packData, MAX_GIT_REPOSITORY_BYTES, reader);
    await validateRefUpdates(updates, refs, reader, incoming);
  } catch (error) {
    if (!(error instanceof GitPackValidationError)) throw error;
    return new Response(error instanceof GitPackLimitError ? error.message : "Invalid Git pack", {
      status: error instanceof GitPackLimitError ? 413 : 400,
    });
  }
  if (updates.every((update) => update.error)) return receivePackResponse(updates, parsed.capabilities);
  if (reserveHistory && !await reserveHistory(additionalBytes)) {
    return new Response("Account storage quota exceeded", { status: 413 });
  }
  if (parsed.packData.length) {
    // Preserve timestamped pack names for history collection, including pushes
    // in the same millisecond and clocks that move backwards.
    let time = Date.now();
    for (const { key } of objects.objects) {
      const previous = /\/(?:recv|pack)-(\d+)\.pack$/u.exec(key)?.[1];
      if (previous) time = Math.max(time, Number(previous) + 1);
    }
    const filepath = `objects/pack/recv-${time}.pack`, packKey = `${prefix}${GITDIR}/${filepath}`;
    try {
      await store.put(packKey, parsed.packData);
      const { oids } = await git.indexPack({ ...repo, dir: GITDIR, filepath });
      // indexPack silently skips objects it cannot resolve. Every validated
      // pack entry must be indexed before any ref can be published.
      const expected = new DataView(parsed.packData.buffer, parsed.packData.byteOffset).getUint32(8);
      if (oids.length !== expected) throw new Error("Git pack index is incomplete");
    } catch (error) {
      await store.delete(packKey.replace(/\.pack$/u, ".idx"));
      await store.delete(packKey);
      throw error;
    }
  }
  for (const { refName, newOid, error } of updates) {
    if (error) continue;
    if (newOid !== ZERO_OID) await repo.fs.promises.writeFile(`${GITDIR}/${refName}`, `${newOid}\n`);
    // deleteRef removes a packed ref and its peeled tag line as well as a loose ref.
    else await git.deleteRef({ ...repo, ref: refName });
  }
  return receivePackResponse(updates, parsed.capabilities);
}

/** Validate against incoming and stored objects before making either the pack or refs visible. */
async function validateRefUpdates(updates: CheckedRefUpdate[], refs: Map<string, string>, stored: GitObjectReader,
  incoming: Map<string, ValidatedGitObject>) {
  const reader = {
    info: async (oid: string) => incoming.get(oid) ?? stored.info(oid),
    read: async (oid: string) => incoming.get(oid)?.data ?? stored.read(oid),
  };
  const verified = new Set<string>();
  for (const update of updates) {
    const { refName, newOid } = update;
    if (update.error) continue;
    if (newOid !== ZERO_OID) {
      const target = await reader.info(newOid);
      if (!target || (refName.startsWith("refs/heads/") && target.type !== "commit")) {
        update.error = "invalid target object"; continue;
      }
      if ([...refs.keys()].some((name) => name !== refName && (name.startsWith(`${refName}/`) || refName.startsWith(`${name}/`)))) {
        update.error = "ref name conflict"; continue;
      }
      try {
        const reachable = await collectGitObjects(reader, [newOid], { exclude: verified });
        for (const oid of reachable) verified.add(oid);
      } catch (error) {
        if (!(error instanceof GitObjectGraphError)) throw error;
        update.error = "incomplete object graph"; continue;
      }
      refs.set(refName, newOid);
    } else refs.delete(refName);
  }
}
