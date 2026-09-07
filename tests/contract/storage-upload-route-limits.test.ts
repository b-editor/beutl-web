import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  STORAGE_MAX_FILE_BYTES,
  STORAGE_MULTIPART_MAX_PARTS,
} from "@beutl/core";

const routes = new URL(
  "../../apps/web/src/app/api/internal/storage/uploads/",
  import.meta.url,
);

// The routes decide before the transaction what could never be stored. Those
// limits must be the bucket's, not the free tier's, or a paid account is cut
// down to 1 GiB before its plan is even consulted.
describe("storage upload route limits", () => {
  it("rejects a start only when the bucket could not assemble the file", () => {
    const source = readFileSync(new URL("route.ts", routes), "utf8");
    expect(source).toContain("size > STORAGE_MAX_FILE_BYTES");
    expect(source).not.toContain("STORAGE_FREE_QUOTA_BYTES");
    expect(STORAGE_MAX_FILE_BYTES).toBeGreaterThan(1024 * 1024 * 1024);
  });

  it("accepts as many parts as the bucket allows and a body that can list them", () => {
    const source = readFileSync(new URL("[id]/route.ts", routes), "utf8");
    expect(source).toContain("const MAX_PART_COUNT = STORAGE_MULTIPART_MAX_PARTS;");
    expect(source).toContain(
      "const MAX_CONTROL_BODY_BYTES = MAX_PART_COUNT * (MAX_ETAG_LENGTH + 64);",
    );
    expect(source).not.toContain("STORAGE_FREE_QUOTA_BYTES");
    // 10,000 entries of `{"partNumber":10000,"etag":"<256 chars>"},` fit.
    const perEntry = 256 + 64;
    expect(STORAGE_MULTIPART_MAX_PARTS * perEntry).toBeGreaterThan(
      STORAGE_MULTIPART_MAX_PARTS * (256 + 40),
    );
  });
});
