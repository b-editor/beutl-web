import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { unzipSync } from "fflate";
import { blobStream, createNupkgStream } from "@beutl/core";
import { buildDataPackageNupkgFile } from "@/lib/data-package";

const metadata = { id: "Test.Materials", version: "1.0.0", title: "Test", description: "Test materials", authors: "Test", tags: [] };
const input = (bytes: Uint8Array) => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } });
const read = async (body: ReadableStream<Uint8Array>) => new Uint8Array(await new Response(body).arrayBuffer());

describe("streamed NuGet packages", () => {
  it("slices blobs before reading them and bounds even a runtime with whole-blob stream chunks", async () => {
    const blob = new Blob([new Uint8Array(256 * 1024)]);
    vi.spyOn(blob, "stream").mockImplementation(() => { throw new Error("Do not use unbounded Blob.stream"); });
    const reader = blobStream(blob).getReader();
    const sizes: number[] = [];
    for (;;) { const next = await reader.read(); if (next.done) break; sizes.push(next.value.byteLength); }
    expect(sizes).toEqual([65536, 65536, 65536, 65536]);
  });
  it("produces a valid archive and identical bytes across passes", async () => {
    const bytes = new TextEncoder().encode("material"), files = [{ path: "materials/a.bin", stream: () => input(bytes) }];
    const first = await read(createNupkgStream(metadata, files)), second = await read(createNupkgStream(metadata, files));
    expect(second).toEqual(first);
    const archive = unzipSync(first);
    expect(archive["materials/a.bin"]).toEqual(bytes);
    expect(new TextDecoder().decode(archive["Test.Materials.1.0.0.nuspec"])).toContain("<id>Test.Materials</id>");
  });

  it("does not read materials until requested and stops reading on cancellation", async () => {
    const produce = vi.fn(() => input(new Uint8Array(1024 * 1024)));
    const reader = createNupkgStream(metadata, [{ path: "materials/a.bin", stream: produce }]).getReader();
    await reader.read(); await reader.cancel();
    expect(produce).not.toHaveBeenCalled();
  });

  it("builds materials without arrayBuffer and carries the exact size and checksum", async () => {
    const bytes = new TextEncoder().encode("material"), file = new File([bytes], "a.png");
    vi.spyOn(file, "arrayBuffer").mockRejectedValue(new Error("Do not buffer materials"));
    const built = await buildDataPackageNupkgFile({
      files: [file], ...metadata, username: metadata.authors, t: ((key: string) => key) as never,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error(built.message);
    const archive = await read(built.file.stream());
    expect(unzipSync(archive)["materials/a.png"]).toEqual(bytes);
    expect(built.file.size).toBe(archive.byteLength);
    expect(built.file.sha256).toBe(createHash("sha256").update(archive).digest("hex"));
  });

  it("reports invalid NuGet metadata as an input error", async () => {
    await expect(buildDataPackageNupkgFile({
      files: [new File(["material"], "a.png")], ...metadata, id: "invalid/id",
      username: metadata.authors, t: ((key: string) => key) as never,
    })).resolves.toEqual({ ok: false, message: "developer:upload.invalidFileName" });
  });

  it("propagates material read failures instead of reporting invalid file names", async () => {
    const failure = new Error("Material source could not be read"), file = new File(["material"], "a.png");
    vi.spyOn(file, "slice").mockImplementation(() => { throw failure; });
    await expect(buildDataPackageNupkgFile({
      files: [file], ...metadata, username: metadata.authors, t: ((key: string) => key) as never,
    })).rejects.toBe(failure);
  });
});
