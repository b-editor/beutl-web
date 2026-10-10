// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "../../apps/web/node_modules/react";
import { createRoot, type Root } from "../../apps/web/node_modules/react-dom/client";
import { DEFAULT_STORAGE_LISTING } from "@beutl/core";

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/en/dashboard/storage" }));
vi.mock("@beutl/ui/i18n-client", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@beutl/ui/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("../../apps/web/src/app/[lang]/(dashboard)/dashboard/storage/actions", () => ({
  changeFileVisibility: vi.fn(), countFilesInFolders: vi.fn(), createFolder: vi.fn(),
  deleteFile: vi.fn(), deleteFolder: vi.fn(), moveFiles: vi.fn(), moveFolder: vi.fn(),
  renameFile: vi.fn(), renameFolder: vi.fn(),
}));
vi.mock("@/lib/storage-upload", () => ({
  loadPendingStorageUploadCompletions: () => [], resumeStorageUploadCompletion: vi.fn(),
  discardPendingStorageUploadCompletion: vi.fn(), persistPendingStorageUploadCompletion: vi.fn(),
  withStorageUploadLock: vi.fn(), uploadStorageFile: vi.fn(),
}));
import { List } from "../../apps/web/src/app/[lang]/(dashboard)/dashboard/storage/list";

const files = ["Zulu.txt", "Alpha.txt", "Beta.txt"].map((name, index) => ({
  id: `file-${index}`, name, size: BigInt(1024 + index), visibility: "PRIVATE" as const,
  mimeType: "text/plain", createdAt: new Date("2026-09-01T00:00:00Z"), folderId: null,
}));

describe("storage table interactions", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    localStorage.clear();
    localStorage.setItem("beutl.storage.view", "list");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(() => root.unmount());
    container.remove();
    localStorage.clear();
    vi.unstubAllGlobals();
  });
  async function render(page = 1) {
    await act(() => root.render(createElement(List, {
      files, folders: [], total: 30, totalFiles: 30, page, pageCount: 2,
      listing: { ...DEFAULT_STORAGE_LISTING, page }, lang: "en", userId: "fixture-user",
    })));
  }
  const fileRows = () => [...container.querySelectorAll<HTMLTableRowElement>('tbody tr[aria-selected]')];
  const allCheckbox = () => container.querySelector<HTMLButtonElement>('[role="checkbox"][aria-label="storage:selectAll"]')!;

  it("keeps server order and updates mixed/all/empty page selection", async () => {
    await render();
    expect(fileRows().map(row => row.querySelector('[title$=".txt"]')?.getAttribute("title"))).toEqual(files.map(file => file.name));
    await act(() => fileRows()[0].querySelector<HTMLButtonElement>('[role="checkbox"]')!.click());
    expect(allCheckbox().getAttribute("aria-checked")).toBe("mixed");
    await act(() => allCheckbox().click());
    expect(fileRows().every(row => row.getAttribute("aria-selected") === "true")).toBe(true);
    expect(allCheckbox().getAttribute("aria-checked")).toBe("true");
    await act(() => allCheckbox().click());
    expect(fileRows().every(row => row.getAttribute("aria-selected") === "false")).toBe(true);
    expect(allCheckbox().getAttribute("aria-checked")).toBe("false");
  });

  it("supports range selection, Ctrl+A, Escape, and switching to grid", async () => {
    await render();
    await act(() => fileRows()[0].dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await act(() => fileRows()[2].dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true })));
    expect(fileRows().every(row => row.getAttribute("aria-selected") === "true")).toBe(true);
    await act(() => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(allCheckbox().getAttribute("aria-checked")).toBe("false");
    await act(() => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true })));
    const grid = container.querySelector<HTMLButtonElement>('[aria-label="storage:viewGrid"]')!;
    await act(() => grid.click());
    expect(container.querySelectorAll('[role="option"][aria-selected="true"]')).toHaveLength(3);
  });

  it("sends sort and page changes to the server instead of processing rows locally", async () => {
    await render();
    const nameSort = [...container.querySelectorAll<HTMLButtonElement>("thead button")].find(button => button.textContent === "storage:fileName")!;
    await act(() => nameSort.click());
    expect(router.push.mock.calls.at(-1)?.[0]).toContain("sort=name");
    expect(fileRows().map(row => row.querySelector('[title$=".txt"]')?.getAttribute("title"))).toEqual(files.map(file => file.name));
    const next = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "storage:nextPage")!;
    await act(() => next.click());
    expect(router.push.mock.calls.at(-1)?.[0]).toContain("page=2");
    await render(2);
    expect(fileRows()).toHaveLength(3);
  });
});
