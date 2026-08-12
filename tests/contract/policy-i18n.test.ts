import { describe, expect, it } from "vitest";
import enPrivacy from "../../packages/i18n/src/locales/en/privacy.json";
import enTelemetry from "../../packages/i18n/src/locales/en/telemetry.json";
import jaPrivacy from "../../packages/i18n/src/locales/ja/privacy.json";
import jaTelemetry from "../../packages/i18n/src/locales/ja/telemetry.json";
import { navHref } from "../../apps/web/src/components/site-links";

function leafKeys(value: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(value)
    .flatMap(([key, child]) => {
      const path = prefix ? `${prefix}.${key}` : key;
      return typeof child === "object" && child !== null
        ? leafKeys(child as Record<string, unknown>, path)
        : [path];
    })
    .toSorted();
}

describe("localized policy contract", () => {
  it("keeps English and Japanese telemetry/privacy keys in parity", () => {
    expect(leafKeys(enTelemetry)).toEqual(leafKeys(jaTelemetry));
    expect(leafKeys(enPrivacy)).toEqual(leafKeys(jaPrivacy));
  });

  it("uses canonical localized telemetry and privacy routes", () => {
    expect(navHref("telemetry", "en")).toBe("/en/docs/telemetry");
    expect(navHref("privacy", "ja")).toBe("/ja/docs/privacy");
  });

  it("keeps local log details out of separately consented diagnostics", () => {
    expect(enTelemetry.notCollected.diagnostics).toContain(
      "always remain in local files",
    );
    expect(enTelemetry.notCollected.diagnostics).toContain(
      "fixed allowlisted attributes",
    );
    expect(enPrivacy.notCollected.body).toContain("always remain in local files");
    expect(enPrivacy.notCollected.body).toContain("fixed allowlisted attributes");

    expect(jaTelemetry.notCollected.diagnostics).toContain(
      "常にローカルファイルだけ",
    );
    expect(jaTelemetry.notCollected.diagnostics).toContain("固定allowlist");
    expect(jaPrivacy.notCollected.body).toContain("常にローカルファイルだけ");
    expect(jaPrivacy.notCollected.body).toContain("固定allowlist");
  });

  it("documents the trusted extension ID and generic privacy boundary in both languages", () => {
    const extensionId =
      "extension/<public-marketplace-package-id>/<kind>/<key>";

    for (const policy of [
      enTelemetry.marketplace.body,
      enPrivacy.marketplace.body,
    ]) {
      expect(policy).toContain(extensionId);
      expect(policy).toContain("public Marketplace package ID");
      expect(policy.toLowerCase()).toContain("sideloaded");
      expect(policy.toLowerCase()).toContain("local");
      expect(policy.toLowerCase()).toContain("legacy");
      expect(policy.toLowerCase()).toContain("unverified");
      expect(policy).toContain("generic");
      expect(policy).toContain("no package ID or CLR type name is sent");
    }

    for (const policy of [
      jaTelemetry.marketplace.body,
      jaPrivacy.marketplace.body,
    ]) {
      expect(policy).toContain(extensionId);
      expect(policy).toContain("公開Marketplace package ID");
      expect(policy).toContain("サイドロード");
      expect(policy).toContain("ローカル");
      expect(policy).toContain("legacy");
      expect(policy).toContain("未検証");
      expect(policy).toContain("generic");
      expect(policy).toContain("package ID または CLR 型名は送信しません");
    }
  });
});
