import { describe, expect, it } from "vitest";
import {
  isUploadLimitExceeded,
  parseBodyWithUploadLimit,
  parseJsonWithBodyLimit,
} from "../../packages/api/src/ai/upload-limits";

function streamOf(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      // One byte at a time, so a body that runs past the cap is refused part
      // way through rather than only after the whole thing has arrived.
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    },
  });
}

// Not an instance of this runtime's Request, which is the shape the server
// actually receives: Next carries its own copy of the fetch implementation, so
// the request handed to a route belongs to that copy's class rather than to
// the global one.
class ForeignRequest {
  readonly url: string;
  readonly method = "POST";
  readonly headers: Headers;
  readonly signal = new AbortController().signal;
  readonly body: ReadableStream<Uint8Array>;

  constructor(url: string, body: string, contentType = "application/json") {
    this.url = url;
    this.headers = new Headers({ "content-type": contentType });
    this.body = streamOf(body);
  }

  async json(): Promise<unknown> {
    throw new Error("The foreign request must not be the one that is read");
  }
}

// The shape Hono hands a route: a request object that can be replaced, and a
// reader that goes through whatever is there at the time.
function honoRequestOf(raw: unknown) {
  const holder = {
    raw: raw as Request,
    json: <T>(): Promise<T> => (holder.raw as Request).json() as Promise<T>,
    parseBody: async () =>
      Object.fromEntries((await (holder.raw as Request).formData()).entries()),
  };
  return holder;
}

describe("reading a request body under a cap", () => {
  it("reads a request that came from another fetch implementation", async () => {
    // Rebuilding the incoming request by copying it reads its private state,
    // which a request from another implementation does not have: every AI
    // request from the editor came back as an invalid body, and only once the
    // body was read, so the cause was nowhere near the error.
    const request = honoRequestOf(
      new ForeignRequest("http://localhost/api/v3/user/ai-availability", '{"operation":"image.generate"}'),
    );

    await expect(parseJsonWithBodyLimit(request, 1024)).resolves.toEqual({
      operation: "image.generate",
    });
  });

  it("keeps what the request was, not only what it carried", async () => {
    const request = honoRequestOf(
      new ForeignRequest("http://localhost/api/v3/user/ai-availability", "{}"),
    );

    await parseJsonWithBodyLimit(request, 1024);

    expect(request.raw.method).toBe("POST");
    expect(request.raw.url).toBe("http://localhost/api/v3/user/ai-availability");
    expect(request.raw.headers.get("content-type")).toBe("application/json");
  });

  it("reads an upload that came from another fetch implementation", async () => {
    // The same reconstruction carries the audio a transcription is made of, so
    // this is the path the editor's uploads take.
    const boundary = "----BeutlBoundary";
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="chunk.wav"',
      "Content-Type: audio/wav",
      "",
      "RIFFDATA",
      `--${boundary}--`,
      "",
    ].join("\r\n");
    const request = honoRequestOf(
      new ForeignRequest(
        "http://localhost/api/v3/ai/transcriptions",
        body,
        `multipart/form-data; boundary=${boundary}`,
      ),
    );

    const parsed = await parseBodyWithUploadLimit(request, 1024);
    const file = parsed["file"];
    expect(file).toBeInstanceOf(File);
    expect((file as File).name).toBe("chunk.wav");
  });

  it("refuses a body that runs past the cap", async () => {
    const request = honoRequestOf(
      new ForeignRequest("http://localhost/api", `{"prompt":"${"a".repeat(64)}"}`),
    );

    const error = await parseJsonWithBodyLimit(request, 16).catch(
      (reason: unknown) => reason,
    );
    expect(isUploadLimitExceeded(error)).toBe(true);
  });

  it("refuses a body whose declared length is already past the cap", async () => {
    const oversized = new Request("http://localhost/api", {
      method: "POST",
      headers: { "content-length": "4096", "content-type": "application/json" },
      body: "{}",
    });

    const error = await parseJsonWithBodyLimit(honoRequestOf(oversized), 16).catch(
      (reason: unknown) => reason,
    );
    expect(isUploadLimitExceeded(error)).toBe(true);
  });
});
