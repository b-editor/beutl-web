import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const docsRoot = new URL(
  "../../apps/web/src/app/[lang]/(docs)/docs/",
  import.meta.url,
);

const pages = [
  {
    route: "terms",
    component: "EnglishTermsPage",
    englishTitle: "Terms of Service",
    japaneseTitle: "利用規約",
  },
  {
    route: "privacy",
    component: "EnglishPrivacyPage",
    englishTitle: "Privacy Policy",
    japaneseTitle: "プライバシーポリシー",
  },
  {
    route: "telemetry",
    component: "EnglishTelemetryPage",
    englishTitle: "Telemetry Policy",
    japaneseTitle: "テレメトリーポリシー",
  },
  {
    route: "specified-commercial-transactions-act",
    component: "EnglishCommercialTransactionsPage",
    englishTitle:
      "Disclosure under the Act on Specified Commercial Transactions",
    japaneseTitle: "特定商取引法に基づく表記",
  },
] as const;

describe("legal page localization", () => {
  it.each(pages)("server-selects English content for $route", ({
    route,
    component,
    englishTitle,
    japaneseTitle,
  }) => {
    const page = readFileSync(new URL(`${route}/page.tsx`, docsRoot), "utf8");
    const english = readFileSync(
      new URL(`${route}/english.tsx`, docsRoot),
      "utf8",
    );

    expect(page).toContain(`import { ${component} } from "./english"`);
    expect(page).toContain('if (lang === "en")');
    expect(page).toContain(`<${component}`);
    expect(page).toContain(`"${englishTitle} | Beutl"`);
    expect(page).toContain(japaneseTitle);
    expect(english).toContain(`export function ${component}`);
    expect(english).toContain(englishTitle);
    expect(english).not.toContain(japaneseTitle);
  });
});
