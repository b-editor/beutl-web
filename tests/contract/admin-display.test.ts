import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { getTranslation } from "@beutl/i18n";
import { createElement } from "../../apps/admin/node_modules/react";
import { renderToStaticMarkup } from "../../apps/admin/node_modules/react-dom/server";
import { formatTimestamp } from "../../apps/admin/src/lib/format";
import { RAW } from "../../apps/admin/src/lib/i18n";

// React escapes text and attribute values when it renders them. If i18next
// escapes the interpolated value as well, the operator sees entities such as
// "2026&#x2F;09&#x2F;28" or "a&amp;b.png" instead of the value.
describe.each(["ja", "en"])("admin display text in %s", (lang) => {
  it("renders a revoked session's date without HTML entities", async () => {
    const { t } = await getTranslation(lang);
    const date = formatTimestamp(new Date("2026-09-28T08:56:00.000Z"), lang);
    const markup = renderToStaticMarkup(
      createElement("span", null, t("admin:users.security.revokedAt", { date, ...RAW })),
    );

    expect(date).toContain("/");
    expect(markup).toContain(date);
    expect(markup).not.toContain("&#x2F;");
  });

  it("lets React escape a file name exactly once", async () => {
    const { t } = await getTranslation(lang);
    const name = `<b>Tom's "a&b"</b>/clip.mp4`;
    const markup = renderToStaticMarkup(
      createElement("p", null, t("admin:storage.messages.missing", { name, ...RAW })),
    );

    expect(markup).toContain("&lt;b&gt;Tom&#x27;s &quot;a&amp;b&quot;&lt;/b&gt;/clip.mp4");
    expect(markup).not.toContain("<b>");
    expect(markup).not.toMatch(/&amp;(amp|lt|gt|quot|#39|#x2F);/);
  });

  it("lets React escape an attribute value exactly once", async () => {
    const { t } = await getTranslation(lang);
    const markup = renderToStaticMarkup(
      createElement("button", {
        "aria-label": t("admin:common.helpFor", { name: "Storage & AI / R2", ...RAW }),
      }),
    );

    expect(markup).toContain("Storage &amp; AI / R2");
    expect(markup).not.toMatch(/&amp;(amp|#x2F);/);
  });

  it("keeps escaping on for calls that do not opt out", async () => {
    const { t, i18n } = await getTranslation(lang);
    const date = formatTimestamp(new Date("2026-09-28T08:56:00.000Z"), lang);

    expect(t("admin:users.security.revokedAt", { date })).toContain("&#x2F;");
    expect(i18n.options.interpolation?.escapeValue).toBe(true);
  });
});

// Each of these renders operator- or user-supplied text (dates, file names,
// error messages, JSON) as React text or attributes.
const rawCallSites: [file: string, key: string][] = [
  ["app/[lang]/admin/users/[id]/security.tsx", "admin:users.security.revokedAt"],
  ["app/[lang]/admin/storage/actions.ts", "admin:storage.messages.moved"],
  ["app/[lang]/admin/storage/actions.ts", "admin:storage.messages.alreadyThere"],
  ["app/[lang]/admin/storage/actions.ts", "admin:storage.messages.missing"],
  ["app/[lang]/admin/storage/page.tsx", "admin:storage.location.unknown"],
  ["app/[lang]/admin/storage/page.tsx", "admin:storage.stores.configError"],
  ["app/[lang]/admin/storage/migration/page.tsx", "admin:storage.stores.configError"],
  ["app/[lang]/admin/ai/actions.ts", "admin:ai.interventions.messages.unsafe"],
  ["app/[lang]/admin/ai/actions.ts", "admin:ai.interventions.messages.stripeVerificationFailed"],
  ["app/[lang]/admin/ai/topup-resolution-interventions.tsx", "admin:ai.interventions.topUp.expectedPaymentIntents"],
  ["components/admin/help-popover.tsx", "admin:common.helpFor"],
];

describe("admin call sites that interpolate free-form text", () => {
  it.each(rawCallSites)("%s passes RAW with %s", async (file, key) => {
    const source = await readFile(new URL(`../../apps/admin/src/${file}`, import.meta.url), "utf8");
    // From the key to the end of its options object, for every use of the key.
    const options = [...source.matchAll(new RegExp(`"${key.replaceAll(".", "\\.")}"[^}]*`, "g"))];

    expect(options.length).toBeGreaterThan(0);
    for (const [text] of options) {
      expect(text).toContain("...RAW");
    }
  });
});
