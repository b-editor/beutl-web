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
  ModelSelect,
  AiWorkspace,
  DownloadButton,
  IdempotencyKeyField,
  requestSignature,
  useAiRequestNames,
  ResultPanel,
  ResultShimmer,
  ShimmerImage,
  ResultPlaceholder,
  blockedReason,
  blocksSubmit,
  canSubmitAiRequest,
  downloadFromUrl,
  defaultModelId,
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
  const [chosenTask, setChosenTask] = useState<string>("");
  const [model, setModel] = useState("");
  // 送信ごとの名前。依頼ごとに持つので、A を回収している最中に B を送っても
  // どちらの名前も残る。
  const names = useAiRequestNames();
  // 直前の送信が名乗った task。カタログが動いてもモデルを動かさないために使う。
  const [sentRequest, setSentRequest] = useState<
    { task: string; model: string } | null
  >(null);
  const [chosenExpansion, setChosenExpansion] = useState<string>("25");
  const [isPreparing, startPreparing] = useTransition();
  const [sourcePreview, setSourcePreview] = useState<string | null>(null);
  const [comparisonMode, setComparisonMode] = useState<string>("result");
  const [typedPrompt, setTypedPrompt] = useState("");
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

  const keepsName =
    (state as { keepIdempotencyKey?: boolean }).keepIdempotencyKey === true;
  // 応答が届いたら、決着したかどうかでその名前を残すか手放すかを決める。
  useEffect(() => {
    names.settle(keepsName);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);
  const editTask = chosenTask;
  const outpaintExpansion = chosenExpansion;
  const editPrompt = typedPrompt;
  const blocked = blockedReason(
    access,
    EDIT_OPERATIONS,
    EDIT_OPERATIONS.every(
      (operation) => (access.models[operation] ?? []).length === 0,
    ),
  );
  // Each task is its own operation with its own models, so the list changes
  // under the picker. Rather than resetting it from an effect, a choice that no
  // longer exists falls back to the new task's default.
  const models = editTask ? access.models[`image.edit.${editTask}`] ?? [] : [];
  // カタログが動いてもモデルは動かさない。名前を持ったまま別のモデルで送ると、
  // サーバーは同じ名前の別の依頼として断り、支払い済みの結果へ戻る道が閉じる。
  const heldModel = keepsName && sentRequest?.task === editTask
    ? sentRequest.model
    : null;
  const selectedModel = heldModel ??
    (models.some((entry) => entry.id === model) ? model : defaultModelId(models));
  // その依頼の署名。中身が同じなら同じ名前で送り、書き換えたのなら別の名前で
  // 送る——同じ名前で別の依頼を送ると断られる。ファイルだけはここでは見られない
  // ので、差し替えられたときはサーバーの拒否で分かる（名前はそのまま残る）。
  const signature = requestSignature([
    editTask,
    selectedModel,
    typedPrompt,
    chosenExpansion,
  ]);
  const holdsName = names.holds(signature);
  // 直前の失敗が名前を残していれば、残高で塞がない。支払い済みの結果を取りに
  // 行く道を閉じることになる。
  const submitBlocked = blocksSubmit(blocked, holdsName);
  const selected = EDIT_TASKS.find((entry) => entry.task === editTask) ?? null;
  const taskUnaffordable =
    blocked === null &&
    editTask !== "" &&
    !holdsName &&
    !access.availability[`image.edit.${editTask}`];
  // 全 task を通した判定とは別に、選ばれている task だけモデルがゼロのことが
  // ある。そのまま送るとサーバーの既定モデルで必ず拒否されるので、ここで止める。
  const taskHasNoModel =
    editTask !== "" &&
    !holdsName &&
    (access.models[`image.edit.${editTask}`] ?? []).length === 0;
  // ボタンとキーボード送信で同じ答えを使う。片方だけを見ていると、入力欄で
  // Enter を押したときにボタンが断っているはずの依頼が出ていく。
  const canSubmit = canSubmitAiRequest({
    submitBlocked,
    hasTask: editTask !== "",
    taskUnaffordable,
    taskHasNoModel,
    busy: isPending || isPreparing,
  });

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
    // Pressing Enter in a field submits even while the button is disabled, so
    // everything the button refuses on is refused here too. Without this the
    // keyboard could start a run with no task, no plan, no balance for this
    // task, or no model that can serve it.
    if (!canSubmit) return;
    setSentRequest({ task: editTask, model: selectedModel });
    names.commit(signature);
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
    setTypedPrompt(template.prompt);
  }

  const form = (
    <Card>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4 p-6">
        <IdempotencyKeyField name={names.nameFor(signature)} />
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
            onValueChange={setChosenTask}
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
          {taskHasNoModel && (
            <p className="text-sm text-destructive">
              {t("dashboard:ai.operationUnavailableDescription")}
            </p>
          )}
        </div>

        <ModelSelect
          lang={lang}
          models={models}
          value={selectedModel}
          onChange={setModel}
          disabled={heldModel !== null}
        />

        {editTask === "outpaint" && (
          <div className="flex flex-col space-y-1.5">
            <Label>{t("dashboard:ai.outpaintExpansion")}</Label>
            <ToggleGroup
              type="single"
              variant="outline"
              value={outpaintExpansion}
              onValueChange={(next) => next && setChosenExpansion(next)}
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
                onChange={(event) => setTypedPrompt(event.target.value)}
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
          disabled={!canSubmit}
        >
          {t("dashboard:ai.edit")}
        </SubmitButton>
      </form>
    </Card>
  );

  // Before a run the right column previews the upload, so choosing a file gives
  // immediate feedback and the comparison lands in the place already holding
  // the source image.
  const result = isPending ? (
    <ResultShimmer label={t("dashboard:ai.processing")} />
  ) : state.success && state.url ? (
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
            <ShimmerImage
              src={sourcePreview}
              alt={t("dashboard:ai.sourcePreview")}
              className="w-full rounded-lg border"
            />
            <ShimmerImage
              src={state.url}
              alt={t("dashboard:ai.generated")}
              className="w-full rounded-lg border"
            />
          </div>
        ) : (
          <ShimmerImage
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
        <ShimmerImage
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
