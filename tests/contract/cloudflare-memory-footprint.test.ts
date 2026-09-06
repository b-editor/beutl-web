import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function source(relativePath: string): string {
  return readFileSync(new URL(`../../${relativePath}`, import.meta.url), "utf8");
}

function packageJson(relativePath: string): {
  dependencies?: Record<string, string>;
  exports?: Record<string, string>;
  pnpm?: { overrides?: Record<string, string> };
} {
  return JSON.parse(source(relativePath));
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const child = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(child);
    return entry.isFile() && /\.[cm]?[jt]sx?$/u.test(entry.name) ? [child] : [];
  });
}

describe("Cloudflare Worker memory footprint", () => {
  it("keeps the OpenNext R2 registry independent from the API barrel", () => {
    const apiPackage = packageJson("packages/api/package.json");
    const prisma = source("apps/web/src/prisma.ts");
    const provider = source("packages/api/src/ai/r2-provider.ts");

    expect(apiPackage.exports?.["./ai/r2-provider"])
      .toBe("./src/ai/r2-provider.ts");
    expect(prisma).toContain(
      'import { setR2BucketProvider } from "@beutl/api/ai/r2-provider";',
    );
    expect(prisma).not.toMatch(/from "@beutl\/api"/u);
    expect(provider).not.toMatch(/^import\s/mu);
  });

  it("uses the Zod release with the lower-memory schema representation", () => {
    for (const path of [
      "apps/web/package.json",
      "packages/api/package.json",
      "packages/i18n/package.json",
    ]) {
      expect(packageJson(path).dependencies?.zod, path).toBe("^4.5.4");
    }
    expect(packageJson("package.json").pnpm?.overrides?.zod).toBe("4.5.4");
    expect(source("pnpm-lock.yaml")).not.toContain("zod@4.3.6");
  });

  it("keeps the server API barrel out of browser modules", () => {
    const webSource = new URL("../../apps/web/src", import.meta.url).pathname;
    const clientFiles = sourceFiles(webSource).filter((path) =>
      readFileSync(path, "utf8").startsWith('"use client";')
    );

    expect(clientFiles.length).toBeGreaterThan(0);
    for (const path of clientFiles) {
      expect(readFileSync(path, "utf8"), path).not.toMatch(
        /from "@beutl\/api"/u,
      );
    }
  });

  it("does not initialize video provider schemas for non-video entitlement reads", () => {
    const entitlements = source("packages/api/src/ai/entitlements.ts");

    expect(entitlements).not.toContain(
      'from "./video-model-capabilities"',
    );
    expect(entitlements).toContain(
      'import("./video-model-capabilities")',
    );
  });
});
