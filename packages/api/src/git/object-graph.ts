import { toHex } from "git-fs-s3";
import { GitObjectReader, type GitObjectType } from "./object-reader";

/** Edges live in commits, trees and tags; blob bodies never need reading to walk history. */
function* children(type: GitObjectType, bytes: Uint8Array): Generator<string> {
  if (type === "tree") {
    for (let position = 0; position < bytes.byteLength;) {
      const space = bytes.indexOf(32, position), nul = bytes.indexOf(0, position);
      if (space < position || nul <= space + 1 || nul + 21 > bytes.byteLength) throw new Error("Invalid Git tree");
      const mode = new TextDecoder().decode(bytes.subarray(position, space));
      if (!/^[0-7]+$/u.test(mode)) throw new Error("Invalid Git tree mode");
      // A gitlink's commit is in another repository.
      if (parseInt(mode, 8) !== 0o160000) yield toHex(bytes.subarray(nul + 1, nul + 21));
      position = nul + 21;
    }
    return;
  }
  const text = new TextDecoder().decode(bytes), end = text.indexOf("\n\n");
  if (end < 0) throw new Error(`Invalid Git ${type} header`);
  const header = text.slice(0, end).split("\n");
  if (type === "commit") {
    const tree = header.find((line) => line.startsWith("tree "))?.match(/^tree ([0-9a-f]{40})$/u)?.[1];
    if (!tree) throw new Error("Git commit has no tree");
    yield tree;
    for (const line of header) if (line.startsWith("parent ")) {
      const parent = /^parent ([0-9a-f]{40})$/u.exec(line)?.[1];
      if (!parent) throw new Error("Invalid Git commit parent");
      yield parent;
    }
  } else if (type === "tag") {
    const target = header.find((line) => line.startsWith("object "))?.match(/^object ([0-9a-f]{40})$/u)?.[1];
    if (!target) throw new Error("Git tag has no target");
    yield target;
  }
}

export async function collectGitObjects(
  reader: GitObjectReader, tips: Iterable<string>,
  { exclude = new Set<string>(), onBlob }: { exclude?: ReadonlySet<string>; onBlob?: (oid: string, size: number) => Promise<void> } = {},
): Promise<Set<string>> {
  const objects = new Set<string>(), pending = [...tips];
  for (let oid = pending.pop(); oid !== undefined; oid = pending.pop()) {
    if (objects.has(oid) || exclude.has(oid)) continue;
    const info = await reader.info(oid);
    if (!info) throw new Error(`Git object ${oid} is missing`);
    objects.add(oid);
    if (info.type === "blob") await onBlob?.(oid, info.size);
    else for (const child of children(info.type, await reader.read(oid))) pending.push(child);
  }
  return objects;
}
