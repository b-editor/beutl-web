"use client";

import { useTranslation } from "@beutl/ui/i18n-client";
import SubmitButton from "@beutl/ui/submit-button";
import { Alert, AlertDescription, AlertTitle } from "@beutl/ui/ui/alert";
import { Card } from "@beutl/ui/ui/card";
import { Input } from "@beutl/ui/ui/input";
import { Label } from "@beutl/ui/ui/label";
import { Textarea } from "@beutl/ui/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@beutl/ui/ui/toggle-group";
import {
  Eraser,
  Expand,
  Maximize2,
  Palette,
  Scissors,
  WandSparkles,
} from "lucide-react";
import {
  useActionState,
  useEffect,
  useState,
  useTransition,
  type ChangeEvent,
  type FormEvent,
} from "react";
import {
  AI_IMAGE_EDIT_TASKS,
  MAX_AI_PROMPT_LENGTH,
  aiImageEditTaskRequiresPrompt,
  type AiImageEditTask,
} from "@beutl/core";
import { editImageAction } from "./actions";
import { PromptLibrary, type PromptTemplate } from "./prompt-library";
import {
  AiAccessNotice,
  AiWorkspace,
  DownloadButton,
  IdempotencyKeyField,
  ResultPanel,
  ResultPlaceholder,
  blockedReason,
  downloadFromUrl,
  type AiAccess,
} from "./shared";

// Only the icon is a presentation choice; which tasks exist and which need a
// prompt come from the catalog the server validates against and the
// capabilities endpoint publishes.
const TASK_ICONS: Record<AiImageEditTask, typeof Eraser> = {
  remove_background: Eraser,
  upscale: Maximize2,
  restyle: Palette,
  remove_object: Scissors,
  outpaint: Expand,
};

const EDIT_TASKS = AI_IMAGE_EDIT_TASKS.map((task) => ({
  task,
  icon: TASK_ICONS[task],
  needsPrompt: aiImageEditTaskRequiresPrompt(task),
}));

const EDIT_OPERATIONS = EDIT_TASKS.map(({ task }) => `image.edit.${task}`);
const OUTPAINT_EXPANSIONS = [10, 25, 50] as const;

export function ImageEditForm({
  lang,
  access,
}: {
  lang: string;
  access: AiAccess;
}) {
  const { t } = useTranslation(lang);
  // Outpaint has to redraw the upload on a canvas before it can be sent, so this
  // form submits through onSubmit instead of `action={dispatch}`. That is also
  // why it reads `isPending` here: useFormStatus only reports a form that React
  // owns the submission of, so SubmitButton cannot disable itself on this one.
  const [state, dispatch, isPending] = useActionState(editImageAction, {
    success: false,
  });
  const [editTask, setEditTask] = useState<string>("");
  const [outpaintExpansion, setOutpaintExpansion] = useState<string>("25");
  const [isPreparing, startPreparing] = useTransition();
  const [sourcePreview, setSourcePreview] = useState<string | null>(null);
  const [comparisonMode, setComparisonMode] = useState<string>("result");
  const [editPrompt, setEditPrompt] = useState("");
  // Canvas preparation happens before the action runs, so its failure has no
  // action state to report through.
  const [prepareError, setPrepareError] = useState<string | null>(null);

  // The preview is an object URL owned by this component; leaving it behind on
  // unmount keeps the decoded image alive for the rest of the session.
  useEffect(() => {
    return () => {
      if (sourcePreview) URL.revokeObjectURL(sourcePreview);
    };
  }, [sourcePreview]);

  const blocked = blockedReason(access, EDIT_OPERATIONS);
  const selected = EDIT_TASKS.find((entry) => entry.task === editTask) ?? null;
  const taskUnaffordable =
    blocked === null &&
    editTask !== "" &&
    !access.availability[`image.edit.${editTask}`];

  async function prepareOutpaintFile(
    file: File,
    expansionPercent: number,
  ): Promise<File> {
    const bitmap = await createImageBitmap(file);
    const horizontal = Math.max(
      1,
      Math.round((bitmap.width * expansionPercent) / 100),
    );
    const vertical = Math.max(
      1,
      Math.round((bitmap.height * expansionPercent) / 100),
    );
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width + horizontal * 2;
    canvas.height = bitmap.height + vertical * 2;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Canvas 2D context is unavailable");
    }
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, horizontal, vertical);
    bitmap.close();
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (result) =>
          result ? resolve(result) : reject(new Error("PNG encoding failed")),
        "image/png",
      );
    });
    return new File([blob], file.name.replace(/\.\w+$/u, "") + ".png", {
      type: "image/png",
    });
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Pressing Enter in a field submits even while the button is disabled.
    if (isPending || isPreparing) return;
    setPrepareError(null);
    const form = event.currentTarget;
    const formData = new FormData(form);
    const file = formData.get("file");
    if (editTask === "outpaint" && file instanceof File && file.size > 0) {
      startPreparing(async () => {
        try {
          const prepared = await prepareOutpaintFile(
            file,
            Number(outpaintExpansion),
          );
          const next = new FormData(form);
          next.set("file", prepared);
          dispatch(next);
        } catch {
          // 元のファイルをそのまま送ると、拡張されていない画像を outpaint の
          // 料金で処理することになる。送らずに失敗として伝える。
          setPrepareError(t("dashboard:ai.outpaintPrepareFailed"));
        }
      });
      return;
    }
    dispatch(formData);
  }

  function handleSourceChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    setSourcePreview(file ? URL.createObjectURL(file) : null);
  }

  function applyTemplate(template: PromptTemplate) {
    setEditPrompt(template.prompt);
  }

  const form = (
    <Card>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4 p-6">
        <IdempotencyKeyField state={state} />
        <div className="flex flex-col space-y-1.5">
          <Label htmlFor="editFile">{t("dashboard:ai.image")}</Label>
          <Input
            id="editFile"
            name="file"
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            onChange={handleSourceChange}
            required
          />
        </div>

        {/* Which edit to run decides whether a prompt is required and what it
            costs, so it is a visible choice rather than an item in a list the
            user has to open. */}
        <div className="flex flex-col space-y-1.5">
          <Label>{t("dashboard:ai.task")}</Label>
          <ToggleGroup
            type="single"
            variant="outline"
            value={editTask}
            onValueChange={setEditTask}
            // One per row on a phone: at two columns the longest label
            // ("オブジェクト除去") is wider than the cell and truncates.
            className="grid grid-cols-1 gap-2 sm:grid-cols-2"
          >
            {EDIT_TASKS.map((entry) => (
              <ToggleGroupItem
                key={entry.task}
                value={entry.task}
                disabled={
                  blocked === null &&
                  !access.availability[`image.edit.${entry.task}`]
                }
                className="justify-start gap-2"
              >
                <entry.icon className="h-4 w-4 shrink-0" />
                <span className="truncate">
                  {t(`dashboard:ai.tasks.${entry.task}`)}
                </span>
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <input type="hidden" name="task" value={editTask} />
          {editTask === "" && (
            <p className="text-sm text-muted-foreground">
              {t("dashboard:ai.selectTask")}
            </p>
          )}
          {taskUnaffordable && (
            <p className="text-sm text-destructive">
              {t("dashboard:ai.balanceExhaustedDescription")}
            </p>
          )}
        </div>

        {editTask === "outpaint" && (
          <div className="flex flex-col space-y-1.5">
            <Label>{t("dashboard:ai.outpaintExpansion")}</Label>
            <ToggleGroup
              type="single"
              variant="outline"
              value={outpaintExpansion}
              onValueChange={(next) => next && setOutpaintExpansion(next)}
              className="grid grid-cols-3"
            >
              {OUTPAINT_EXPANSIONS.map((percent) => (
                <ToggleGroupItem key={percent} value={String(percent)}>
                  {percent}%
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <input
              type="hidden"
              name="outpaintExpansion"
              value={outpaintExpansion}
            />
          </div>
        )}

        {/* Only the tasks that take a prompt show one. Background removal and
            upscaling run on a fixed instruction, so anything typed here would
            be charged for and then discarded before the request is sent. */}
        {selected?.needsPrompt && (
          <>
            <PromptLibrary
              lang={lang}
              onApply={applyTemplate}
              currentDraft={() => ({ prompt: editPrompt })}
            />
            <div className="flex flex-col space-y-1.5">
              <div className="flex items-baseline justify-between gap-2">
                <Label htmlFor="editPrompt">{t("dashboard:ai.prompt")}</Label>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {editPrompt.length} / {MAX_AI_PROMPT_LENGTH}
                </span>
              </div>
              <Textarea
                id="editPrompt"
                name="prompt"
                maxLength={MAX_AI_PROMPT_LENGTH}
                required
                rows={3}
                placeholder={t(`dashboard:ai.taskHints.${selected.task}`)}
                value={editPrompt}
                onChange={(event) => setEditPrompt(event.target.value)}
              />
            </div>
          </>
        )}

        {(prepareError ?? state.message) && (
          <Alert variant="destructive">
            <AlertTitle>{t("error")}</AlertTitle>
            <AlertDescription>{prepareError ?? state.message}</AlertDescription>
          </Alert>
        )}

        <SubmitButton
          className="w-full"
          forceSpinner={isPreparing || isPending}
          disabled={
            blocked !== null ||
            editTask === "" ||
            taskUnaffordable ||
            isPreparing ||
            isPending
          }
        >
          {t("dashboard:ai.edit")}
        </SubmitButton>
      </form>
    </Card>
  );

  // Before a run the right column previews the upload, so choosing a file gives
  // immediate feedback and the comparison lands in the place already holding
  // the source image.
  const result =
    state.success && state.url ? (
      <ResultPanel
        title={t("dashboard:ai.generated")}
        actions={
          <DownloadButton
            label={t("dashboard:ai.download")}
            onDownload={() =>
              downloadFromUrl(state.url ?? "", state.fileName ?? "ai-image.png")
            }
          />
        }
      >
        {sourcePreview && (
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={comparisonMode}
            onValueChange={(next) => next && setComparisonMode(next)}
            className="justify-start"
          >
            <ToggleGroupItem value="result">
              {t("dashboard:ai.previewResult")}
            </ToggleGroupItem>
            <ToggleGroupItem value="original">
              {t("dashboard:ai.previewOriginal")}
            </ToggleGroupItem>
            <ToggleGroupItem value="side_by_side">
              {t("dashboard:ai.previewSideBySide")}
            </ToggleGroupItem>
          </ToggleGroup>
        )}
        {comparisonMode === "side_by_side" && sourcePreview ? (
          <div className="grid gap-2 sm:grid-cols-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={sourcePreview}
              alt={t("dashboard:ai.sourcePreview")}
              className="w-full rounded-lg border"
            />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={state.url}
              alt={t("dashboard:ai.generated")}
              className="w-full rounded-lg border"
            />
          </div>
        ) : (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={
              comparisonMode === "original" && sourcePreview
                ? sourcePreview
                : state.url
            }
            alt={
              comparisonMode === "original"
                ? t("dashboard:ai.sourcePreview")
                : t("dashboard:ai.generated")
            }
            className="w-full rounded-lg border"
          />
        )}
      </ResultPanel>
    ) : sourcePreview ? (
      <ResultPanel title={t("dashboard:ai.sourcePreview")}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={sourcePreview}
          alt={t("dashboard:ai.sourcePreview")}
          className="w-full rounded-lg border"
        />
      </ResultPanel>
    ) : (
      <ResultPlaceholder
        icon={WandSparkles}
        label={t("dashboard:ai.resultPlaceholderEdit")}
      />
    );

  return (
    <div className="flex flex-col gap-4">
      {blocked && <AiAccessNotice lang={lang} reason={blocked} />}
      <AiWorkspace form={form} result={result} />
    </div>
  );
}
