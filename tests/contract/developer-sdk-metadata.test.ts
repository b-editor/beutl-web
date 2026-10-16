// @vitest-environment happy-dom
import { mkdirSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "../../apps/web/node_modules/react";
import { createRoot, type Root } from "../../apps/web/node_modules/react-dom/client";
import { getTranslation } from "@beutl/i18n";

const mocks = vi.hoisted(() => ({ retrieve: vi.fn(), updateTag: vi.fn() }));
vi.mock("@/lib/auth-guard", () => ({ throwIfUnauth: async () => ({ user: { id: "owner" } }) }));
vi.mock("@beutl/db", async (original) => ({ ...await original<object>(), findAppReleaseAssetVersions: async () => [] }));
vi.mock("../../apps/web/src/app/[lang]/(dashboard)/dashboard/developer/projects/[name]/actions/package", () => ({
  retrievePackage: mocks.retrieve, updateTag: mocks.updateTag,
  updateDisplayNameAndShortDescription: vi.fn(), updateDescription: vi.fn(), deletePackage: vi.fn(),
  changePackageVisibility: vi.fn(), uploadIcon: vi.fn(),
}));
import Page from "../../apps/web/src/app/[lang]/(dashboard)/dashboard/developer/projects/[name]/page";

describe("nuspec-owned SDK metadata", () => {
  let root: Root, container: HTMLDivElement;
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div"); document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(() => root.unmount()); container.remove(); vi.unstubAllGlobals();
  });
  for (const lang of ["ja", "en"]) {
    it.each(["DEVELOPMENT", "USER"])(`keeps editorial controls exclusive to user packages (${lang}, %s)`, async (audience) => {
      const { t } = await getTranslation(lang);
      mocks.retrieve.mockResolvedValue({
        id: "pkg", name: "Beutl.Extensibility.Sdk", audience, published: true,
        displayName: "Beutl Extensibility SDK", shortDescription: "Libraries for building Beutl extensions.",
        description: "SDK metadata from the package manifest.", tags: ["sdk", "beutl"],
        iconFileUrl: null, PackageScreenshot: [], Release: [],
      });
      await act(async () => root.render(await Page({ params: Promise.resolve({ lang, name: "Beutl.Extensibility.Sdk" }) })));
      const header = container.querySelector("h2")!.parentElement!.parentElement!.parentElement!;
      const edit = header.querySelector<HTMLButtonElement>(`button[aria-label="${t("developer:common.edit")}"]`);
      const details = [...container.querySelectorAll("h4")].find((h) => h.textContent === t("developer:details.title"))!.parentElement!;
      const description = [...container.querySelectorAll("h3")].find((h) => h.textContent === t("developer:description.title"));
      if (audience === "DEVELOPMENT") {
        expect(edit).toBeNull();
        expect(header.querySelector("input")).toBeNull();
        expect(description).toBeUndefined();
        expect(details.querySelector("button")).toBeNull();
        expect(details.textContent).toContain("SDK");
        expect(details.textContent).toContain("sdk");
        const tag = [...details.querySelectorAll("div")].find((badge) => badge.textContent === "sdk")!;
        await act(() => tag.dispatchEvent(new MouseEvent("click", { bubbles: true })));
        expect(mocks.updateTag).not.toHaveBeenCalled();
      } else {
        expect(edit).not.toBeNull();
        expect(description).toBeDefined();
        expect(details.querySelector("button")).not.toBeNull();
        await act(() => edit!.click());
        expect(header.querySelector("input")!.classList.contains("hidden")).toBe(false);
      }
      const directory = process.env.BEUTL_NUGET_PREVIEW;
      if (directory) {
        mkdirSync(directory, { recursive: true });
        writeFileSync(`${directory}/dashboard-${audience}-${lang}.html`, `<!doctype html><html lang="${lang}" class="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body class="bg-background text-foreground">${container.innerHTML}</body></html>`);
      }
    });
  }
});
