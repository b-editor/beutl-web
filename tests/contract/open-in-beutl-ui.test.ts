// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "../../apps/web/node_modules/react";
import { createRoot, type Root } from "../../apps/web/node_modules/react-dom/client";
import { OpenInBeutlButton } from "../../apps/web/src/components/open-in-beutl-button";
import { RepositoryHeader } from "../../apps/web/src/app/[lang]/(dashboard)/dashboard/repositories/[id]/repository-header";
import { RepositoryConnectionDialog } from "../../apps/web/src/app/[lang]/(dashboard)/dashboard/repositories/repository-connection-dialog";
import { RepositoryActions, RepositoryContextMenu } from "../../apps/web/src/app/[lang]/(dashboard)/dashboard/repositories/repository-items";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("../../apps/web/src/app/[lang]/(dashboard)/dashboard/account/security/api-key-actions", () => ({
  retrieveApiKeys: async () => ({ success: true, data: { keys: [] } }),
  createApiKey: vi.fn(),
  revokeApiKey: vi.fn(),
}));

const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const href = `beutl://repo/open?id=${id}`;
const repository = {
  id,
  name: "Project",
  url: `https://git.example/api/v3/git/${id}.git`,
  createdAt: "2026-10-04T00:00:00Z",
  updatedAt: "2026-10-04T00:00:00Z",
};

describe("Open in Beutl", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  function clickLaunchLink(link: HTMLAnchorElement) {
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    event.preventDefault();
    return act(() => { link.dispatchEvent(event); });
  }

  it.each([
    ["en", "Open in Beutl", "Download Beutl"],
    ["ja", "Beutl で開く", "Beutlをダウンロード"],
  ])("renders a localized link and shows the download hint after activation (%s)", async (lang, label, downloadLabel) => {
    await act(() => root.render(createElement(OpenInBeutlButton, {
      repositoryId: id, refName: "scene/intro", lang, variant: "outline", size: "sm", className: "fixture-launch",
    })));
    const link = container.querySelector<HTMLAnchorElement>("a.fixture-launch")!;
    const status = container.querySelector('[role="status"]')!;
    expect(link.getAttribute("href")).toBe(`${href}&ref=scene%2Fintro`);
    expect(link.textContent).toBe(label);
    expect(status.textContent).toBe("");

    await clickLaunchLink(link);
    const download = status.querySelector("a")!;
    expect(download.textContent).toBe(downloadLabel);
    expect(download.getAttribute("href")).toBe("https://github.com/b-editor/beutl/releases/latest");
  });

  it("can omit the launch notice while keeping the link", async () => {
    await act(() => root.render(createElement(OpenInBeutlButton, { repositoryId: id, lang: "en", showLaunchNotice: false })));
    const link = container.querySelector<HTMLAnchorElement>("a")!;
    expect(link.getAttribute("href")).toBe(href);
    await clickLaunchLink(link);
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it.each([
    { tab: "files", current: "refs/tags/v1" },
    { tab: "commits", current: "abcde".repeat(8) },
    { tab: "files", current: null },
  ] as const)("passes the current ref $current from the $tab header", async ({ tab, current }) => {
    await act(() => root.render(createElement(RepositoryHeader, {
      lang: "en", repository, refs: { defaultBranch: null, branches: [], tags: [] }, tab, current,
    })));
    const link = container.querySelector<HTMLAnchorElement>('a[href^="beutl:"]')!;
    expect(new URL(link.href).searchParams.get("id")).toBe(id);
    expect(new URL(link.href).searchParams.get("ref")).toBe(current);
  });

  it.each(["dropdown", "context"])("renders the desktop handoff in the %s menu", async (menu) => {
    const props = {
      lang: "en", repository, disabled: false, copied: false,
      handlers: { connect: vi.fn(), copyUrl: vi.fn(), rename: vi.fn(), delete: vi.fn() },
    };
    const view = menu === "dropdown"
      ? createElement(RepositoryActions, props)
      : createElement(RepositoryContextMenu, { ...props, children: createElement("div", {}, repository.name) });
    await act(() => root.render(view));

    const trigger = container.firstElementChild!;
    await act(() => {
      if (menu === "dropdown") {
        trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      } else {
        trigger.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
      }
    });
    const item = document.querySelector<HTMLAnchorElement>('a[role="menuitem"][href^="beutl:"]')!;
    expect(item.getAttribute("href")).toBe(href);
    expect(item.textContent).toBe("Open in Beutl");
  });

  it("keeps connection details focused on manual Git setup", async () => {
    await act(() => root.render(createElement(RepositoryConnectionDialog, { lang: "en", repository, onClose: vi.fn() })));
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.querySelector('a[href^="beutl:"]')).toBeNull();
    expect(dialog.querySelector<HTMLInputElement>("#repository-clone-url")?.value).toBe(repository.url);
    expect(dialog.querySelector("#repository-token-name")).not.toBeNull();
  });
});
