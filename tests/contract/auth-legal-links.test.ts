import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const webSource = new URL("../../apps/web/src/", import.meta.url);

function source(path: string): string {
  return readFileSync(new URL(path, webSource), "utf8");
}

describe("authentication legal links", () => {
  it("renders translated legal copy on the server", () => {
    const legalLinks = source("components/auth/legal-links.tsx");

    expect(legalLinks).not.toContain('"use client"');
    expect(legalLinks).not.toContain("@beutl/ui/i18n-client");
    expect(legalLinks).toContain('import { getTranslation } from "@beutl/i18n"');
    expect(legalLinks).toContain("await getTranslation(lang)");
  });

  it.each(["sign-in", "sign-up"])(
    "passes the server-rendered copy through the %s form slot",
    (flow) => {
      const form = source(`app/[lang]/(auth-flow)/account/${flow}/form.tsx`);
      const page = source(`app/[lang]/(auth-flow)/account/${flow}/page.tsx`);

      expect(form).not.toContain("@/components/auth/legal-links");
      expect(form).toContain("legalLinks: React.ReactNode");
      expect(form).toContain("{legalLinks}");
      expect(page).toContain('import { AuthLegalLinks } from "@/components/auth/legal-links"');
      expect(page).toContain("<AuthLegalLinks");
    },
  );
});
