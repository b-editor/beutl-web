import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

// The allowance and cost helpers live in @beutl/core so the admin console can
// use them, which also puts them within reach of the user-facing web app and
// its client bundle. Per-operation economics are deliberately withheld from
// users — exposing them would let anyone derive the margin on each operation —
// so this keeps the boundary from eroding by accident.
const ADMIN_ONLY_SYMBOLS = [
  "ai-allowance",
  "describeAllowanceEquivalent",
  "describeAllowanceEquivalents",
  "derivePlanUnitValue",
  "deriveTopUpUnitValue",
  "operationAmount",
  "formatFractionalAmount",
  "loadAiCostEstimates",
  "estimateImageCost",
  "estimateVideoCost",
  "estimateTranslationCost",
  "estimateTranscriptionCost",
];

const webSourceUrl = new URL("../../apps/web/src/", import.meta.url);

async function listSourceFiles(directory: URL): Promise<URL[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const child = new URL(
        entry.isDirectory() ? `${entry.name}/` : entry.name,
        directory,
      );
      if (entry.isDirectory()) {
        return await listSourceFiles(child);
      }
      return /\.(ts|tsx)$/.test(entry.name) ? [child] : [];
    }),
  );
  return files.flat();
}

describe("admin-only economics helpers", () => {
  it("are not referenced by the user-facing web app", async () => {
    const files = await listSourceFiles(webSourceUrl);
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      for (const symbol of ADMIN_ONLY_SYMBOLS) {
        if (source.includes(symbol)) {
          offenders.push(`${file.pathname} references ${symbol}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
