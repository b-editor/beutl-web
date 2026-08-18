import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUuid } from "@beutl/core";

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// crypto.randomUUID is exposed only in a secure context. A page served over
// plain HTTP — a dev server reached from another device, an older Safari — has
// crypto but not that method, and the AI forms generate an idempotency key on
// every mount: without a fallback the screen throws before it can be submitted.
describe("randomUuid", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the platform generator when there is one", () => {
    expect(randomUuid()).toMatch(UUID_V4);
  });

  it("still produces a v4 UUID where randomUUID is missing", () => {
    vi.stubGlobal("crypto", {
      getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto),
    });

    const values = new Set(Array.from({ length: 200 }, () => randomUuid()));

    for (const value of values) {
      expect(value).toMatch(UUID_V4);
    }
    // Two attempts that collided would be refused as a replay of each other, so
    // the fallback has to stay random rather than derived from the clock.
    expect(values.size).toBe(200);
  });
})
