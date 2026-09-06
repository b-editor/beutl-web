import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(relativePath: string): string {
  return readFileSync(new URL(`../../${relativePath}`, import.meta.url), "utf8");
}

describe("server-render database resources", () => {
  it("memoizes and releases the Web Prisma client in Server Component renders", () => {
    const prisma = source("apps/web/src/prisma.ts");

    expect(prisma).toContain('import { cache } from "react";');
    expect(prisma).toContain(
      "const getPrismaClient = cache(createPrismaClient);",
    );
    expect(prisma).toContain(
      "new PrismaPg({ connectionString, max: 5, maxUses: 1 })",
    );
    expect(prisma).toContain("setDbProvider(getPrismaClient);");
    expect(prisma).toContain('import { after } from "next/server";');
    expect(prisma).toContain("after(() => prisma.$disconnect());");
    expect(prisma).not.toMatch(/(?:let|const)\s+prisma(?:Client|Promise)\s*=/i);
  });

  it("memoizes and releases the Admin Prisma client in Server Component renders", () => {
    const prisma = source("apps/admin/src/prisma.ts");
    const betterAuth = source("apps/admin/src/lib/better-auth.ts");

    expect(prisma).toContain('import { cache } from "react";');
    expect(prisma).toContain(
      "const getPrismaClient = cache(createPrismaClient);",
    );
    expect(prisma).toContain("setDbProvider(getPrismaClient);");
    expect(prisma).toContain('import { after } from "next/server";');
    expect(prisma).toContain("after(() => prisma.$disconnect());");
    expect(betterAuth).toContain('import { cache } from "react";');
    expect(betterAuth).toContain(
      "export const getAuth = cache(createAuthWithPrisma);",
    );
    expect(betterAuth).not.toMatch(/let\s+auth(?:Instance|Promise)\b/);
    expect(betterAuth).not.toContain("getAuthInstance");
  });

  it("memoizes Better Auth per render without a module-global instance", () => {
    const betterAuth = source("apps/web/src/lib/better-auth.ts");

    expect(betterAuth).toContain('import { cache } from "react";');
    expect(betterAuth).toContain(
      "export const getAuth = cache(createAuthWithPrisma);",
    );
    expect(betterAuth).not.toMatch(/let\s+auth(?:Instance|Promise)\b/);
    expect(betterAuth).not.toContain("authInstance");
    expect(betterAuth).toContain("const instance = await getAuth();");
  });

  it("reuses the dashboard auth guard and one Prisma client on profile", () => {
    const profilePage = source(
      "apps/web/src/app/[lang]/(dashboard)/dashboard/account/profile/page.tsx",
    );

    expect(profilePage).toContain(
      'import { authOrSignIn } from "@/lib/auth-guard";',
    );
    expect(profilePage).toContain("const session = await authOrSignIn();");
    expect(profilePage.match(/await getDb\(\)/g)).toHaveLength(1);
    expect(profilePage).toContain(
      "getProfileByUserId(session.user.id, prisma)",
    );
    expect(profilePage).toContain(
      "getSocialProfilesByUserId(session.user.id, prisma)",
    );
    expect(profilePage).not.toContain("auth.api.getSession");
  });

  it("shares one render client with entitlement summaries", () => {
    for (const path of [
      "apps/web/src/app/[lang]/(dashboard)/dashboard/queries.ts",
      "apps/web/src/app/[lang]/(dashboard)/dashboard/account/billing/queries.ts",
    ]) {
      const query = source(path);
      expect(query.match(/await getDb\(\)/g), path).toHaveLength(1);
      expect(query, path).toContain(
        "getEntitlementSummary(userId, { prisma })",
      );
    }
  });

  it("shares video capability I/O only inside one Server Component render", () => {
    const videoPage = source(
      "apps/web/src/app/[lang]/(dashboard)/dashboard/ai/video/page.tsx",
    );
    const capabilities = source(
      "packages/api/src/ai/video-model-capabilities.ts",
    );

    expect(videoPage.match(/loadAiVideoModelCapabilities\(\)/g)).toHaveLength(1);
    expect(videoPage).toContain(
      "const capabilitiesPromise = loadAiVideoModelCapabilities();",
    );
    expect(videoPage).toContain("videoCapabilities: capabilitiesPromise");
    expect(capabilities).not.toMatch(
      /inflight.*Promise<Map<string, AiVideoModelCapabilities>>/,
    );
  });
});
