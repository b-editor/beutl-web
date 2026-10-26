// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "../../apps/web/node_modules/react";
import { createRoot, type Root } from "../../apps/web/node_modules/react-dom/client";

vi.mock("@beutl/ui/i18n-client", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@beutl/ui/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/lib/fileDialog", () => ({ showOpenFileDialog: vi.fn() }));
vi.mock("@/lib/storage-upload", () => ({ uploadStorageFile: vi.fn(), resumeStorageUploadCompletion: vi.fn() }));
vi.mock("../../apps/web/src/app/[lang]/(dashboard)/dashboard/developer/projects/[name]/actions/release", () => ({
  createRelease: vi.fn(), deleteRelease: vi.fn(), updateRelease: vi.fn(), discardReleaseUpload: vi.fn(),
}));
import { showOpenFileDialog } from "@/lib/fileDialog";
import { resumeStorageUploadCompletion, uploadStorageFile } from "@/lib/storage-upload";
import { discardReleaseUpload, updateRelease } from "../../apps/web/src/app/[lang]/(dashboard)/dashboard/developer/projects/[name]/actions/release";
import { ReleaseForm } from "../../apps/web/src/app/[lang]/(dashboard)/dashboard/developer/projects/[name]/release-form";
import { TranslationModeProvider } from "../../apps/web/src/app/[lang]/(dashboard)/dashboard/developer/projects/[name]/translation-mode";

const release = { id: "release", version: "2.0.0", title: "Release", description: "Notes", targetVersion: "2.0.0",
  published: false, artifactLocked: false, ReleaseTranslation: [] };
const file = new File(["package"], "package.nupkg");
const uploaded = { ok: true, file: { id: "file-1", name: file.name, size: file.size } } as const;

describe("release multipart upload lifecycle", () => {
  let container: HTMLDivElement;
  let root: Root;
  const button = (key: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === key)!;
  const save = () => act(() => button("developer:common.save").click());
  const selectFile = () => act(() => container.querySelector<HTMLButtonElement>("#release-package-file")!.click());

  beforeEach(async () => {
    vi.resetAllMocks(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.mocked(showOpenFileDialog).mockResolvedValue([file] as never);
    vi.mocked(uploadStorageFile).mockResolvedValue(uploaded);
    vi.mocked(discardReleaseUpload).mockResolvedValue(undefined);
    vi.mocked(updateRelease).mockResolvedValue({ success: false, message: "invalidInput" });
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    await act(() => root.render(createElement(TranslationModeProvider, { languages: [] }, createElement(ReleaseForm, {
      pkg: { id: "pkg", name: "Package", audience: "DEVELOPMENT", Release: [release] } as never,
      lang: "en", languages: [], beutlVersions: [], ownerId: "owner",
    }))));
    await act(() => container.querySelector<HTMLButtonElement>('[aria-label="developer:common.edit"]')!.click());
    await selectFile();
  });
  afterEach(async () => {
    await act(() => root.unmount()); container.remove(); vi.unstubAllGlobals();
  });

  it("reuses an uploaded file after a validation error and clears it after successful publication", async () => {
    await save();
    await act(() => {
      const input = container.querySelector<HTMLInputElement>("#release-title")!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Corrected title");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    vi.mocked(updateRelease).mockResolvedValue({ success: true, data: { ...release, published: true, artifactLocked: true } } as never);
    await save();
    expect(uploadStorageFile).toHaveBeenCalledExactlyOnceWith(file, { ownerId: "owner" });
    expect(vi.mocked(updateRelease).mock.calls.map(([form]) => form.get("uploadedFileId"))).toEqual(["file-1", "file-1"]);
    await act(() => container.querySelector<HTMLButtonElement>('[aria-label="developer:common.edit"]')!.click());
    await save();
    expect(updateRelease).toHaveBeenCalledTimes(3);
    expect(vi.mocked(updateRelease).mock.calls[2][0].has("uploadedFileId")).toBe(false);
    expect(discardReleaseUpload).not.toHaveBeenCalled();
  });

  it.each(["cancel", "replace"])("discards the abandoned upload on %s without reusing it", async (operation) => {
    await save();
    if (operation === "cancel") {
      await act(() => button("developer:common.cancel").click());
      await act(() => container.querySelector<HTMLButtonElement>('[aria-label="developer:common.edit"]')!.click());
      await save();
      expect(vi.mocked(updateRelease).mock.calls[1][0].has("uploadedFileId")).toBe(false);
    } else {
      const replacement = new File(["replacement"], "replacement.nupkg");
      vi.mocked(showOpenFileDialog).mockResolvedValue([replacement] as never);
      vi.mocked(uploadStorageFile).mockResolvedValue({ ok: true, file: { id: "file-2", name: replacement.name, size: replacement.size } });
      await selectFile(); await save();
      expect(uploadStorageFile).toHaveBeenLastCalledWith(replacement, { ownerId: "owner" });
      expect(vi.mocked(updateRelease).mock.calls[1][0].get("uploadedFileId")).toBe("file-2");
    }
    expect(discardReleaseUpload).toHaveBeenCalledExactlyOnceWith("file-1");
  });

  it("resumes an uncertain completion instead of uploading another copy", async () => {
    const pendingCompletion = { uploadId: "pending", ownerId: "owner", body: "{}" };
    vi.mocked(uploadStorageFile).mockResolvedValueOnce({ ok: false, errorCode: "uploadFailed", pendingCompletion });
    vi.mocked(resumeStorageUploadCompletion).mockResolvedValue(uploaded);
    await save(); expect(updateRelease).not.toHaveBeenCalled();
    await save();
    expect(uploadStorageFile).toHaveBeenCalledTimes(1);
    expect(resumeStorageUploadCompletion).toHaveBeenCalledExactlyOnceWith(pendingCompletion);
    expect(vi.mocked(updateRelease).mock.calls[0][0].get("uploadedFileId")).toBe("file-1");
  });
});
