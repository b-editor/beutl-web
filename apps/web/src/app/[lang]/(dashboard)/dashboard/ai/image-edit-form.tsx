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
  useMemo,
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
import { MAX_AI_IMAGE_UPLOAD_BYTES } from "@beutl/api";
import { editImageAction } from "./actions";
import { PromptLibrary, type PromptTemplate } from "./prompt-library";
import {
  AiAccessNotice,
  ModelSelect,
  AiWorkspace,
  DownloadButton,
  IDEMPOTENCY_KEY_FIELD,
  IdempotencyKeyField,
  fileFingerprint,
  keepModelForHeldRequest,
  requestSignature,
  useFileFingerprints,
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
  type AiScreenModel,
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
  userId,
  access,
}: {
  lang: string;
  userId: string;
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
  // task ごとのモデル。5 つの task は 5 つの操作で、それぞれ別のモデルを持つ
  // ——1 つしか覚えないと、別の task を見て戻ってきたときにモデルが変わり、
  // 出してある名前が指す支払い済みの依頼へ届かなくなる。
  const [modelByTask, setModelByTask] = useState<Record<string, string>>({});
  // その task で送ったことのあるモデル。同じ task の依頼が 2 つ未回収で残ること
  // があるので、いま選んでいる 1 つだけでは足りない——一覧から消えたほうへ戻れ
  // なくなり、その名前が指す支払い済みの結果に届かない。
  const [sentModelsByTask, setSentModelsByTask] =
    useState<Record<string, string[]>>({});
  // 送信ごとの名前。依頼ごとに持つので、A を回収している最中に B を送っても
  // どちらの名前も残る。
  const names = useAiRequestNames(userId, "image.edit");

  const [chosenExpansion, setChosenExpansion] = useState<string>("25");
  const [isPreparing, startPreparing] = useTransition();
  const [sourcePreview, setSourcePreview] = useState<string | null>(null);
  // 選ばれている絵の見分け。中身までは読まないが、名前・大きさ・更新時刻が
  // 変われば別の絵で、サーバーの指紋も変わる。
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  // 直前に広げた絵の名乗り。どの中身から広げたのかも一緒に覚えておく——画面が
  // 変わったら、その名乗りはもうこの画面のものではない。
  // 広げた絵での名乗りを、元の絵での名乗りから引けるようにしておく。二つ以上の
  // 依頼が同時に未回収になり得るので、一件だけ覚えていては足りない。
  const [preparedFor, setPreparedFor] = useState<Record<string, string>>({});
  // 選ばれた時に一度だけ読む。名前と大きさだけでは、中身の違う同名同サイズの絵が
  // 同じ依頼に見え、片方が走っている間もう片方を始められない。
  const sourceFiles = useMemo(
    () => (sourceFile ? [sourceFile] : []),
    [sourceFile],
  );
  const { contents: sourceContents, reading: readingSource } =
    useFileFingerprints(sourceFiles, MAX_AI_IMAGE_UPLOAD_BYTES);
  const sourceContent = sourceContents[0] ?? "";
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
  useEffect(() => {
    const restored = names.restoredModels();
    if (restored.length === 0 || editTask === "") return;
    setSentModelsByTask((current) => ({
      ...current,
      [editTask]: [...new Set([...(current[editTask] ?? []), ...restored])],
    }));
  }, [editTask, names]);
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
  // longer exists falls back to the new task's default — except while a request
  // built on it is still uncollected, which is what keeps that one on the list.
  const offered = editTask ? access.models[`image.edit.${editTask}`] ?? [] : [];
  const chosenModel = modelByTask[editTask] ?? "";
  const selected = EDIT_TASKS.find((entry) => entry.task === editTask) ?? null;
  // その依頼の署名。サーバーが指紋を取るのと同じものから作る——細かすぎれば、
  // サーバーには同じ依頼が別の名前で届いて二度課金され、粗すぎれば、別の依頼が
  // 同じ名前で届いて断られる。
  //
  // prompt は前後の空白を落としてから、そしてそれを取る task のときだけ数える
  // （outpaint の前置きは task と prompt から決まるので、この 2 つで足りる）。
  // 引き伸ばし幅は送る絵そのものに焼き込まれるので、絵の見分けと一緒に動く。
  const signatureWith = (model: string) =>
    requestSignature([
      editTask,
      model,
      selected?.needsPrompt ? typedPrompt.trim() : null,
      editTask === "outpaint" ? chosenExpansion : null,
      sourceFile,
      sourceContent,
    ]);
  // outpaint は送る直前に絵を広げ、その広げたあとの絵で名乗る。名前の有無を
  // 見るときも同じものを見ないと、回収できるはずの依頼で送信が閉じる。
  function holdsSignature(request: string): boolean {
    const prepared = preparedFor[request];
    return names.holds(request)
      || (prepared !== undefined && names.holds(prepared));
  }
  // 一覧から消えたモデルでも、そのモデルで出した依頼がまだ未回収なら名乗り
  // 続ける。既定へ落とすと依頼の形が変わり、サーバーは同じ名前の別の依頼として
  // 断る——支払い済みの結果へ戻る道が、そこで閉じる。
  const models = (sentModelsByTask[editTask] ?? [])
    .filter((id) =>
      !offered.some((entry) => entry.id === id)
      && (holdsSignature(signatureWith(id)) || names.hasRestoredModel(id)))
    .reduce(keepModelForHeldRequest, offered as AiScreenModel[]);
  const selectedModel = models.some((entry) => entry.id === chosenModel)
    ? chosenModel
    : defaultModelId(models);
  const signature = signatureWith(selectedModel);
  const holdsName = holdsSignature(signature);
  // 直前の失敗が名前を残していれば、残高で塞がない。支払い済みの結果を取りに
  // 行く道を閉じることになる。
  const submitBlocked = blocksSubmit(blocked, holdsName) || !names.ready;
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
    // 中身を読んでいる間は送らない。読み終える前に送ると、中身の分からないまま
    // 作った名前で課金され、読み終えた時点で名前が変わってしまう。
    busy: isPending || isPreparing || readingSource,
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

  // 送ったモデルを覚えておく。一覧から消えたあとに、その依頼をもう一度名乗る
  // には、どのモデルで出したのかがここに残っている必要がある。
  function rememberSentModel(model: string) {
    setModelByTask((current) => ({ ...current, [editTask]: model }));
    setSentModelsByTask((current) => {
      const sent = current[editTask] ?? [];
      return sent.includes(model)
        ? current
        : { ...current, [editTask]: [...sent, model] };
    });
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Pressing Enter in a field submits even while the button is disabled, so
    // everything the button refuses on is refused here too. Without this the
    // keyboard could start a run with no task, no plan, no balance for this
    // task, or no model that can serve it.
    if (!canSubmit) return;
    setPrepareError(null);
    const formData = new FormData(event.currentTarget);
    const file = formData.get("file");
    if (editTask === "outpaint" && file instanceof File && file.size > 0) {
      startPreparing(async () => {
        try {
          const prepared = await prepareOutpaintFile(
            file,
            Number(outpaintExpansion),
          );
          // 送るのは、押した時点の画面。広げているあいだに task や model、
          // 文章や元の絵が変えられても、いま作った絵と、いま名乗る名前と、
          // 本文の中身がばらばらになってはいけない——ばらばらなものを送れば、
          // 名前が指すのとは別の依頼が処理され、その名前ではもう戻れない。
          const next = formData;
          next.set("file", prepared);
          // サーバーが指紋にするのは、この広げたあとの絵。元の絵と広げ幅から
          // 名乗ると、別々の元絵と幅が同じ絵になったときに、同じ依頼が二つの
          // 名前に割れて二度課金される。
          rememberSentModel(selectedModel);
          const preparedSignature = requestSignature([
            editTask,
            selectedModel,
            typedPrompt.trim(),
            prepared,
            // 広げたあとの絵の中身。名前と大きさだけでは、同じ名前の元絵から
            // 作った別の絵が同じ名前になり、サーバーの指紋とは食い違ったまま
            // 断られ続ける——その名前は残るので、送り直しても抜け出せない。
            await fileFingerprint(prepared, MAX_AI_IMAGE_UPLOAD_BYTES),
          ]);
          const idempotencyKey = await names.acquireAndCommit(
            preparedSignature,
            selectedModel,
            null,
          );
          if (!idempotencyKey) return;
          setPreparedFor((current) => ({ ...current, [signature]: preparedSignature }));
          next.set(IDEMPOTENCY_KEY_FIELD, idempotencyKey);
          dispatch(next);
        } catch {
          // 元のファイルをそのまま送ると、拡張されていない画像を outpaint の
          // 料金で処理することになる。送らずに失敗として伝える。
          setPrepareError(t("dashboard:ai.outpaintPrepareFailed"));
        }
      });
      return;
    }

    const idempotencyKey = await names.acquireAndCommit(
      signature,
      selectedModel,
      null,
    );
    if (!idempotencyKey) return;
    formData.set(IDEMPOTENCY_KEY_FIELD, idempotencyKey);
    rememberSentModel(selectedModel);
    dispatch(formData);
  }

  function handleSourceChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    setSourceFile(file ?? null);
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
          onChange={(id) =>
            setModelByTask((current) => ({ ...current, [editTask]: id }))
          }
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
