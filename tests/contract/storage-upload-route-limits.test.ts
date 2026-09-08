import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MAX_INTERNAL_STORAGE_FINISH_BODY_BYTES,
  requestBodyLimit,
  STORAGE_MAX_FILE_BYTES,
  STORAGE_MULTIPART_MAX_PARTS,
  STORAGE_UPLOAD_ETAG_MAX_LENGTH,
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
      "const MAX_CONTROL_BODY_BYTES = MAX_INTERNAL_STORAGE_FINISH_BODY_BYTES;",
    );
    expect(source).not.toContain("STORAGE_FREE_QUOTA_BYTES");
    // A completion listing every part the bucket allows, each with the
    // longest etag the route accepts, fits in the body limit.
    const largest = JSON.stringify({
      parts: Array.from({ length: STORAGE_MULTIPART_MAX_PARTS }, (_, index) => ({
        partNumber: index + 1,
        etag: "e".repeat(STORAGE_UPLOAD_ETAG_MAX_LENGTH),
      })),
    });
    expect(Buffer.byteLength(largest)).toBeLessThanOrEqual(
      MAX_INTERNAL_STORAGE_FINISH_BODY_BYTES,
    );
  });

  it("lets the Worker's outer body guard pass what the finish route can read", () => {
    // The OpenNext wrapper caps the body before the route runs. If its cap
    // were the old 64 KiB, a completion with enough parts would get a 413
    // there and never reach the route that could accept it.
    expect(requestBodyLimit("/api/internal/storage/uploads/upload-1", "POST")).toBe(
      MAX_INTERNAL_STORAGE_FINISH_BODY_BYTES,
    );
    expect(MAX_INTERNAL_STORAGE_FINISH_BODY_BYTES).toBe(
      STORAGE_MULTIPART_MAX_PARTS * (STORAGE_UPLOAD_ETAG_MAX_LENGTH + 64),
    );
  });
});
