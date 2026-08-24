import { describe, expect, it } from "vitest";
import {
  boundedBody,
  MAX_AI_IMAGE_UPLOAD_BYTES,
  MAX_REQUEST_BODY_BYTES,
  requestBodyLimit,
} from "@beutl/core";

async function drain(stream: ReadableStream<Uint8Array>): Promise<number> {
  const reader = stream.getReader();
  let seen = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) return seen;
    seen += next.value.byteLength;
  }
}

function streamOf(chunks: number[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const size of chunks) controller.enqueue(new Uint8Array(size));
      controller.close();
    },
  });
}

describe("what one request body may come to", () => {
  it("gives an AI screen its own files' worth and everything else the whole", () => {
    expect(requestBodyLimit("/ja/dashboard/ai/edit")).toBeGreaterThan(
      MAX_AI_IMAGE_UPLOAD_BYTES,
    );
    expect(requestBodyLimit("/ja/dashboard/ai/edit")).toBeLessThan(
      MAX_REQUEST_BODY_BYTES,
    );
    // パッケージの送信はここを通る。縮めると送れなくなる。
    expect(requestBodyLimit("/ja/dashboard/developer/projects/beutl/release"))
      .toBe(MAX_REQUEST_BODY_BYTES);
    // Server Action は URL では選ばれないので、AI の Action はここへも送れる
    // ——そちらは全体の上限で受ける。
    expect(requestBodyLimit("/ja/dashboard")).toBe(MAX_REQUEST_BODY_BYTES);
  });
});

describe("counting a body that does not say how long it is", () => {
  it("passes a body that stays inside the limit", async () => {
    await expect(drain(boundedBody(streamOf([100, 100, 100]), 1024)))
      .resolves.toBe(300);
  });

  it("cuts a body that runs past it", async () => {
    // 名乗った長さは信じない——名乗らずに送ることも、名乗った以上に送ることも
    // できる。抱えたまま増え続けるより、切るほうがいい。
    await expect(drain(boundedBody(streamOf([600, 600]), 1000)))
      .rejects.toThrow(/exceeds the configured limit/);
  });

  it("cuts on the chunk that crosses the line, not after the whole body", async () => {
    let produced = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        produced += 256;
        controller.enqueue(new Uint8Array(256));
      },
    });

    await expect(drain(boundedBody(endless, 1024))).rejects.toThrow();
    expect(produced).toBeLessThan(2048);
  });
});
