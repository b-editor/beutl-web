import { strToU8, Zip, ZipDeflate } from "fflate";
import { buildNuspec, sanitizePayloadPath, type NupkgOptions } from "./nupkg";

export type NupkgStreamFile = { path: string; stream(): ReadableStream<Uint8Array> };

/** Stream inputs and output one at a time. No archive or material ArrayBuffer is retained. */
export function createNupkgStream(metadata: Omit<NupkgOptions, "files">, files: readonly NupkgStreamFile[]): ReadableStream<Uint8Array> {
  const nuspec = strToU8(buildNuspec({ ...metadata, files: [] }));
  const inputs: NupkgStreamFile[] = [{
    path: `${metadata.id}.${metadata.version}.nuspec`,
    stream: () => new ReadableStream({ start(controller) { controller.enqueue(nuspec); controller.close(); } }),
  }, ...files.map((file) => ({ ...file, path: sanitizePayloadPath(file.path) }))];
  const names = new Set<string>();
  for (const input of inputs) {
    if (names.has(input.path)) throw new Error("Package entries share the same path");
    names.add(input.path);
  }
  const output: Uint8Array[] = [];
  let failure: Error | null = null, complete = false, next = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined, entry: ZipDeflate | undefined;
  let input: Uint8Array | undefined, offset = 0, cancelled = false;
  const zip = new Zip((error, data, final) => {
    if (error) { failure = error; return; }
    if (data.byteLength) output.push(data);
    complete = final;
  });
  return new ReadableStream({
    async pull(controller) {
      try {
        while (!output.length && !complete) {
          if (failure) throw failure;
          if (!reader) {
            if (next === inputs.length) { zip.end(); break; }
            const file = inputs[next++];
            entry = new ZipDeflate(file.path, { level: 6 });
            // All passes produce identical headers, including the archive's timestamp.
            entry.mtime = new Date("2000-01-01T00:00:00Z");
            zip.add(entry); reader = file.stream().getReader();
          }
          if (!input) {
            const chunk = await reader.read();
            if (cancelled) return;
            if (chunk.done) {
              entry!.push(new Uint8Array(), true); reader.releaseLock(); reader = undefined; continue;
            }
            input = chunk.value; offset = 0;
          }
          const end = Math.min(offset + 64 * 1024, input.byteLength);
          entry!.push(input.subarray(offset, end)); offset = end;
          if (offset === input.byteLength) input = undefined;
        }
        if (failure) throw failure;
        const data = output.shift();
        if (data) controller.enqueue(data); else if (complete) controller.close();
      } catch (error) {
        controller.error(error); zip.terminate(); await reader?.cancel().catch(() => undefined);
      }
    },
    async cancel() {
      cancelled = true; zip.terminate(); await reader?.cancel().catch(() => undefined);
      reader?.releaseLock(); output.length = 0; input = undefined;
    },
  }, { highWaterMark: 0 });
}
