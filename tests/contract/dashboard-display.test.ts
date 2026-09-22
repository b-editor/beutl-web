import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { getTranslation } from "@beutl/i18n";
import { formatTimestamp } from "../../apps/admin/src/lib/format";
import { getDashboardGreeting } from "../../apps/web/src/app/[lang]/(dashboard)/dashboard/greeting";

// Use the same React runtime as the app, not a second root-level dependency.
const appRequire = createRequire(new URL("../../apps/web/package.json", import.meta.url));
const { createElement } = appRequire("react");
const { renderToStaticMarkup } = appRequire("react-dom/server");

describe.each(["ja", "en"])("dashboard display text in %s", (lang) => {
  it("renders the usage report timestamp without HTML entities", async () => {
    const { t } = await getTranslation(lang);
    const timestamp = formatTimestamp(new Date("2026-09-15T05:54:00.000Z"), lang);
    const label = t("admin:ai.usage.since", { timestamp });

    expect(label).toBe(lang === "ja" ? `${timestamp} 以降` : `Since ${timestamp}`);
    expect(label).not.toContain("&#x2F;");
  });

  it.each(["OpenRouter", "Vercel AI Gateway"])("names %s in its model-page link", async (provider) => {
    const { t } = await getTranslation(lang);
    expect(t("admin:ai.models.openProvider", { provider })).toBe(
      lang === "ja" ? `${provider} で開く` : `Open on ${provider}`,
    );
  });

  it.each([null, undefined, "", "   ", "\t\n", "　"])("uses a name-free greeting for %j", async (name) => {
    const { t } = await getTranslation(lang);
    expect(getDashboardGreeting(t, name)).toBe(lang === "ja" ? "ようこそ" : "Welcome back");
  });

  it("trims a display name without showing escaped entity text", async () => {
    const { t } = await getTranslation(lang);
    expect(getDashboardGreeting(t, "  Alice & Bob <3  ")).toBe(
      lang === "ja" ? "ようこそ、Alice & Bob <3 さん" : "Welcome back, Alice & Bob <3",
    );
  });

  it("lets React escape names exactly once without changing global interpolation", async () => {
    const { t, i18n } = await getTranslation(lang);
    const name = '<img src=x onerror="alert(1)"> & Guest';
    const markup = renderToStaticMarkup(createElement("h1", null, getDashboardGreeting(t, name)));

    expect(markup).toContain("&lt;img");
    expect(markup).toContain("&amp; Guest");
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain("&amp;lt;");
    expect(i18n.options.interpolation?.escapeValue).toBe(true);
  });
});
