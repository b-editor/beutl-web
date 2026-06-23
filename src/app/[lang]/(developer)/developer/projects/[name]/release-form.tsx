"use client";

import {
  useCallback,
  useState,
  useTransition,
} from "react";
import type { Package } from "./types";
import { Button } from "@/components/ui/button";
import { Edit, Loader2, Plus, Save } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { showOpenFileDialog } from "@/lib/fileDialog";
import SemVer from "semver";
import { createRelease, deleteRelease, updateRelease } from "./actions/release";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { isValidNuGetVersionRange } from "@/lib/nuget-version-range";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useTranslation } from "@/app/i18n/client";

export function ReleaseForm({
  pkg,
  lang,
}: { pkg: Package; lang: string }) {
  const [edit, setEdit] = useState(false);
  const [open, setOpen] = useState(false);
  const [deleteDialog, setDeleteDialog] = useState(false);
  const [saving, startSaveTransition] = useTransition();
  const [deleting, startDeleteTransition] = useTransition();
  const [creating, startCreateTransition] = useTransition();
  const [releases, setReleases] = useState(pkg.Release);
  const [release, setRelease] = useState<
    Package["Release"][number] | undefined
  >(releases?.[0]);
  const [title, setTitle] = useState(release?.title || "");
  const [file, setFile] = useState<File>();
  const [description, setDescription] = useState(release?.description || "");
  const [targetVersion, setTargetVersion] = useState({
    value: release?.targetVersion || "",
    message: "",
  });
  const [version, setVersion] = useState({ value: "", message: "" });
  const [published, setPublished] = useState(release?.published || false);
  const { toast } = useToast();
  const { t } = useTranslation(lang);

  const handleReset = useCallback(() => {
    setTitle(release?.title || "");
    setDescription(release?.description || "");
    setTargetVersion({ value: release?.targetVersion || "", message: "" });
    setPublished(release?.published || false);
    setFile(undefined);
  }, [release]);

  const handleSave = useCallback(async () => {
    if (!release) return;
    startSaveTransition(async () => {
      const formData = new FormData();
      if (file) {
        formData.append("file", file);
      }
      formData.append("id", release.id);
      formData.append("title", title);
      formData.append("description", description);
      formData.append("targetVersion", targetVersion.value);
      formData.append("published", published ? "on" : "off");
      const result = await updateRelease(formData);
      if (result.success) {
        const data: Package["Release"][number] | undefined = result.data;
        if (data) {
          setRelease(data);
          setReleases(releases.map((r) => (r.id === release.id ? data : r)));
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
    file,
    published,
    release,
    releases,
    t,
    targetVersion.value,
    title,
    toast,
  ]);

  const handleSelectFile = useCallback(async () => {
    const files = await showOpenFileDialog();
    const file = files?.[0];
    if (!file) {
      return;
    }
    setFile(file);
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
        const data: Package["Release"][number] = result.data!;
        setReleases((releases) =>
          [...releases, data].toSorted((a, b) =>
            new SemVer.SemVer(b.version).compare(a.version),
          ),
        );
        setRelease(data);
        setTitle(data.title);
        setDescription(data.description);
        setTargetVersion({ value: data.targetVersion, message: "" });
        setPublished(data.published);
        setFile(undefined);
        toast({
          variant: "default",
          title: t("developer:release.createSuccess"),
        });
        handleClose();
      } else {
        setVersion({ ...version, message: result.message || "" });
      }
    });
  }, [handleClose, pkg.id, version, t, toast]);

  const handleDelete = useCallback(() => {
    if (!release) return;
    startDeleteTransition(async () => {
      const result = await deleteRelease({ releaseId: release.id });
      if (result.success) {
        const filtered = releases.filter((r) => r.id !== release.id);
        setReleases(filtered);
        const data = filtered[0];
        setRelease(data);
        setTitle(data?.title || "");
        setDescription(data?.description || "");
        setTargetVersion({ value: data?.targetVersion || "", message: "" });
        setPublished(data?.published || false);
        setFile(undefined);
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
  }, [release, releases, t, toast]);

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
              onValueChange={(e) =>
                setRelease(releases.find((r) => r.id === e)!)
              }
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
        <p
          className="mt-4 whitespace-pre-wrap"
          style={{ wordWrap: "break-word" }}
        >
          {release ? (
            <>
              {release.title} <br />
              {release.description}
            </>
          ) : (
            <>{t("developer:release.noReleases")}</>
          )}
        </p>
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
          <Textarea
            id="release-description"
            placeholder={t("developer:release.description")}
            maxLength={1000}
            value={description}
            disabled={saving}
            onChange={(e) => setDescription(e.target.value)}
          />
          <Label className="mt-2" htmlFor="release-target-version">
            {t("developer:release.targetVersion")}
          </Label>
          <Input
            id="release-target-version"
            placeholder={t("developer:release.targetVersion")}
            value={targetVersion.value}
            disabled={saving}
            onChange={(e) =>
              setTargetVersion({
                value: e.target.value,
                message:
                  SemVer.valid(e.target.value) ||
                    isValidNuGetVersionRange(e.target.value)
                    ? ""
                    : t("developer:validation.versionIncorrect"),
              })
            }
          />
          {targetVersion.message && (
            <p className="text-sm text-red-300">{targetVersion.message}</p>
          )}
          <Label className="mt-2">
            {t("developer:release.packageFile")}
          </Label>
          <Button
            variant="outline"
            className="flex w-full justify-start"
            onClick={handleSelectFile}
            disabled={saving}
          >
            {file
              ? file.name
              : release?.file?.name
                ? release.file.name
                : t("developer:release.selectFile")}
          </Button>
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
                  message: SemVer.valid(e.target.value)
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
