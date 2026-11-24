import { Buffer } from "node:buffer";
import type { GitObjectInfo, GitObjectType } from "./object-reader";

export class GitObjectGraphError extends Error {}

type TreeEntry = { mode: number; name: Uint8Array; oid: string };
type PendingObject = string | { oid: string; previousTree: string };

function* treeEntries(bytes: Uint8Array): Generator<TreeEntry, void> {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let position = 0; position < bytes.byteLength;) {
    const space = bytes.indexOf(32, position), nul = bytes.indexOf(0, position);
    if (space < position || nul <= space + 1 || nul + 21 > bytes.byteLength) throw new GitObjectGraphError("Invalid Git tree");
    const text = buffer.toString("latin1", position, space);
    if (!/^[0-7]+$/u.test(text)) throw new GitObjectGraphError("Invalid Git tree mode");
    const mode = parseInt(text, 8);
    // A gitlink's commit is in another repository.
    if (mode !== 0o160000) yield { mode, name: bytes.subarray(space + 1, nul), oid: buffer.toString("hex", nul + 1, nul + 21) };
    position = nul + 21;
  }
}

function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const shared = Math.min(a.name.length, b.name.length);
  for (let i = 0; i < shared; i++) {
    const difference = a.name[i] - b.name[i];
    if (difference) return difference;
  }
  // Git sorts a directory as though its name ends in a slash.
  return (a.name[shared] ?? (a.mode === 0o40000 ? 47 : 0)) - (b.name[shared] ?? (b.mode === 0o40000 ? 47 : 0));
}

function* treeChildren(data: Uint8Array, previous?: Uint8Array): Generator<PendingObject> {
  const entries = previous && treeEntries(previous);
  let old = entries?.next().value;
  for (const child of treeEntries(data)) {
    while (old && compareTreeNames(old, child) < 0) old = entries!.next().value;
    if (old && old.name.length === child.name.length && compareTreeNames(old, child) === 0) {
      if (old.oid === child.oid) continue;
      if (old.mode === 0o40000 && child.mode === 0o40000) {
        yield { oid: child.oid, previousTree: old.oid };
        continue;
      }
    }
    yield child.oid;
  }
}

function* revisionChildren(type: Extract<GitObjectType, "commit" | "tag">, bytes: Uint8Array): Generator<string, void> {
  const text = new TextDecoder().decode(bytes), end = text.indexOf("\n\n");
  if (end < 0) throw new GitObjectGraphError(`Invalid Git ${type} header`);
  const header = text.slice(0, end).split("\n");
  if (type === "commit") {
    const tree = header.find((line) => line.startsWith("tree "))?.match(/^tree ([0-9a-f]{40})$/u)?.[1];
    if (!tree) throw new GitObjectGraphError("Git commit has no tree");
    yield tree;
    for (const line of header) if (line.startsWith("parent ")) {
      const parent = /^parent ([0-9a-f]{40})$/u.exec(line)?.[1];
      if (!parent) throw new GitObjectGraphError("Invalid Git commit parent");
      yield parent;
    }
  } else if (type === "tag") {
    const target = header.find((line) => line.startsWith("object "))?.match(/^object ([0-9a-f]{40})$/u)?.[1];
    if (!target) throw new GitObjectGraphError("Git tag has no target");
    yield target;
  }
}

export async function collectGitObjects(
  reader: { info(oid: string): Promise<GitObjectInfo | null>; read(oid: string): Promise<Uint8Array> }, tips: Iterable<string>,
  { exclude = new Set<string>(), onBlob, compareParentTrees = false }: {
    exclude?: ReadonlySet<string>; onBlob?: (oid: string, size: number) => Promise<void>; compareParentTrees?: boolean;
  } = {},
): Promise<Set<string>> {
  const objects = new Set<string>();
  const pending: PendingObject[] = [...tips];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const oid = typeof next === "string" ? next : next.oid;
    if (objects.has(oid) || exclude.has(oid)) continue;
    const info = await reader.info(oid);
    if (!info) throw new GitObjectGraphError(`Git object ${oid} is missing`);
    objects.add(oid);
    if (info.type === "blob") { await onBlob?.(oid, info.size); continue; }
    const data = await reader.read(oid);
    if (info.type === "tree") {
      const previousTree = typeof next === "string" ? undefined : next.previousTree;
      const previous = previousTree && (await reader.info(previousTree))?.type === "tree" ? await reader.read(previousTree) : undefined;
      for (const child of treeChildren(data, previous)) pending.push(child);
      continue;
    }
    const edges = revisionChildren(info.type, data);
    if (info.type === "commit" && compareParentTrees) {
      const tree = edges.next().value!;
      let parent: string | undefined;
      for (const child of edges) {
        if (exclude.has(child)) parent ??= child;
        else pending.push(child);
      }
      const previousTree = parent && (await reader.info(parent))?.type === "commit"
        ? revisionChildren("commit", await reader.read(parent)).next().value : undefined;
      if (tree !== previousTree) pending.push(previousTree ? { oid: tree, previousTree } : tree);
    } else {
      for (const child of edges) pending.push(child);
    }
  }
  return objects;
}
