import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL(
    "../../apps/admin/src/app/[lang]/admin/ai/queries.ts",
    import.meta.url,
  ),
  "utf8",
);

describe("admin AI queries", () => {
  it("requires transparent output when checking remove-background models", () => {
    const start = source.indexOf("export const getUnusableImageModels");
    const end = source.indexOf("export const getAiModelCatalog", start);
    const query = source.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(query).toContain(
      'background: operation === "image.edit.remove_background"',
    );
    expect(query).toContain('? "transparent"');
  });
});
