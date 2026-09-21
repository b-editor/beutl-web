import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL(
    "../../apps/admin/src/app/[lang]/admin/ai/model-list.tsx",
    import.meta.url,
  ),
  "utf8",
);
const settingsSource = readFileSync(
  new URL(
    "../../apps/admin/src/app/[lang]/admin/ai/settings-form.tsx",
    import.meta.url,
  ),
  "utf8",
);
const actionSource = readFileSync(
  new URL(
    "../../apps/admin/src/app/[lang]/admin/ai/actions.ts",
    import.meta.url,
  ),
  "utf8",
);

describe("admin AI model editor", () => {
  it("allows an existing model's provider to be changed", () => {
    const start = source.indexOf(
      '<Field label={t("admin:ai.models.provider")}>',
    );
    const end = source.indexOf("</Field>", start);
    const providerField = source.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(providerField).toContain("disabled={isPending}");
    expect(providerField).not.toContain("!isNew");
  });

  it("refreshes provider-dependent previews for an applied draft", () => {
    expect(settingsSource).toContain("savedModels: saved");
    expect(source).toContain(
      "savedModel.provider !== model.provider",
    );
    expect(source).toContain("<LookedUpModelEconomics");
    expect(source).toContain("economics.unsupported");
    expect(actionSource).toContain(
      "isModelUnsupportedForOperation(operation, model)",
    );
    expect(actionSource).toContain("unsupported,");
  });
});
