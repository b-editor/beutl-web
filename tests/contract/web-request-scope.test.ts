import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(relativePath: string): string {
  return readFileSync(new URL(`../../${relativePath}`, import.meta.url), "utf8");
}

describe("web request-scoped database resources", () => {
  it("memoizes and releases the Web Prisma client at request boundaries", () => {
    const prisma = source("apps/web/src/prisma.ts");
    const worker = source("apps/web/worker.js");

    expect(prisma).toContain('import { cache } from "react";');
    expect(prisma).toContain(
      "const getPrismaClient = cache(createPrismaClient);",
    );
    expect(prisma).toContain("setDbProvider(getPrismaClient);");
    expect(prisma).toContain('import { after } from "next/server";');
    expect(prisma).toContain("after(() => prisma.$disconnect());");
    expect(prisma).toContain("if (!hasDbProviderScope())");
    expect(worker).toContain(
      'import { runWithConfiguredDbProviderResponseScope } from "@beutl/db/provider-scope";',
    );
    expect(worker).toContain("runWithConfiguredDbProviderResponseScope(");
    expect(prisma).not.toMatch(/(?:let|const)\s+prisma(?:Client|Promise)\s*=/i);
  });

  it("uses the same request-scoped ownership in the admin Worker", () => {
    const prisma = source("apps/admin/src/prisma.ts");
    const betterAuth = source("apps/admin/src/lib/better-auth.ts");
    const worker = source("apps/admin/worker.js");
    const wrangler = source("apps/admin/wrangler.jsonc");

    expect(prisma).toContain('import { cache } from "react";');
    expect(prisma).toContain(
      "const getPrismaClient = cache(createPrismaClient);",
    );
    expect(prisma).toContain("setDbProvider(getPrismaClient);");
    expect(prisma).toContain('import { after } from "next/server";');
    expect(prisma).toContain("after(() => prisma.$disconnect());");
    expect(prisma).toContain("if (!hasDbProviderScope())");
    expect(worker).toContain("runWithConfiguredDbProviderResponseScope(");
    expect(wrangler).toContain('"main": "worker.js"');
    expect(betterAuth).toContain('import { cache } from "react";');
    expect(betterAuth).toContain(
      "export const getAuth = cache(createAuthWithPrisma);",
    );
    expect(betterAuth).not.toMatch(/let\s+auth(?:Instance|Promise)\b/);
    expect(betterAuth).not.toContain("getAuthInstance");
  });

  it("memoizes Better Auth per request without a module-global instance", () => {
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
});
