import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function workerConfig(relativePath: string): string {
  return readFileSync(new URL(`../../${relativePath}`, import.meta.url), "utf8");
}

describe("Cloudflare request cancellation", () => {
  it.each([
    "apps/web/wrangler.jsonc",
    "packages/api/wrangler.jsonc",
  ])("enables client disconnect signals in %s", (path) => {
    expect(workerConfig(path)).toContain('"enable_request_signal"');
  });
});
