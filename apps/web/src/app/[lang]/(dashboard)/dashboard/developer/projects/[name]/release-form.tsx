"use client";

import {
  useCallback,
  useState,
  useTransition,
} from "react";
import type { Package } from "./types";
import { Button } from "@beutl/ui/ui/button";
import { Edit, Loader2, Plus, Save } from "lucide-react";
import { Markdown } from "@beutl/ui/ui/markdown";
import { MarkdownEditor } from "@beutl/ui/ui/markdown-editor";
import { Input } from "@beutl/ui/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@beutl/ui/ui/select";
import { Label } from "@beutl/ui/ui/label";
import { Checkbox } from "@beutl/ui/ui/checkbox";
import { useToast } from "@beutl/ui/use-toast";
import { showOpenFileDialog } from "@/lib/fileDialog";
import { Info } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@beutl/ui/ui/popover";
import SemVer from "semver";
import { createRelease, deleteRelease, updateRelease } from "./actions/release";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@beutl/ui/ui/dialog";
import { compareNugetVersions, isValidNugetVersion } from "@beutl/core";
import { cn } from "@beutl/core";
import { isValidNuGetVersionRange } from "@beutl/core";
import { localizedReleaseDescription, pickTranslation } from "@beutl/core";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@beutl/ui/ui/alert-dialog";
import { useTranslation } from "@beutl/ui/i18n-client";
import { TargetVersionInput } from "./target-version-input";
import type { LanguageLabel } from "@/lib/language-labels";
import { useTranslationMode } from "./translation-mode";

// 保存アクションの応答は翻訳行を運ばない (行は別テーブル)。画面の state では
// その欠落を許し、読み出し時だけ翻訳行が付いてくる。
type Release = Package["Release"][number];
type ReleaseState = Omit<Release, "ReleaseTranslation"> & {
  ReleaseTranslation?: Release["ReleaseTranslation"];
};

function initialDescriptions(
  release: ReleaseState | undefined,
  languages: LanguageLabel[],
): Record<string, string> {
  const saved = new Map(
    (release?.ReleaseTranslation ?? []).map((translation) => [
      translation.lang,
      translation.description ?? "",
    ]),
  );
  return Object.fromEntries(
    languages.map((language) => [language.code, saved.get(language.code) ?? ""]),
  );
}

export function ReleaseForm({
  pkg,
  lang,
  languages,
  beutlVersions,
}: {
  pkg: Package;
  lang: string;
  languages: LanguageLabel[];
  beutlVersions: string[];
}) {
  const [edit, setEdit] = useState(false);
  const [open, setOpen] = useState(false);
  const [deleteDialog, setDeleteDialog] = useState(false);
  const [saving, startSaveTransition] = useTransition();
  const [deleting, startDeleteTransition] = useTransition();
  const [creating, startCreateTransition] = useTransition();
  const [releases, setReleases] = useState<ReleaseState[]>(pkg.Release);
  const [release, setRelease] = useState<ReleaseState | undefined>(
    releases?.[0],
  );
  const [title, setTitle] = useState(release?.title || "");
  const [files, setFiles] = useState<File[]>([]);
  const [description, setDescription] = useState(release?.description || "");
  const [translations, setTranslations] = useState<Record<string, string>>(
    () => initialDescriptions(release, languages),
  );
  const [targetVersion, setTargetVersion] = useState({
    value: release?.targetVersion || "",
    message: "",
  });
  const [version, setVersion] = useState({ value: "", message: "" });
  const [published, setPublished] = useState(release?.published || false);
  const { toast } = useToast();
  const { t } = useTranslation(lang);
  const { language: selectedLanguage } = useTranslationMode();
  const translationLanguage = languages.find(
    (language) => language.code === selectedLanguage,
  );
  const descriptionIsFallback =
    Boolean(selectedLanguage) &&
    !pickTranslation(release?.ReleaseTranslation, selectedLanguage ?? "")
      ?.description?.trim();

  // 選択中のリリースに属する入力一式を差し替える。翻訳の下書きもリリース
  // ごとなので、本体と一緒に切り替える。
  const selectRelease = useCallback(
    (selected: ReleaseState | undefined) => {
      setRelease(selected);
      setTitle(selected?.title || "");
      setDescription(selected?.description || "");
      setTranslations(initialDescriptions(selected, languages));
      setTargetVersion({ value: selected?.targetVersion || "", message: "" });
      setPublished(selected?.published || false);
      setFiles([]);
    },
    [languages],
  );

  const handleReset = useCallback(() => {
    setTitle(release?.title || "");
    setDescription(release?.description || "");
    setTranslations(initialDescriptions(release, languages));
    setTargetVersion({ value: release?.targetVersion || "", message: "" });
    setPublished(release?.published || false);
    setFiles([]);
  }, [release, languages]);

  const handleSave = useCallback(async () => {
    if (!release) return;
    startSaveTransition(async () => {
      const formData = new FormData();
      for (const f of files) {
        formData.append("file", f);
      }
      formData.append("id", release.id);
      formData.append("title", title);
      formData.append("description", description);
      formData.append(
        "translations",
        JSON.stringify(
          languages.map((language) => ({
            lang: language.code,
            description: translations[language.code] ?? "",
          })),
        ),
      );
      formData.append("targetVersion", pkg.audience === "DEVELOPMENT" ? "" : targetVersion.value);
      formData.append("published", published ? "on" : "off");
      const result = await updateRelease(formData);
      if (result.success) {
        const data: ReleaseState | undefined = result.data;
        if (data) {
          // 保存応答は翻訳行を持たないので、今保存した下書きで補って
          // プレビューが原文フォールバック表示に戻らないようにする。
          const merged: ReleaseState = {
            ...data,
            ReleaseTranslation: languages
              .map((language) => ({
                lang: language.code,
                description: translations[language.code] ?? "",
              }))
              .filter((translation) => translation.description.trim().length > 0),
          };
          setRelease(merged);
          setReleases(releases.map((r) => (r.id === release.id ? merged : r)));
        }
        toast({
          variant: "default",
          title: t("developer:release.saveSuccess"),
        });
        setEdit(false);
      } else {
        toast({
          variant: "destructive",
          title: t("developer:release.saveError"),
          description: result.message,
        });
      }
    });
  }, [
    description,
    files,
    published,
    release,
    releases,
    translations,
    languages,
    t,
    targetVersion.value,
    pkg.audience,
    title,
    toast,
  ]);

  const handleSelectFiles = useCallback(async () => {
    const files = await showOpenFileDialog({ multiple: true });
    if (files) {
      setFiles(Array.from(files));
    }
  }, []);

  const handleClose = useCallback(() => {
    setOpen(false);
    setVersion({ value: "", message: "" });
  }, []);

  const handleCreate = useCallback(() => {
    startCreateTransition(async () => {
      const result = await createRelease({
        packageId: pkg.id,
        version: version.value,
      });
      if (result.success) {
        const data: ReleaseState = result.data!;
        setReleases((releases) =>
          [...releases, data].toSorted((a, b) =>
            compareNugetVersions(b.version, a.version),
          ),
        );
        // 新規リリースに翻訳はまだ無いので、下書きも空から始める。
        selectRelease(data);
        toast({
          variant: "default",
          title: t("developer:release.createSuccess"),
        });
        handleClose();
      } else {
        setVersion({ ...version, message: result.message || "" });
      }
    });
  }, [handleClose, selectRelease, pkg.id, version, t, toast]);

  const handleDelete = useCallback(() => {
    if (!release) return;
    startDeleteTransition(async () => {
      const result = await deleteRelease({ releaseId: release.id });
      if (result.success) {
        const filtered = releases.filter((r) => r.id !== release.id);
        setReleases(filtered);
        selectRelease(filtered[0]);
        setEdit(false);
        toast({
          variant: "default",
          title: t("developer:release.deleteSuccess"),
        });
      } else {
        toast({
          variant: "destructive",
          title: t("developer:release.deleteError"),
          description: result.message,
        });
      }
    });
  }, [release, releases, selectRelease, t, toast]);

  return (
    <div>
      <div
        className={cn(
          "flex items-center mt-6 border-b pb-2 gap-2",
          !releases.length && "flex-col items-stretch",
        )}
      >
        {releases.length > 0 ? (
          <>
            <Select
              value={release?.id}
              disabled={edit}
              onValueChange={(e) => {
                const selected = releases.find((r) => r.id === e)!;
                selectRelease(selected);
              }}
            >
              <SelectTrigger className="font-bold text-xl border-none bg-transparent px-0 pr-3 flex-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {releases.map((release) => (
                  <SelectItem key={release.id} value={release.id}>
                    {release.version}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {!edit && (
              <>
                <Button
                  size="icon"
                  variant="ghost"
                  className="w-8 h-8"
                  onClick={() => setOpen(true)}
                >
                  <Plus className="w-4 h-4" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="w-8 h-8"
                  aria-label={t("developer:common.edit")}
                  onClick={() => setEdit(true)}
                >
                  <Edit className="w-4 h-4" />
                </Button>
              </>
            )}
          </>
        ) : (
          <Button onClick={() => setOpen(true)}>
            <Plus className="w-4 h-4 mr-2" />
            {t("developer:release.createRelease")}
          </Button>
        )}
      </div>
      {!edit && (
        <div className="mt-4">
          {release ? (
            <>
              <p className="mb-3 font-semibold break-words">{release.title}</p>
              <Markdown
                className={cn(
                  descriptionIsFallback && "text-muted-foreground",
                )}
              >
                {localizedReleaseDescription(
                  {
                    description: release.description,
                    ReleaseTranslation: release.ReleaseTranslation,
                  },
                  selectedLanguage ?? "",
                )}
              </Markdown>
            </>
          ) : (
            <>{t("developer:release.noReleases")}</>
          )}
        </div>
      )}
      {edit && release && (
        <div className="flex flex-col gap-2">
          <Label className="mt-2" htmlFor="release-title">
            {t("developer:release.title")}
          </Label>
          <Input
            id="release-title"
            placeholder={t("developer:release.title")}
            value={title}
            disabled={saving}
            onChange={(e) => setTitle(e.target.value)}
          />
          <Label className="mt-2" htmlFor="release-description">
            {t("developer:release.description")}
          </Label>
          <MarkdownEditor
            key={release.id}
            id="release-description"
            placeholder={
              pkg.audience === "USER" && translationLanguage
                ? description
                : t("developer:release.description")
            }
            maxLength={1000}
            value={
              pkg.audience === "USER" && translationLanguage
                ? translations[translationLanguage.code] ?? ""
                : description
            }
            disabled={saving}
            onChange={(e) => {
              if (pkg.audience === "USER" && translationLanguage) {
                const code = translationLanguage.code;
                setTranslations((current) => ({
                  ...current,
                  [code]: e.target.value,
                }));
              } else {
                setDescription(e.target.value);
              }
            }}
            labels={{
              write: t("developer:markdown.write"),
              preview: t("developer:markdown.preview"),
              hint: t("developer:markdown.hint"),
              emptyPreview: t("developer:markdown.emptyPreview"),
            }}
          />
          {pkg.audience === "USER" && <>
          <Label className="mt-2" htmlFor="release-target-version">
            {t("developer:release.targetVersion")}
          </Label>
          <TargetVersionInput
            id="release-target-version"
            lang={lang}
            versions={beutlVersions}
            placeholder={t("developer:release.targetVersion")}
            value={targetVersion.value}
            disabled={saving}
            onValueChange={(value) =>
              setTargetVersion({
                value,
                message:
                  SemVer.valid(value) ||
                    isValidNuGetVersionRange(value)
                    ? ""
                    : t("developer:validation.versionIncorrect"),
              })
            }
          />
          {targetVersion.message && (
            <p className="text-sm text-red-300">{targetVersion.message}</p>
          )}
          </>}
          <div className="flex items-center gap-2 mt-2">
            <Label htmlFor="release-package-file">
              {t("developer:release.packageFile")}
            </Label>
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="w-6 h-6"
                  aria-label={t(pkg.audience === "DEVELOPMENT" ? "developer:nuget.nupkgRequired" : "developer:release.packageFileHelp")}
                  disabled={saving}
                >
                  <Info className="w-4 h-4" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-80 text-sm">
                {t(pkg.audience === "DEVELOPMENT" ? "developer:nuget.nupkgRequired" : "developer:release.packageFileHelp")}
              </PopoverContent>
            </Popover>
          </div>
          <Button
            id="release-package-file"
            variant="outline"
            className="flex w-full justify-start"
            onClick={handleSelectFiles}
            disabled={saving || release.artifactLocked || release.published}
          >
            {t("developer:release.selectFiles")}
          </Button>
          {(release.artifactLocked || release.published) && <p className="text-sm text-muted-foreground">{t("developer:release.artifactLocked")}</p>}
          {files.length > 0 && (
            <p className="text-sm text-muted-foreground">
              {t("developer:upload.filesSelected", {
                count: files.length,
              })}
            </p>
          )}
          <div className="flex items-center space-x-2 mt-2">
            <Checkbox
              id="release-public"
              checked={published}
              onCheckedChange={(e) => setPublished(!!e)}
              disabled={saving}
            />
            <Label htmlFor="release-public">
              {t("developer:common.publish")}
            </Label>
          </div>
          <div className="flex gap-2 mt-4 flex-wrap justify-between">
            <div className="flex gap-2">
              <Button onClick={handleSave} disabled={saving || deleting}>
                {saving ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <Save className="w-4 h-4 mr-2" />
                )}
                {t("developer:common.save")}
              </Button>
              <Button
                variant="outline"
                disabled={saving || deleting}
                onClick={() => {
                  setEdit(false);
                  handleReset();
                }}
              >
                {t("developer:common.cancel")}
              </Button>
            </div>
            <Button
              variant="destructive"
              disabled={saving || deleting}
              onClick={() => setDeleteDialog(true)}
            >
              {t("developer:common.delete")}
            </Button>
          </div>
        </div>
      )}

      <Dialog open={open} onOpenChange={() => handleClose()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("developer:release.createRelease")}
            </DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-2 py-4">
            <Label className="mt-2" htmlFor="release-version">
              {t("developer:release.version")}
            </Label>
            <Input
              id="release-version"
              placeholder={t("developer:release.version")}
              disabled={creating}
              value={version.value}
              onChange={(e) =>
                setVersion({
                  value: e.target.value,
                  message: isValidNugetVersion(e.target.value)
                    ? ""
                    : t("developer:validation.versionIncorrect"),
                })
              }
            />
            {version.message && (
              <p className="text-sm text-red-300">{version.message}</p>
            )}
          </div>
          <DialogFooter>
            <Button disabled={creating} variant="outline" onClick={handleClose}>
              {t("developer:common.cancel")}
            </Button>
            <Button
              disabled={!!version.message || creating}
              onClick={handleCreate}
            >
              {creating && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              {t("developer:common.create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteDialog} onOpenChange={setDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("developer:common.confirmDeleteTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("developer:release.deleteDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t("developer:common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>
              {t("developer:common.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
