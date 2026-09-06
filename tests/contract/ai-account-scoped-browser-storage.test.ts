import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { accountScopedAiStorageKey } from "../../apps/web/src/lib/ai-browser-storage";

describe("account-scoped AI browser storage", () => {
  it("uses distinct, collision-safe keys for different signed-in accounts", () => {
    const namespace = "beutl:ai:prompt-library";

    expect(accountScopedAiStorageKey(namespace, "account-a")).not.toBe(
      accountScopedAiStorageKey(namespace, "account-b"),
    );
    expect(accountScopedAiStorageKey(namespace, "account:a")).not.toBe(
      accountScopedAiStorageKey(namespace, "account%3Aa"),
    );
    expect(accountScopedAiStorageKey(namespace, "account:a")).toBe(
      `${namespace}:account%3Aa`,
    );
  });

  it("rejects an empty identity instead of falling back to global storage", () => {
    expect(() => accountScopedAiStorageKey("beutl:ai:subtitle-handoff", ""))
      .toThrow("A user ID is required");
  });

  it("routes prompt drafts and subtitle handoffs through the signed-in user key", () => {
    const promptLibrary = readFileSync(new URL(
      "../../apps/web/src/app/[lang]/(dashboard)/dashboard/ai/prompt-library.tsx",
      import.meta.url,
    ), "utf8");
    const handoff = readFileSync(new URL(
      "../../apps/web/src/lib/subtitle-handoff.ts",
      import.meta.url,
    ), "utf8");
    const transcribe = readFileSync(new URL(
      "../../apps/web/src/app/[lang]/(dashboard)/dashboard/ai/transcribe-form.tsx",
      import.meta.url,
    ), "utf8");
    const translate = readFileSync(new URL(
      "../../apps/web/src/app/[lang]/(dashboard)/dashboard/ai/translate-form.tsx",
      import.meta.url,
    ), "utf8");
    const translatePage = readFileSync(new URL(
      "../../apps/web/src/app/[lang]/(dashboard)/dashboard/ai/translate/page.tsx",
      import.meta.url,
    ), "utf8");

    expect(promptLibrary).toContain("promptLibraryKey(userId)");
    expect(promptLibrary).toContain("library.owner === userId");
    expect(handoff).toContain("handoffKey(userId)");
    expect(transcribe).toContain("saveSubtitleHandoff(userId,");
    expect(translate).toContain("loadSubtitleHandoff(userId)");
    expect(translate).toContain("clearSubtitleHandoff(userId)");
    expect(translatePage).toContain("key={session.user.id}");
  });
});
