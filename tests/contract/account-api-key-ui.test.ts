// @vitest-environment happy-dom
import { mkdirSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "../../apps/web/node_modules/react";
import { createRoot, type Root } from "../../apps/web/node_modules/react-dom/client";

const mocks = vi.hoisted(() => ({ create: vi.fn(), copy: vi.fn() }));
vi.mock("@/lib/auth-guard", () => ({ authOrSignIn: async () => ({ user: { id: "owner" } }) }));
vi.mock("@beutl/db", () => ({ retrieveAccountsWithIdToken: async () => [], getPasskeysByUserId: async () => [] }));
vi.mock("../../apps/web/src/app/[lang]/(dashboard)/dashboard/account/security/components", () => ({ Form: () => null, List: () => null, PasskeysList: () => null }));
vi.mock("../../apps/web/src/app/[lang]/(dashboard)/dashboard/account/security/api-key-actions", () => ({
  retrieveApiKeys: async () => ({ success: true, data: { keys: [], repositories: [], gitAvailable: true } }),
  createApiKey: mocks.create, revokeApiKey: vi.fn(),
}));
import Page from "../../apps/web/src/app/[lang]/(dashboard)/dashboard/account/security/page";

describe("API key dialog registry source", () => {
  let root: Root, container: HTMLDivElement;
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.spyOn(navigator.clipboard, "writeText").mockImplementation(mocks.copy);
    mocks.create.mockResolvedValue({ success: true, data: { secret: "bn_ui_fixture_only", key: {
      kind: "nuget", id: "fixture", name: "Test key", hint: "fixture", scope: "read",
      createdAt: "2026-10-16T00:00:00Z", expiresAt: "2026-11-16T00:00:00Z",
    } } });
    container = document.createElement("div"); document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(() => root.unmount()); container.remove();
    vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  });
  for (const lang of ["ja", "en"]) {
    it.each(["https://staging.nuget.example/", "http://localhost:8787", ""])(`shows and copies the runtime source (${lang}): %s`, async (origin) => {
      vi.stubEnv("NUGET_PUBLIC_ORIGIN", origin);
      const expected = `${(origin || "https://nuget.beditor.net").replace(/\/$/u, "")}/v3/index.json`;
      const page = await Page({ params: Promise.resolve({ lang }), searchParams: Promise.resolve({}) });
      await act(() => root.render(page));
      await act(() => container.querySelectorAll<HTMLButtonElement>("#api-keys button")[1].click());
      const name = document.querySelector<HTMLInputElement>("#api-key-name")!;
      await act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(name, "Test key");
        name.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(() => document.querySelector("#create-api-key")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
      expect(mocks.create).toHaveBeenCalledOnce();
      const source = document.querySelector<HTMLInputElement>("#api-key-nuget-source")!;
      expect(source.value).toBe(expected);
      await act(() => source.parentElement!.querySelector<HTMLButtonElement>("button")!.click());
      expect(mocks.copy).toHaveBeenCalledWith(expected);
      const directory = process.env.BEUTL_API_KEY_PREVIEW;
      if (directory && origin.startsWith("https://staging")) {
        mkdirSync(directory, { recursive: true });
        writeFileSync(`${directory}/key-${lang}.html`, `<!doctype html><html lang="${lang}" class="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body class="bg-background text-foreground">${document.body.innerHTML}</body></html>`);
      }
    });
  }
});
