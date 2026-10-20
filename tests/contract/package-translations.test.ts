// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ReactNode } from "../../apps/web/node_modules/react";
import { createRoot, type Root } from "../../apps/web/node_modules/react-dom/client";

vi.mock("@beutl/ui/i18n-client", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@beutl/ui/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock(
  "../../apps/web/src/app/[lang]/(dashboard)/dashboard/developer/projects/[name]/actions/package",
  () => ({
    updateDescription: vi.fn(),
    updateDisplayNameAndShortDescription: vi.fn(),
    deletePackage: vi.fn(),
    changePackageVisibility: vi.fn(),
    uploadIcon: vi.fn(),
  }),
);
vi.mock(
  "../../apps/web/src/app/[lang]/(dashboard)/dashboard/developer/projects/[name]/actions/release",
  () => ({
    createRelease: vi.fn(),
    deleteRelease: vi.fn(),
    updateRelease: vi.fn(),
  }),
);

import { setDbProvider, upsertPackageTranslations, upsertReleaseTranslations } from "@beutl/db";
import {
  localizedDisplayName,
  localizedPackageText,
  localizedReleaseDescription,
  localizedShortDescription,
} from "@beutl/core";
import { TranslationModeProvider, useTranslationMode } from "../../apps/web/src/app/[lang]/(dashboard)/dashboard/developer/projects/[name]/translation-mode";
import { TranslationLanguageDialog } from "../../apps/web/src/app/[lang]/(dashboard)/dashboard/developer/projects/[name]/translation-language-menu";
import { PackageDescriptionForm } from "../../apps/web/src/app/[lang]/(dashboard)/dashboard/developer/projects/[name]/package-description-form";
import { PackageInfoForm } from "../../apps/web/src/app/[lang]/(dashboard)/dashboard/developer/projects/[name]/package-info-form";
import { ReleaseForm } from "../../apps/web/src/app/[lang]/(dashboard)/dashboard/developer/projects/[name]/release-form";

const languages = [
  { code: "ja", name: "Japanese" },
  { code: "en", name: "English" },
];

function TranslationModeProbe() {
  const { language, addedLanguages, availableLanguages } = useTranslationMode();
  return createElement(
    "p",
    null,
    `${language ?? "original"}|${addedLanguages.map((l) => l.code).join(",")}|${availableLanguages.map((l) => l.code).join(",")}`,
  );
}

describe("read-time resolution", () => {
  const pkg = {
    displayName: "Original name",
    shortDescription: "Original summary",
    description: "Original description",
    PackageTranslation: [
      {
        lang: "ja",
        displayName: "翻訳名",
        shortDescription: "翻訳の概要",
        description: "翻訳の説明",
      },
      { lang: "en", shortDescription: null, description: "English-only description" },
    ],
  };

  it("uses the row for the requested language and keeps the original elsewhere", () => {
    expect(localizedPackageText(pkg, "ja")).toEqual({
      displayName: "翻訳名",
      shortDescription: "翻訳の概要",
      description: "翻訳の説明",
    });
    // en 行は description だけを持つ。フィールド単位で原文へ落ちる。
    expect(localizedPackageText(pkg, "en")).toEqual({
      displayName: "Original name",
      shortDescription: "Original summary",
      description: "English-only description",
    });
    expect(localizedPackageText(pkg, "fr")).toEqual({
      displayName: "Original name",
      shortDescription: "Original summary",
      description: "Original description",
    });
  });

  it("falls back to the original when a translation row is missing or blank", () => {
    expect(
      localizedShortDescription(
        { displayName: "Original name", shortDescription: "Original" },
        "ja",
      ),
    ).toBe("Original");
    expect(
      localizedShortDescription(
        {
          displayName: "Original name",
          shortDescription: "Original",
          PackageTranslation: [{ lang: "ja", shortDescription: "  " }],
        },
        "ja",
      ),
    ).toBe("Original");
  });

  it("localizes the display name but leaves the identifier alone", () => {
    expect(localizedDisplayName(pkg, "ja")).toBe("翻訳名");
    expect(localizedDisplayName(pkg, "en")).toBe("Original name");
    expect(
      localizedDisplayName(
        {
          displayName: "Original name",
          shortDescription: "",
          PackageTranslation: [{ lang: "ja", displayName: "  " }],
        },
        "ja",
      ),
    ).toBe("Original name");
  });

  it("resolves release notes the same way", () => {
    const release = {
      description: "Original notes",
      ReleaseTranslation: [{ lang: "ja", description: "翻訳ノート" }],
    };
    expect(localizedReleaseDescription(release, "ja")).toBe("翻訳ノート");
    expect(localizedReleaseDescription(release, "en")).toBe("Original notes");
  });
});

describe("translation row upserts", () => {
  const calls = {
    packageUpsert: vi.fn(),
    packageDelete: vi.fn(),
    releaseUpsert: vi.fn(),
    releaseDelete: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    calls.packageUpsert.mockResolvedValue({
      displayName: null,
      shortDescription: null,
      description: null,
    });
    const client = {
      $transaction: async (fn: (tx: typeof client) => unknown) => fn(client),
      packageTranslation: {
        upsert: calls.packageUpsert,
        deleteMany: calls.packageDelete,
      },
      releaseTranslation: {
        upsert: calls.releaseUpsert,
        deleteMany: calls.releaseDelete,
      },
    };
    setDbProvider(async () => client as never);
  });

  it("writes only the fields the caller provided", async () => {
    calls.packageUpsert.mockResolvedValueOnce({
      displayName: null,
      shortDescription: "Summary",
      description: null,
    });
    await upsertPackageTranslations({
      packageId: "pkg",
      translations: [{ lang: "en", shortDescription: "Summary" }],
    });

    expect(calls.packageUpsert).toHaveBeenCalledExactlyOnceWith({
      where: { packageId_lang: { packageId: "pkg", lang: "en" } },
      create: {
        packageId: "pkg",
        lang: "en",
        displayName: null,
        shortDescription: "Summary",
        description: null,
      },
      // 説明 (description) はこの呼び出しの持ち物ではないので触らない。
      update: { shortDescription: "Summary" },
    });
    expect(calls.packageDelete).not.toHaveBeenCalled();
  });

  it("writes a display name without touching the other fields", async () => {
    calls.packageUpsert.mockResolvedValueOnce({
      displayName: "翻訳名",
      shortDescription: null,
      description: null,
    });
    await upsertPackageTranslations({
      packageId: "pkg",
      translations: [{ lang: "ja", displayName: "翻訳名" }],
    });

    expect(calls.packageUpsert).toHaveBeenCalledExactlyOnceWith({
      where: { packageId_lang: { packageId: "pkg", lang: "ja" } },
      create: {
        packageId: "pkg",
        lang: "ja",
        displayName: "翻訳名",
        shortDescription: null,
        description: null,
      },
      update: { displayName: "翻訳名" },
    });
    expect(calls.packageDelete).not.toHaveBeenCalled();
  });

  it("removes the row when the update leaves it empty", async () => {
    await upsertPackageTranslations({
      packageId: "pkg",
      translations: [{ lang: "ja", displayName: "", shortDescription: "  ", description: "" }],
    });

    expect(calls.packageDelete).toHaveBeenCalledExactlyOnceWith({
      where: { packageId: "pkg", lang: "ja" },
    });
  });

  it("keeps a row whose other form still has content", async () => {
    calls.packageUpsert.mockResolvedValueOnce({
      displayName: "翻訳名",
      shortDescription: null,
      description: null,
    });
    await upsertPackageTranslations({
      packageId: "pkg",
      translations: [{ lang: "ja", description: "" }],
    });

    expect(calls.packageUpsert).toHaveBeenCalledWith({
      where: { packageId_lang: { packageId: "pkg", lang: "ja" } },
      create: {
        packageId: "pkg",
        lang: "ja",
        displayName: null,
        shortDescription: null,
        description: null,
      },
      update: { description: null },
    });
    expect(calls.packageDelete).not.toHaveBeenCalled();
  });

  it("leaves a language alone when the caller sends no field", async () => {
    await upsertPackageTranslations({ packageId: "pkg", translations: [{ lang: "en" }] });

    expect(calls.packageUpsert).not.toHaveBeenCalled();
    expect(calls.packageDelete).not.toHaveBeenCalled();
  });

  it("deletes a blank release note but keeps a written one", async () => {
    await upsertReleaseTranslations({
      releaseId: "release",
      translations: [
        { lang: "ja", description: "" },
        { lang: "en", description: "Notes" },
      ],
    });

    expect(calls.releaseDelete).toHaveBeenCalledExactlyOnceWith({
      where: { releaseId: "release", lang: "ja" },
    });
    expect(calls.releaseUpsert).toHaveBeenCalledExactlyOnceWith({
      where: { releaseId_lang: { releaseId: "release", lang: "en" } },
      create: { releaseId: "release", lang: "en", description: "Notes" },
      update: { description: "Notes" },
    });
  });
});

describe("translation editing UI", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
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

  const pkg = {
    id: "package-1",
    name: "Example.Package",
    displayName: "Original display name",
    shortDescription: "Original summary",
    description: "Original description",
    audience: "USER",
    tags: [],
    iconFileUrl: null,
    PackageTranslation: [
      {
        lang: "ja",
        displayName: "翻訳名",
        shortDescription: "翻訳の概要",
        description: "翻訳の説明",
      },
    ],
    PackageScreenshot: [],
    Release: [
      {
        id: "release-1",
        version: "2.0.0",
        title: "Release",
        description: "Original notes",
        targetVersion: "2.0.0",
        published: true,
        ReleaseTranslation: [{ lang: "ja", description: "翻訳ノート" }],
      },
    ],
    user: { Profile: { userName: "publisher" } },
  };

  async function renderWithLanguage(
    children: ReactNode,
    defaultLanguage = "ja",
  ) {
    await act(() =>
      root.render(
        createElement(
          TranslationModeProvider,
          { languages, defaultLanguage },
          children,
        ),
      ),
    );
  }

  function editButton() {
    return [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.getAttribute("aria-label") === "developer:common.edit",
    )!;
  }

  it("previews every form in the selected language", async () => {
    await renderWithLanguage(
      createElement(
        "div",
        null,
        createElement(PackageInfoForm, { pkg: pkg as never, lang: "en", languages }),
        createElement(PackageDescriptionForm, { pkg: pkg as never, lang: "en", languages }),
        createElement(ReleaseForm, {
          pkg: pkg as never,
          lang: "en",
          languages,
          beutlVersions: [],
        }),
      ),
    );

    expect(container.textContent).toContain("翻訳名");
    expect(container.textContent).toContain("翻訳の概要");
    expect(container.textContent).toContain("翻訳の説明");
    expect(container.textContent).toContain("翻訳ノート");
    expect(container.textContent).not.toContain("Original display name");
    expect(container.textContent).not.toContain("Original summary");
    expect(container.textContent).not.toContain("Original description");
    expect(container.textContent).not.toContain("Original notes");
  });

  it("edits the display name and summary with the original inputs", async () => {
    await renderWithLanguage(
      createElement(PackageInfoForm, { pkg: pkg as never, lang: "en", languages }),
    );

    await act(() => editButton().click());

    const displayNameInput = container.querySelector<HTMLInputElement>(
      'input[placeholder="Original display name"]',
    )!;
    expect(displayNameInput.value).toBe("翻訳名");
    expect(displayNameInput.placeholder).toBe("Original display name");
    const summaryInput = container.querySelectorAll("input")[1];
    expect(summaryInput.value).toBe("翻訳の概要");
    expect(summaryInput.placeholder).toBe("Original summary");

    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        displayNameInput,
        "新しい名前",
      );
      displayNameInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(displayNameInput.value).toBe("新しい名前");
  });

  it("edits the description with the same markdown editor as the original", async () => {
    await renderWithLanguage(
      createElement(PackageDescriptionForm, { pkg: pkg as never, lang: "en", languages }),
    );

    await act(() => editButton().click());

    const editors = container.querySelectorAll<HTMLTextAreaElement>("textarea");
    expect(editors).toHaveLength(1);
    expect(editors[0].id).toBe("package-description");
    expect(editors[0].value).toBe("翻訳の説明");
    expect(editors[0].placeholder).toBe("Original description");
  });

  it("edits release notes with the same markdown editor as the original", async () => {
    await renderWithLanguage(
      createElement(ReleaseForm, {
        pkg: pkg as never,
        lang: "en",
        languages,
        beutlVersions: [],
      }),
    );

    await act(() => editButton().click());

    const editor = container.querySelector<HTMLTextAreaElement>(
      "#release-description",
    )!;
    expect(editor.value).toBe("翻訳ノート");
    expect(editor.placeholder).toBe("Original notes");
  });

  it("mutes previews that fall back to the original text", async () => {
    await renderWithLanguage(
      createElement(
        "div",
        null,
        createElement(PackageInfoForm, { pkg: pkg as never, lang: "en", languages }),
        createElement(PackageDescriptionForm, { pkg: pkg as never, lang: "en", languages }),
        createElement(ReleaseForm, {
          pkg: pkg as never,
          lang: "en",
          languages,
          beutlVersions: [],
        }),
      ),
      "en",
    );

    const heading = container.querySelector("h2")!;
    expect(heading.textContent).toBe("Original display name");
    expect(heading.className).toContain("text-muted-foreground");

    const summary = [...container.querySelectorAll("p")].find(
      (element) => element.textContent === "Original summary",
    )!;
    expect(summary.className).toContain("text-muted-foreground");

    const markdowns = [...container.querySelectorAll("div.leading-7")];
    const description = markdowns.find(
      (element) => element.textContent === "Original description",
    )!;
    const notes = markdowns.find(
      (element) => element.textContent === "Original notes",
    )!;
    expect(description.className).toContain("text-muted-foreground");
    expect(notes.className).toContain("text-muted-foreground");
  });

  it("treats only languages with saved translations as added", async () => {
    await act(() =>
      root.render(
        createElement(
          TranslationModeProvider,
          { key: "with-ja", languages, initialLanguages: ["ja"] },
          createElement(TranslationModeProbe),
        ),
      ),
    );
    expect(container.textContent).toBe("original|ja|en");

    await act(() =>
      root.render(
        createElement(
          TranslationModeProvider,
          { key: "without-translations", languages },
          createElement(TranslationModeProbe),
        ),
      ),
    );
    // 追加済みの言語が無いので、言語の項目はまだ 1 つも出さない。
    expect(container.textContent).toBe("original||ja,en");
  });

  it("adds a language from the dialog and offers only unadded ones", async () => {
    const onOpenChange = vi.fn();
    await act(() =>
      root.render(
        createElement(
          TranslationModeProvider,
          { languages, initialLanguages: ["ja"] },
          createElement(
            "div",
            null,
            createElement(TranslationModeProbe),
            createElement(TranslationLanguageDialog, {
              lang: "en",
              open: true,
              onOpenChange,
            }),
          ),
        ),
      ),
    );

    const labels = [...document.body.querySelectorAll("button")].map(
      (button) => button.textContent,
    );
    expect(labels).toContain("English");
    expect(labels).not.toContain("Japanese");
    expect(container.textContent).toBe("original|ja|en");

    await act(() =>
      [...document.body.querySelectorAll("button")]
        .find((button) => button.textContent === "English")!
        .click(),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(container.textContent).toBe("en|ja,en|");
  });
});
