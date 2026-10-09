// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "../../apps/web/node_modules/react";
import { createRoot, type Root } from "../../apps/web/node_modules/react-dom/client";
import { MarkdownEditor } from "@beutl/ui/ui/markdown-editor";

const mocks = vi.hoisted(() => ({
  updateDescription: vi.fn(),
  updateRelease: vi.fn(),
  searchParams: new URLSearchParams(),
}));

vi.mock("@beutl/ui/i18n-client", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@beutl/ui/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => mocks.searchParams,
}));
vi.mock(
  "../../apps/web/src/app/[lang]/(dashboard)/dashboard/developer/projects/[name]/actions/package",
  () => ({ updateDescription: mocks.updateDescription }),
);
vi.mock(
  "../../apps/web/src/app/[lang]/(dashboard)/dashboard/developer/projects/[name]/actions/release",
  () => ({ updateRelease: mocks.updateRelease, createRelease: vi.fn(), deleteRelease: vi.fn() }),
);
vi.mock("../../apps/web/src/app/[lang]/(store)/store/[name]/actions", () => ({
  addToLibrary: vi.fn(),
  removeFromLibrary: vi.fn(),
}));

import { PackageDescriptionForm } from "../../apps/web/src/app/[lang]/(dashboard)/dashboard/developer/projects/[name]/package-description-form";
import { ReleaseForm } from "../../apps/web/src/app/[lang]/(dashboard)/dashboard/developer/projects/[name]/release-form";
import { ClientPage } from "../../apps/web/src/app/[lang]/(store)/store/[name]/components";

const markdown = "## Changes\n\n- **Markdown** support\n- [Docs](https://example.com/docs)";
const release = {
  id: "release-1",
  version: "2.0.0",
  title: "**Release title**",
  description: markdown,
  targetVersion: "2.0.0",
  published: true,
};
const pkg = {
  id: "package-1",
  name: "Example.Package",
  displayName: "Example",
  description: "# Package description",
  shortDescription: "Plain summary",
  tags: [],
  iconFileUrl: null,
  PackageScreenshot: [],
  Release: [release],
  user: { Profile: { userName: "publisher" } },
};
const labels = {
  write: "Write",
  preview: "Preview",
  hint: "Markdown is supported.",
  emptyPreview: "Nothing to preview.",
};

describe("package Markdown interactions", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.searchParams = new URLSearchParams();
    mocks.updateDescription.mockResolvedValue({ success: true });
    mocks.updateRelease.mockResolvedValue({ success: true, data: release });
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

  function button(text: string) {
    return [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === text || button.getAttribute("aria-label") === text,
    )!;
  }

  async function input(value: string) {
    const textarea = container.querySelector("textarea")!;
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        textarea,
        value,
      );
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("renders package and selected release Markdown in the public store", async () => {
    await act(() =>
      root.render(
        createElement(ClientPage, { pkg: pkg as never, lang: "en", owned: false, paied: false }),
      ),
    );
    expect(container.querySelector("h1")?.textContent).toBe("Package description");
    expect(container.querySelector("li strong")?.textContent).toBe("Markdown");
    expect(container.textContent).toContain("**Release title**");

    mocks.searchParams = new URLSearchParams("v=1.0.0");
    const oldRelease = {
      ...release,
      id: "release-0",
      version: "1.0.0",
      description: "### Previous release\n\n1. Previous change",
    };
    await act(() =>
      root.render(
        createElement(ClientPage, {
          pkg: { ...pkg, Release: [release, oldRelease] } as never,
          lang: "en",
          owned: false,
          paied: false,
        }),
      ),
    );
    expect(container.querySelector("ol li")?.textContent).toBe("Previous change");
    expect(container.querySelector("li strong")).toBeNull();
  });

  it("previews and saves the exact package Markdown source", async () => {
    await act(() =>
      root.render(createElement(PackageDescriptionForm, { pkg: pkg as never, lang: "en" })),
    );
    expect(container.querySelector("h1")?.textContent).toBe("Package description");
    await act(() => button("developer:common.edit").click());
    await input(markdown);
    await act(() => button("developer:markdown.preview").click());
    expect(container.querySelector('[role="region"] li strong')?.textContent).toBe("Markdown");
    expect(container.querySelector("textarea")?.maxLength).toBe(1000);
    await act(() => button("developer:common.save").click());
    expect(mocks.updateDescription).toHaveBeenCalledWith({
      packageId: pkg.id,
      description: markdown,
    });
  });

  it("previews and saves release Markdown with its existing metadata", async () => {
    await act(() =>
      root.render(
        createElement(ReleaseForm, {
          pkg: pkg as never,
          lang: "en",
          beutlVersions: ["2.0.0", "1.9.0"],
        }),
      ),
    );
    expect(container.querySelector("li strong")?.textContent).toBe("Markdown");
    await act(() => button("developer:common.edit").click());
    const changed = "### Bug fixes\n\n- Fixed **rendering**\n- Kept package files";
    await input(changed);
    await act(() => button("developer:markdown.preview").click());
    expect(container.querySelector('[role="region"] strong')?.textContent).toBe("rendering");
    await act(() => button("developer:common.save").click());
    const form = mocks.updateRelease.mock.calls[0][0] as FormData;
    expect(form.get("description")).toBe(changed);
    expect(form.get("id")).toBe(release.id);
    expect(form.get("title")).toBe(release.title);
    expect(form.get("published")).toBe("on");
  });

  it("keeps the source in native form submissions while previewing", async () => {
    await act(() =>
      root.render(
        createElement(
          "form",
          null,
          createElement(MarkdownEditor, {
            name: "description",
            value: markdown,
            labels,
            readOnly: true,
          }),
        ),
      ),
    );
    await act(() => button("Preview").click());
    const form = container.querySelector("form")!;
    expect(new window.FormData(form).get("description")).toBe(markdown);
    expect(button("Preview").type).toBe("button");
    expect(button("Write").type).toBe("button");
    await act(() => button("Write").click());
    expect(container.querySelector("textarea")?.value).toBe(markdown);
  });

  it("shows an empty preview and disables both controls while saving", async () => {
    await act(() => root.render(createElement(MarkdownEditor, { value: "", labels })));
    await act(() => button("Preview").click());
    expect(container.querySelector('[role="region"]')?.textContent).toBe(labels.emptyPreview);
    await act(() =>
      root.render(createElement(MarkdownEditor, { value: "", labels, disabled: true })),
    );
    expect(button("Preview").disabled).toBe(true);
    expect(button("Write").disabled).toBe(true);
    expect(container.querySelector("textarea")?.disabled).toBe(true);
  });
});
