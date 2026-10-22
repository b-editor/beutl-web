import { Buffer } from "node:buffer";

export class GitProtocolError extends Error {}
export const ZERO_OID = "0".repeat(40);
export const FLUSH = Buffer.from("0000");
const decoder = new TextDecoder("utf-8", { fatal: true });

export function pktLine(value: string | Uint8Array): Buffer<ArrayBuffer> {
  const bytes = typeof value === "string" ? Buffer.from(value) : value;
  if (bytes.byteLength + 4 > 65520) throw new GitProtocolError("Git packet is too long");
  return Buffer.concat([Buffer.from((bytes.byteLength + 4).toString(16).padStart(4, "0")), bytes]);
}
function packet(bytes: Uint8Array, offset: number): { line: string | null; next: number } {
  const header = Buffer.from(bytes.subarray(offset, offset + 4)).toString("utf8");
  if (!/^[0-9a-fA-F]{4}$/u.test(header)) throw new GitProtocolError("Invalid Git packet length");
  const length = parseInt(header, 16);
  if (length === 0) return { line: null, next: offset + 4 };
  if (length < 4 || length > 65520 || offset + length > bytes.byteLength)
    throw new GitProtocolError("Invalid Git packet length");
  try { return { line: decoder.decode(bytes.subarray(offset + 4, offset + length)), next: offset + length }; }
  catch { throw new GitProtocolError("Invalid Git packet text"); }
}
export function parsePktLines(bytes: Uint8Array): (string | null)[] {
  const lines: (string | null)[] = [];
  for (let offset = 0; offset < bytes.length;) {
    const parsed = packet(bytes, offset); lines.push(parsed.line); offset = parsed.next;
  }
  return lines;
}

// git-check-ref-format rules, restricted to fully qualified refs before any storage access.
export function isGitRefName(ref: string): boolean {
  return ref.startsWith("refs/") && !ref.endsWith(".") &&
    !/[\x00-\x20\x7f~^:?*\[\\]/u.test(ref) && !ref.includes("..") && !ref.includes("@{") &&
    ref.split("/").every((part) => part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock"));
}
export type RefUpdate = { oldOid: string; newOid: string; refName: string };
export function parseReceivePackBody(bytes: Uint8Array) {
  const refUpdates: RefUpdate[] = [], capabilities = new Set<string>(), refs = new Set<string>();
  for (let offset = 0; offset < bytes.length;) {
    const { line, next } = packet(bytes, offset); offset = next;
    if (line === null) return { refUpdates, capabilities, packData: bytes.subarray(offset) };
    const [command, caps, ...extra] = line.replace(/\n$/u, "").split("\0");
    if (extra.length || (caps !== undefined && refUpdates.length)) throw new GitProtocolError("Invalid Git capabilities");
    for (const cap of caps?.split(" ") ?? []) if (cap) capabilities.add(cap);
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) ([\s\S]+)$/u.exec(command);
    if (!match || !isGitRefName(match[3]) || refs.has(match[3])) throw new GitProtocolError("Invalid Git ref update");
    if (capabilities.has("atomic") || capabilities.has("push-options")) throw new GitProtocolError("Unsupported Git capability");
    refs.add(match[3]); refUpdates.push({ oldOid: match[1], newOid: match[2], refName: match[3] });
  }
  throw new GitProtocolError("Missing Git command flush");
}

export function receivePackResponse(results: { refName: string; error?: string }[], capabilities: Set<string>): Response {
  let body = capabilities.has("report-status")
    ? Buffer.concat([pktLine("unpack ok\n"), ...results.map(({ refName, error }) =>
      pktLine(error ? `ng ${refName} ${error}\n` : `ok ${refName}\n`)), FLUSH]) : Buffer.alloc(0);
  if (capabilities.has("side-band-64k")) {
    const chunks = [];
    for (let offset = 0; offset < body.length; offset += 65515)
      chunks.push(pktLine(Buffer.concat([Buffer.from([1]), body.subarray(offset, offset + 65515)])));
    body = Buffer.concat([...chunks, FLUSH]);
  }
  return new Response(body, { headers: { "Content-Type": "application/x-git-receive-pack-result", "Cache-Control": "no-cache" } });
}
