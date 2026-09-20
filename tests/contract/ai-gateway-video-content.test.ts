import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { downloadGatewayVideoContent } from "../../packages/api/src/ai/providers/vercel-gateway/video";
import { InvalidAiProviderOutputError } from "../../packages/api/src/ai/providers/errors";
import type { AiVideoJobInfo } from "../../packages/api/src/ai/providers/types";

const inspectVideo = vi.hoisted(() => vi.fn());
// A small cap exercises the allocation boundary without allocating production-
// sized videos in the test runner. Container parsing has its own test suite.
vi.mock("../../packages/api/src/ai/video-validation", async (original) => ({
  ...(await original<typeof import("../../packages/api/src/ai/video-validation")>()),
  MAX_AI_GENERATED_VIDEO_BYTES: 8,
  inspectGeneratedVideo: inspectVideo,
}));

const job = (type: "base64" | "binary", data: string | Uint8Array): AiVideoJobInfo => ({
  id: "gateway-job",
  status: "completed",
  error: null,
  result: { videos: [{ type, data, mediaType: "video/mp4" }] },
});

describe("inline Gateway video allocation limits", () => {
  beforeEach(() => {
    inspectVideo.mockReset().mockReturnValue({
      mimeType: "video/mp4",
      extension: "mp4",
      durationSeconds: 2,
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([12, 16])("rejects an oversized %s-character base64 result before decoding", async (length) => {
    // Eight and nine decoded bytes both fit in twelve base64 characters:
    // checking the encoded ceiling alone misses the one-byte overflow.
    const decode = vi.spyOn(globalThis, "atob");
    const error = await downloadGatewayVideoContent(job("base64", "A".repeat(length)))
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(InvalidAiProviderOutputError);
    expect(error).toMatchObject({ execution: "definite_failure" });
    expect(decode).not.toHaveBeenCalled();
    expect(inspectVideo).not.toHaveBeenCalled();
  });

  it("rejects an oversized binary result before copying", async () => {
    const input = new Uint8Array(9);
    const copy = vi.spyOn(input, "slice");
    const error = await downloadGatewayVideoContent(job("binary", input))
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(InvalidAiProviderOutputError);
    expect(error).toMatchObject({ execution: "definite_failure" });
    expect(copy).not.toHaveBeenCalled();
    expect(inspectVideo).not.toHaveBeenCalled();
  });

  it("accepts padded base64 exactly at the decoded limit", async () => {
    const result = await downloadGatewayVideoContent(job("base64", "AAAAAAAAAAA="));

    expect(result.bytes.byteLength).toBe(8);
    expect(inspectVideo).toHaveBeenCalledWith(result.bytes, "video/mp4");
  });

  it("copies only a bounded binary view, even with a larger backing buffer", async () => {
    const buffer = new Uint8Array(16).fill(7);
    const result = await downloadGatewayVideoContent(job("binary", buffer.subarray(4, 12)));
    buffer.fill(0);

    expect(result.bytes.byteLength).toBe(8);
    expect([...new Uint8Array(result.bytes)]).toEqual(Array(8).fill(7));
    expect(inspectVideo).toHaveBeenCalledWith(result.bytes, "video/mp4");
  });

  it("classifies malformed base64 as invalid provider output", async () => {
    const error = await downloadGatewayVideoContent(job("base64", "!!!!"))
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(InvalidAiProviderOutputError);
    expect(error).toMatchObject({ execution: "definite_failure" });
    expect(inspectVideo).not.toHaveBeenCalled();
  });
});
