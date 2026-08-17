"use client";

import {
  useActionState,
  useEffect,
  useTransition,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";
import { useTranslation } from "@beutl/ui/i18n-client";
import { Button } from "@beutl/ui/ui/button";
import { Input } from "@beutl/ui/ui/input";
import { Label } from "@beutl/ui/ui/label";
import { Textarea } from "@beutl/ui/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@beutl/ui/ui/select";
import { Separator } from "@beutl/ui/ui/separator";
import { Progress } from "@beutl/ui/ui/progress";
import { Alert, AlertDescription, AlertTitle } from "@beutl/ui/ui/alert";
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
import SubmitButton from "@beutl/ui/submit-button";
import Link from "next/link";
import {
  AudioLines,
  Clapperboard,
  History,
  Image as ImageIcon,
  Languages,
  WandSparkles,
} from "lucide-react";
import {
  createVideoAction,
  deleteJobAction,
  editImageAction,
  generateImageAction,
  listJobsAction,
  refreshVideoJobAction,
  retryJobAction,
  transcribeAction,
  translateAction,
} from "./actions";

const imageSizes = ["1024x1024", "1024x1536", "1536x1024"] as const;
const editTasks = [
  "remove_background",
  "upscale",
  "restyle",
  "remove_object",
  "outpaint",
] as const;
const videoDurations = [4, 6, 8] as const;
const outpaintExpansions = [10, 25, 50] as const;

type PromptTemplate = {
  id: string;
  name: string;
  prompt: string;
  style?: string;
  composition?: string;
  motion?: string;
  exclusions?: string;
  pinned: boolean;
};

const PROMPT_LIBRARY_KEY = "beutl:ai:prompt-library";

function loadPromptLibrary(): PromptTemplate[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(PROMPT_LIBRARY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as PromptTemplate[]) : [];
  } catch {
    return [];
  }
}

function savePromptLibrary(templates: PromptTemplate[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PROMPT_LIBRARY_KEY, JSON.stringify(templates));
  } catch {
    // ストレージが利用できない環境では保存を諦める。
  }
}

export function PromptLibrary({
  lang,
  onApply,
}: {
  lang: string;
  onApply: (template: PromptTemplate) => void;
}) {
  const { t } = useTranslation(lang);
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [name, setName] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setTemplates(loadPromptLibrary());
  }, []);

  function persist(next: PromptTemplate[]) {
    setTemplates(next);
    savePromptLibrary(next);
  }

  function applySelected() {
    const template = templates.find((item) => item.id === selectedId);
    if (!template) return;
    onApply(template);
  }

  function togglePin(id: string) {
    persist(
      templates.map((item) =>
        item.id === id ? { ...item, pinned: !item.pinned } : item,
      ),
    );
  }

  function remove(id: string) {
    persist(templates.filter((item) => item.id !== id));
    if (selectedId === id) {
      setSelectedId("");
    }
  }

  function saveTemplate() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError(t("dashboard:ai.promptTemplateNameRequired"));
      return;
    }
    setError(null);
    const template: PromptTemplate = {
      id: crypto.randomUUID(),
      name: trimmed,
      prompt: "",
      pinned: false,
    };
    persist([template, ...templates]);
    setSelectedId(template.id);
    setName("");
  }

  const sorted = [...templates].sort(
    (left, right) => Number(right.pinned) - Number(left.pinned),
  );

  return (
    <div className="flex flex-col gap-3 rounded-lg border p-4">
      <p className="text-sm text-muted-foreground">
        {t("dashboard:ai.promptLibraryDescription")}
      </p>
      <div className="flex items-center gap-2">
        <Select value={selectedId} onValueChange={setSelectedId}>
          <SelectTrigger className="flex-1">
            <SelectValue placeholder={t("dashboard:ai.promptLibrary")} />
          </SelectTrigger>
          <SelectContent>
            {sorted.map((item) => (
              <SelectItem key={item.id} value={item.id}>
                {item.pinned ? "📌 " : ""}
                {item.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!selectedId}
          onClick={applySelected}
        >
          {t("dashboard:ai.promptApply")}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!selectedId}
          onClick={() => togglePin(selectedId)}
        >
          {t("dashboard:ai.promptPin")}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!selectedId}
          onClick={() => remove(selectedId)}
        >
          {t("dashboard:ai.delete")}
        </Button>
      </div>
      <div className="flex items-center gap-2">
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={t("dashboard:ai.promptTemplateName")}
        />
        <Button type="button" variant="outline" size="sm" onClick={saveTemplate}>
          {t("dashboard:ai.promptSaveTemplate")}
        </Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

export function AiPageHeader({
  lang,
  title,
  description,
}: {
  lang: string;
  title: string;
  description: string;
}) {
  const { t } = useTranslation(lang);
  return (
    <div>
      <Link
        href={`/${lang}/dashboard/ai`}
        className="text-sm text-muted-foreground hover:text-foreground"
      >
        ← {t("dashboard:ai.backToAi")}
      </Link>
      <h1 className="mt-2 text-2xl font-bold">{title}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{description}</p>
    </div>
  );
}

export function AiFeatureLinks({
  lang,
  canUseAi,
  usagePercent,
  remainingPercent,
  additionalCredits,
}: {
  lang: string;
  canUseAi: boolean;
  usagePercent: number;
  remainingPercent: number;
  additionalCredits: number;
}) {
  const { t } = useTranslation(lang);
  const features = [
    {
      href: `/${lang}/dashboard/ai/generate`,
      title: t("dashboard:ai.imageGeneration"),
      description: t("dashboard:ai.imageGenerationDescription"),
      icon: ImageIcon,
    },
    {
      href: `/${lang}/dashboard/ai/edit`,
      title: t("dashboard:ai.imageEdit"),
      description: t("dashboard:ai.imageEditDescription"),
      icon: WandSparkles,
    },
    {
      href: `/${lang}/dashboard/ai/transcribe`,
      title: t("dashboard:ai.transcription"),
      description: t("dashboard:ai.transcriptionDescription"),
      icon: AudioLines,
    },
    {
      href: `/${lang}/dashboard/ai/translate`,
      title: t("dashboard:ai.translation"),
      description: t("dashboard:ai.translationDescription"),
      icon: Languages,
    },
    {
      href: `/${lang}/dashboard/ai/video`,
      title: t("dashboard:ai.videoGeneration"),
      description: t("dashboard:ai.videoGenerationDescription"),
      icon: Clapperboard,
    },
    {
      href: `/${lang}/dashboard/ai/jobs`,
      title: t("dashboard:ai.jobHistory"),
      description: t("dashboard:ai.jobHistoryDescription"),
      icon: History,
    },
  ] as const;

  return (
    <div className="flex flex-col gap-6">
      <UsageCard
        lang={lang}
        usagePercent={usagePercent}
        remainingPercent={remainingPercent}
        additionalCredits={additionalCredits}
      />
      {!canUseAi && (
        <div className="rounded-lg border bg-card p-6 text-card-foreground">
          <p className="text-sm text-muted-foreground">
            {t("dashboard:ai.planRequired")}
          </p>
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        {features.map((feature) => (
          <Link
            key={feature.href}
            href={feature.href}
            className="flex flex-col gap-3 rounded-lg border bg-card p-6 text-card-foreground transition-colors hover:bg-accent/50"
          >
            <feature.icon className="h-6 w-6 shrink-0 text-muted-foreground" />
            <div>
              <p className="font-bold">{feature.title}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {feature.description}
              </p>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}

export function UsageCard({
  lang,
  usagePercent,
  remainingPercent,
  additionalCredits,
}: {
  lang: string;
  usagePercent: number;
  remainingPercent: number;
  additionalCredits: number;
}) {
  const { t } = useTranslation(lang);
  return (
    <div className="rounded-lg border bg-card p-6 text-card-foreground">
      <div className="flex items-baseline justify-between gap-4">
        <p className="text-sm text-muted-foreground">
          {t("dashboard:ai.monthlyUsage")}
        </p>
        <p className="font-bold text-2xl">{usagePercent}%</p>
      </div>
      <Progress className="mt-2" value={usagePercent} max={100} />
      <p className="mt-2 text-sm text-muted-foreground">
        {t("account:aiPlan.monthlyUsageHint", { percent: remainingPercent })}
      </p>
      {additionalCredits > 0 && (
        <p className="mt-1 text-sm text-muted-foreground">
          {t("account:aiPlan.additionalCredits")}:{" "}
          {additionalCredits.toLocaleString(lang === "ja" ? "ja-JP" : "en-US")}
        </p>
      )}
    </div>
  );
}

function PlanRequired({ lang }: { lang: string }) {
  const { t } = useTranslation(lang);
  return (
    <div className="rounded-lg border bg-card p-6 text-card-foreground">
      <p className="text-sm text-muted-foreground">
        {t("dashboard:ai.planRequired")}
      </p>
    </div>
  );
}

export function ImageGenerateForm({
  lang,
  canUseAi,
}: {
  lang: string;
  canUseAi: boolean;
}) {
  const { t } = useTranslation(lang);
  const [state, dispatch] = useActionState(generateImageAction, {
    success: false,
  });
  const [prompt, setPrompt] = useState("");
  const [style, setStyle] = useState("");
  const [composition, setComposition] = useState("");
  const [exclusions, setExclusions] = useState("");
  if (!canUseAi) {
    return <PlanRequired lang={lang} />;
  }

  function applyTemplate(template: PromptTemplate) {
    setPrompt(template.prompt);
    setStyle(template.style ?? "");
    setComposition(template.composition ?? "");
    setExclusions(template.exclusions ?? "");
  }

  return (
    <div className="rounded-lg border text-card-foreground">
      <form action={dispatch} className="flex flex-col gap-4 p-6">
        <PromptLibrary lang={lang} onApply={applyTemplate} />
        <div className="flex flex-col space-y-1.5">
          <Label htmlFor="generatePrompt">{t("dashboard:ai.prompt")}</Label>
          <Textarea
            id="generatePrompt"
            name="prompt"
            maxLength={4000}
            required
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
          />
        </div>
        <div className="flex flex-col space-y-1.5">
          <Label htmlFor="generateStyle">{t("dashboard:ai.promptStyle")}</Label>
          <Input
            id="generateStyle"
            name="style"
            maxLength={1000}
            value={style}
            onChange={(event) => setStyle(event.target.value)}
          />
        </div>
        <div className="flex flex-col space-y-1.5">
          <Label htmlFor="generateComposition">
            {t("dashboard:ai.promptComposition")}
          </Label>
          <Input
            id="generateComposition"
            name="composition"
            maxLength={1000}
            value={composition}
            onChange={(event) => setComposition(event.target.value)}
          />
        </div>
        <div className="flex flex-col space-y-1.5">
          <Label htmlFor="generateExclusions">
            {t("dashboard:ai.promptAvoid")}
          </Label>
          <Input
            id="generateExclusions"
            name="exclusions"
            maxLength={1000}
            value={exclusions}
            onChange={(event) => setExclusions(event.target.value)}
          />
        </div>
        <div className="flex flex-col space-y-1.5 max-w-xs">
          <Label htmlFor="generateSize">{t("dashboard:ai.size")}</Label>
          <Select name="size" defaultValue="1024x1024">
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {imageSizes.map((size) => (
                <SelectItem key={size} value={size}>
                  {size}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {state.message && (
          <Alert variant="destructive">
            <AlertTitle>{t("error")}</AlertTitle>
            <AlertDescription>{state.message}</AlertDescription>
          </Alert>
        )}
        {state.success && state.url && (
          <div className="flex flex-col gap-2">
            <Alert>
              <AlertTitle>{t("success")}</AlertTitle>
              <AlertDescription>{t("dashboard:ai.generated")}</AlertDescription>
            </Alert>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={state.url}
              alt={t("dashboard:ai.generated")}
              className="max-w-sm rounded-lg border"
            />
          </div>
        )}
        <SubmitButton className="self-start">
          {t("dashboard:ai.generate")}
        </SubmitButton>
      </form>
    </div>
  );
}

export function ImageEditForm({
  lang,
  canUseAi,
}: {
  lang: string;
  canUseAi: boolean;
}) {
  const { t } = useTranslation(lang);
  const [state, dispatch] = useActionState(editImageAction, { success: false });
  const [editTask, setEditTask] = useState<string>("");
  const [outpaintExpansion, setOutpaintExpansion] = useState<string>("25");
  const [isPreparing, startPreparing] = useTransition();
  const [sourcePreview, setSourcePreview] = useState<string | null>(null);
  const [comparisonMode, setComparisonMode] = useState<string>("result");
  const [editPrompt, setEditPrompt] = useState("");
  if (!canUseAi) {
    return <PlanRequired lang={lang} />;
  }

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
          // 変換失敗時は元のファイルのまま送信する。
          dispatch(formData);
        }
      });
      return;
    }
    dispatch(formData);
  }

  function handleSourceChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (sourcePreview) {
      URL.revokeObjectURL(sourcePreview);
    }
    setSourcePreview(file ? URL.createObjectURL(file) : null);
  }

  function applyTemplate(template: PromptTemplate) {
    setEditPrompt(template.prompt);
  }

  return (
    <div className="rounded-lg border text-card-foreground">
      <form onSubmit={handleSubmit} className="flex flex-col gap-4 p-6">
        <PromptLibrary lang={lang} onApply={applyTemplate} />
        <div className="flex flex-col space-y-1.5 max-w-xs">
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
        {sourcePreview && (
          <div className="flex flex-col gap-2">
            <Label>{t("dashboard:ai.sourcePreview")}</Label>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={sourcePreview}
              alt={t("dashboard:ai.sourcePreview")}
              className="max-w-sm rounded-lg border"
            />
          </div>
        )}
        <div className="flex flex-col space-y-1.5 max-w-xs">
          <Label htmlFor="editTask">{t("dashboard:ai.task")}</Label>
          <Select value={editTask} onValueChange={setEditTask}>
            <SelectTrigger>
              <SelectValue placeholder={t("dashboard:ai.selectTask")} />
            </SelectTrigger>
            <SelectContent>
              {editTasks.map((task) => (
                <SelectItem key={task} value={task}>
                  {t(`dashboard:ai.tasks.${task}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <input type="hidden" name="task" value={editTask} />
        </div>
        {editTask === "outpaint" && (
          <div className="flex flex-col space-y-1.5 max-w-xs">
            <Label htmlFor="outpaintExpansion">
              {t("dashboard:ai.outpaintExpansion")}
            </Label>
            <Select
              value={outpaintExpansion}
              onValueChange={setOutpaintExpansion}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {outpaintExpansions.map((percent) => (
                  <SelectItem key={percent} value={String(percent)}>
                    {percent}%
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <input
              type="hidden"
              name="outpaintExpansion"
              value={outpaintExpansion}
            />
          </div>
        )}
        <div className="flex flex-col space-y-1.5">
          <Label htmlFor="editPrompt">{t("dashboard:ai.prompt")}</Label>
          <Textarea
            id="editPrompt"
            name="prompt"
            maxLength={4000}
            value={editPrompt}
            onChange={(event) => setEditPrompt(event.target.value)}
          />
        </div>
        {state.message && (
          <Alert variant="destructive">
            <AlertTitle>{t("error")}</AlertTitle>
            <AlertDescription>{state.message}</AlertDescription>
          </Alert>
        )}
        {state.success && state.url && (
          <div className="flex flex-col gap-2">
            <Alert>
              <AlertTitle>{t("success")}</AlertTitle>
              <AlertDescription>{t("dashboard:ai.generated")}</AlertDescription>
            </Alert>
            {sourcePreview && (
              <div className="flex flex-col space-y-1.5 max-w-xs">
                <Label htmlFor="comparisonMode">
                  {t("dashboard:ai.previewMode")}
                </Label>
                <Select
                  value={comparisonMode}
                  onValueChange={setComparisonMode}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="result">
                      {t("dashboard:ai.previewResult")}
                    </SelectItem>
                    <SelectItem value="original">
                      {t("dashboard:ai.previewOriginal")}
                    </SelectItem>
                    <SelectItem value="side_by_side">
                      {t("dashboard:ai.previewSideBySide")}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
            {comparisonMode === "result" && (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={state.url}
                alt={t("dashboard:ai.generated")}
                className="max-w-sm rounded-lg border"
              />
            )}
            {comparisonMode === "original" && sourcePreview && (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={sourcePreview}
                alt={t("dashboard:ai.sourcePreview")}
                className="max-w-sm rounded-lg border"
              />
            )}
            {comparisonMode === "side_by_side" && sourcePreview && (
              <div className="flex flex-wrap gap-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={sourcePreview}
                  alt={t("dashboard:ai.sourcePreview")}
                  className="max-w-[45%] rounded-lg border"
                />
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={state.url}
                  alt={t("dashboard:ai.generated")}
                  className="max-w-[45%] rounded-lg border"
                />
              </div>
            )}
          </div>
        )}
        <SubmitButton className="self-start" disabled={isPreparing}>
          {t("dashboard:ai.edit")}
        </SubmitButton>
      </form>
    </div>
  );
}

export function TranscribeForm({
  lang,
  canUseAi,
}: {
  lang: string;
  canUseAi: boolean;
}) {
  const { t } = useTranslation(lang);
  const [state, dispatch] = useActionState(transcribeAction, { success: false });
  const [segments, setSegments] = useState<
    Array<{ start: number; end: number; text: string }>
  >([]);
  const [maxLineLength, setMaxLineLength] = useState<string>("42");
  const [maxLineCount, setMaxLineCount] = useState<string>("2");
  if (!canUseAi) {
    return <PlanRequired lang={lang} />;
  }

  function formatTime(seconds: number): string {
    const minutes = Math.floor(seconds / 60);
    const rest = seconds - minutes * 60;
    return `${String(minutes).padStart(2, "0")}:${rest.toFixed(2).padStart(5, "0")}`;
  }

  function updateSegment(
    index: number,
    patch: Partial<{ start: number; end: number; text: string }>,
  ) {
    setSegments((current) =>
      current.map((segment, i) => (i === index ? { ...segment, ...patch } : segment)),
    );
  }

  function removeSegment(index: number) {
    setSegments((current) => current.filter((_, i) => i !== index));
  }

  function addSegment() {
    const last = segments.at(-1);
    setSegments((current) => [
      ...current,
      {
        start: last?.end ?? 0,
        end: (last?.end ?? 0) + 1,
        text: "",
      },
    ]);
  }

  function splitSegment(index: number) {
    setSegments((current) => {
      const segment = current[index];
      if (!segment) return current;
      const midpoint = (segment.start + segment.end) / 2;
      return [
        ...current.slice(0, index),
        { ...segment, end: midpoint },
        { start: midpoint, end: segment.end, text: "" },
        ...current.slice(index + 1),
      ];
    });
  }

  function mergeSegments(index: number) {
    setSegments((current) => {
      if (index + 1 >= current.length) return current;
      const merged = {
        start: current[index].start,
        end: current[index + 1].end,
        text: `${current[index].text} ${current[index + 1].text}`.trim(),
      };
      return [
        ...current.slice(0, index),
        merged,
        ...current.slice(index + 2),
      ];
    });
  }

  function wrapSegments() {
    const lengthLimit = Math.max(1, Number(maxLineLength) || 42);
    const countLimit = Math.max(1, Number(maxLineCount) || 2);
    setSegments((current) =>
      current.map((segment) => {
        const lines: string[] = [];
        for (const line of segment.text.split("\n")) {
          let remaining = line;
          while (remaining.length > lengthLimit) {
            let breakAt = remaining.lastIndexOf(" ", lengthLimit);
            if (breakAt <= 0) {
              breakAt = lengthLimit;
            }
            lines.push(remaining.slice(0, breakAt).trim());
            remaining = remaining.slice(breakAt).trim();
          }
          if (remaining) {
            lines.push(remaining);
          }
        }
        return {
          ...segment,
          text: lines.slice(0, countLimit).join("\n"),
        };
      }),
    );
  }

  return (
    <div className="rounded-lg border text-card-foreground">
      <form action={dispatch} className="flex flex-col gap-4 p-6">
        <div className="flex flex-col space-y-1.5 max-w-xs">
          <Label htmlFor="transcribeFile">{t("dashboard:ai.audio")}</Label>
          <Input
            id="transcribeFile"
            name="file"
            type="file"
            accept="audio/*"
            required
          />
        </div>
        <div className="flex flex-col space-y-1.5 max-w-xs">
          <Label htmlFor="transcribeLanguage">
            {t("dashboard:ai.language")}
          </Label>
          <Input id="transcribeLanguage" name="language" placeholder="ja" />
        </div>
        {state.message && (
          <Alert variant="destructive">
            <AlertTitle>{t("error")}</AlertTitle>
            <AlertDescription>{state.message}</AlertDescription>
          </Alert>
        )}
        {state.success && (
          <Alert>
            <AlertTitle>{t("success")}</AlertTitle>
            <AlertDescription>
              {t("dashboard:ai.transcriptionDone")}
            </AlertDescription>
          </Alert>
        )}
        {state.success && Array.isArray(state.segments) && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-4">
              <Label>{t("dashboard:ai.segments")}</Label>
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min="1"
                  max="200"
                  value={maxLineLength}
                  onChange={(event) => setMaxLineLength(event.target.value)}
                  className="w-20"
                  aria-label={t("dashboard:ai.maxLineLength")}
                />
                <Input
                  type="number"
                  min="1"
                  max="10"
                  value={maxLineCount}
                  onChange={(event) => setMaxLineCount(event.target.value)}
                  className="w-16"
                  aria-label={t("dashboard:ai.maxLineCount")}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={wrapSegments}
                >
                  {t("dashboard:ai.wrapCues")}
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={addSegment}>
                  {t("dashboard:ai.addCue")}
                </Button>
              </div>
            </div>
            <ul className="flex flex-col gap-2">
              {(state.segments as Array<{ start: number; end: number; text: string }>).map(
                (segment, index) => (
                  <li
                    key={index}
                    className="flex flex-col gap-2 rounded-lg border p-3"
                  >
                    <div className="flex items-center gap-2">
                      <Input
                        type="number"
                        step="0.01"
                        min="0"
                        value={segment.start}
                        onChange={(event) =>
                          updateSegment(index, {
                            start: Number(event.target.value),
                          })
                        }
                        className="w-24"
                        aria-label={t("dashboard:ai.cueStart")}
                      />
                      <span className="text-muted-foreground">-</span>
                      <Input
                        type="number"
                        step="0.01"
                        min="0"
                        value={segment.end}
                        onChange={(event) =>
                          updateSegment(index, {
                            end: Number(event.target.value),
                          })
                        }
                        className="w-24"
                        aria-label={t("dashboard:ai.cueEnd")}
                      />
                      <span className="text-xs text-muted-foreground">
                        {formatTime(segment.start)} - {formatTime(segment.end)}
                      </span>
                      <div className="ml-auto flex gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => splitSegment(index)}
                        >
                          {t("dashboard:ai.splitCue")}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={index + 1 >= segments.length}
                          onClick={() => mergeSegments(index)}
                        >
                          {t("dashboard:ai.mergeCue")}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => removeSegment(index)}
                        >
                          {t("dashboard:ai.delete")}
                        </Button>
                      </div>
                    </div>
                    <Textarea
                      value={segment.text}
                      onChange={(event) =>
                        updateSegment(index, { text: event.target.value })
                      }
                      className="min-h-[48px]"
                    />
                  </li>
                ),
              )}
            </ul>
          </div>
        )}
        <SubmitButton className="self-start">
          {t("dashboard:ai.transcribe")}
        </SubmitButton>
      </form>
    </div>
  );
}

export function TranslateForm({
  lang,
  canUseAi,
}: {
  lang: string;
  canUseAi: boolean;
}) {
  const { t } = useTranslation(lang);
  const [state, dispatch] = useActionState(translateAction, { success: false });
  const [translatedSegments, setTranslatedSegments] = useState<
    Array<{ id: string; text: string }>
  >([]);
  useEffect(() => {
    if (Array.isArray(state.segments)) {
      setTranslatedSegments(
        (state.segments as Array<{ id: string; text: string }>).map(
          (segment) => ({ id: segment.id, text: segment.text }),
        ),
      );
    }
  }, [state.segments]);
  if (!canUseAi) {
    return <PlanRequired lang={lang} />;
  }

  function updateTranslatedSegment(
    index: number,
    text: string,
  ) {
    setTranslatedSegments((current) =>
      current.map((segment, i) => (i === index ? { ...segment, text } : segment)),
    );
  }

  function removeTranslatedSegment(index: number) {
    setTranslatedSegments((current) => current.filter((_, i) => i !== index));
  }

  function addTranslatedSegment() {
    setTranslatedSegments((current) => [
      ...current,
      { id: String(current.length + 1), text: "" },
    ]);
  }

  return (
    <div className="rounded-lg border text-card-foreground">
      <form action={dispatch} className="flex flex-col gap-4 p-6">
        <div className="flex flex-col space-y-1.5 max-w-xs">
          <Label htmlFor="targetLanguage">
            {t("dashboard:ai.targetLanguage")}
          </Label>
          <Input id="targetLanguage" name="targetLanguage" placeholder="en" required />
        </div>
        <div className="flex flex-col space-y-1.5 max-w-xs">
          <Label htmlFor="sourceLanguage">
            {t("dashboard:ai.sourceLanguage")}
          </Label>
          <Input id="sourceLanguage" name="sourceLanguage" placeholder="ja" />
        </div>
        <div className="flex flex-col space-y-1.5">
          <Label htmlFor="segments">{t("dashboard:ai.segments")}</Label>
          <Textarea
            id="segments"
            name="segments"
            placeholder='[{"id":"1","text":"こんにちは"}]'
            className="min-h-[120px] font-mono text-xs"
            required
          />
        </div>
        {state.message && (
          <Alert variant="destructive">
            <AlertTitle>{t("error")}</AlertTitle>
            <AlertDescription>{state.message}</AlertDescription>
          </Alert>
        )}
        {state.success && (
          <Alert>
            <AlertTitle>{t("success")}</AlertTitle>
            <AlertDescription>
              {t("dashboard:ai.translationDone")}
            </AlertDescription>
          </Alert>
        )}
        {state.success && translatedSegments.length > 0 && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-4">
              <Label>{t("dashboard:ai.translatedSegments")}</Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={addTranslatedSegment}
              >
                {t("dashboard:ai.addCue")}
              </Button>
            </div>
            <ul className="flex flex-col gap-2">
              {translatedSegments.map((segment, index) => (
                  <li
                    key={segment.id}
                    className="flex flex-col gap-2 rounded-lg border p-3"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-bold">{index + 1}</span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="ml-auto"
                        onClick={() => removeTranslatedSegment(index)}
                      >
                        {t("dashboard:ai.delete")}
                      </Button>
                    </div>
                    <Textarea
                      value={segment.text}
                      onChange={(event) =>
                        updateTranslatedSegment(index, event.target.value)
                      }
                      className="min-h-[48px]"
                    />
                  </li>
                ))}
            </ul>
          </div>
        )}
        <SubmitButton className="self-start">
          {t("dashboard:ai.translate")}
        </SubmitButton>
      </form>
    </div>
  );
}

export function VideoForm({
  lang,
  canUseAi,
}: {
  lang: string;
  canUseAi: boolean;
}) {
  const { t } = useTranslation(lang);
  const [state, dispatch] = useActionState(createVideoAction, { success: false });
  const [videoDuration, setVideoDuration] = useState<string>("4");
  const [videoResolution, setVideoResolution] = useState<string>("720p");
  const [videoPrompt, setVideoPrompt] = useState("");
  const [videoStyle, setVideoStyle] = useState("");
  const [videoComposition, setVideoComposition] = useState("");
  const [videoMotion, setVideoMotion] = useState("");
  const [videoExclusions, setVideoExclusions] = useState("");
  if (!canUseAi) {
    return <PlanRequired lang={lang} />;
  }

  function applyTemplate(template: PromptTemplate) {
    setVideoPrompt(template.prompt);
    setVideoStyle(template.style ?? "");
    setVideoComposition(template.composition ?? "");
    setVideoMotion(template.motion ?? "");
    setVideoExclusions(template.exclusions ?? "");
  }

  return (
    <div className="rounded-lg border text-card-foreground">
      <form action={dispatch} className="flex flex-col gap-4 p-6">
        <PromptLibrary lang={lang} onApply={applyTemplate} />
        <div className="flex flex-col space-y-1.5">
          <Label htmlFor="videoPrompt">{t("dashboard:ai.prompt")}</Label>
          <Textarea
            id="videoPrompt"
            name="prompt"
            maxLength={4000}
            required
            value={videoPrompt}
            onChange={(event) => setVideoPrompt(event.target.value)}
          />
        </div>
        <div className="flex flex-col space-y-1.5">
          <Label htmlFor="videoStyle">{t("dashboard:ai.promptStyle")}</Label>
          <Input
            id="videoStyle"
            name="style"
            maxLength={1000}
            value={videoStyle}
            onChange={(event) => setVideoStyle(event.target.value)}
          />
        </div>
        <div className="flex flex-col space-y-1.5">
          <Label htmlFor="videoComposition">
            {t("dashboard:ai.promptComposition")}
          </Label>
          <Input
            id="videoComposition"
            name="composition"
            maxLength={1000}
            value={videoComposition}
            onChange={(event) => setVideoComposition(event.target.value)}
          />
        </div>
        <div className="flex flex-col space-y-1.5">
          <Label htmlFor="videoMotion">{t("dashboard:ai.promptMotion")}</Label>
          <Input
            id="videoMotion"
            name="motion"
            maxLength={1000}
            value={videoMotion}
            onChange={(event) => setVideoMotion(event.target.value)}
          />
        </div>
        <div className="flex flex-col space-y-1.5">
          <Label htmlFor="videoExclusions">
            {t("dashboard:ai.promptAvoid")}
          </Label>
          <Input
            id="videoExclusions"
            name="exclusions"
            maxLength={1000}
            value={videoExclusions}
            onChange={(event) => setVideoExclusions(event.target.value)}
          />
        </div>
        <div className="flex flex-col space-y-1.5">
          <Label htmlFor="videoFirstFrame">
            {t("dashboard:ai.firstFrame")}
          </Label>
          <Input
            id="videoFirstFrame"
            name="firstFrame"
            type="file"
            accept="image/png,image/jpeg,image/webp"
          />
        </div>
        <div className="flex flex-col space-y-1.5">
          <Label htmlFor="videoLastFrame">{t("dashboard:ai.lastFrame")}</Label>
          <Input
            id="videoLastFrame"
            name="lastFrame"
            type="file"
            accept="image/png,image/jpeg,image/webp"
          />
        </div>
        <div className="flex flex-col space-y-1.5 max-w-xs">
          <Label htmlFor="videoDuration">{t("dashboard:ai.duration")}</Label>
          <Select value={videoDuration} onValueChange={setVideoDuration}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {videoDurations.map((duration) => (
                <SelectItem key={duration} value={String(duration)}>
                  {duration}s
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <input type="hidden" name="durationSeconds" value={videoDuration} />
        </div>
        <div className="flex flex-col space-y-1.5 max-w-xs">
          <Label htmlFor="videoResolution">
            {t("dashboard:ai.resolution")}
          </Label>
          <Select value={videoResolution} onValueChange={setVideoResolution}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="720p">720p</SelectItem>
              <SelectItem value="1080p">1080p</SelectItem>
            </SelectContent>
          </Select>
          <input type="hidden" name="resolution" value={videoResolution} />
        </div>
        {state.message && (
          <Alert variant="destructive">
            <AlertTitle>{t("error")}</AlertTitle>
            <AlertDescription>{state.message}</AlertDescription>
          </Alert>
        )}
        {state.success && (
          <Alert>
            <AlertTitle>{t("success")}</AlertTitle>
            <AlertDescription>
              {t("dashboard:ai.videoQueued")}
            </AlertDescription>
          </Alert>
        )}
        <SubmitButton className="self-start">
          {t("dashboard:ai.generate")}
        </SubmitButton>
      </form>
    </div>
  );
}

export function JobHistory({
  lang,
  canUseAi,
}: {
  lang: string;
  canUseAi: boolean;
}) {
  const { t } = useTranslation(lang);
  const [jobs, setJobs] = useState<unknown[] | null>(null);
  const [jobsMessage, setJobsMessage] = useState<string | null>(null);
  const [isSyncing, startSync] = useTransition();
  const [isDeleting, startDelete] = useTransition();
  const [isRetrying, startRetry] = useTransition();
  const [nextCursor, setNextCursor] = useState<{
    createdAt: string;
    id: string;
  } | null>(null);
  const [isLoadingMore, startLoadMore] = useTransition();
  const [confirmAction, setConfirmAction] = useState<
    { type: "delete" | "retry"; jobId: string } | null
  >(null);

  if (!canUseAi) {
    return <PlanRequired lang={lang} />;
  }

  async function loadJobs() {
    const result = await listJobsAction();
    if (result.success) {
      setJobs(result.jobs ?? []);
      setNextCursor(result.nextCursor ?? null);
      setJobsMessage(null);
    } else {
      setJobsMessage(result.message ?? null);
    }
  }

  async function loadMore() {
    if (!nextCursor) return;
    startLoadMore(async () => {
      const result = await listJobsAction(nextCursor);
      if (result.success) {
        setJobs((current) => [
          ...(current ?? []),
          ...(result.jobs ?? []),
        ]);
        setNextCursor(result.nextCursor ?? null);
        setJobsMessage(null);
      } else {
        setJobsMessage(result.message ?? null);
      }
    });
  }

  function syncJob(jobId: string) {
    startSync(async () => {
      await refreshVideoJobAction(jobId);
      await loadJobs();
    });
  }

  function deleteJob(jobId: string) {
    setConfirmAction({ type: "delete", jobId });
  }

  function confirmDelete(jobId: string) {
    startDelete(async () => {
      const result = await deleteJobAction(jobId);
      if (result.success) {
        setJobs((current) =>
          current === null
            ? current
            : (current as Array<{ id: string }>).filter(
                (job) => job.id !== jobId,
              ),
        );
        setJobsMessage(null);
      } else {
        setJobsMessage(result.message ?? null);
      }
    });
  }

  function retryJob(jobId: string) {
    setConfirmAction({ type: "retry", jobId });
  }

  function confirmRetry(jobId: string) {
    startRetry(async () => {
      const result = await retryJobAction(jobId);
      if (result.success) {
        setJobsMessage(null);
        await loadJobs();
      } else {
        setJobsMessage(result.message ?? null);
      }
    });
  }

  return (
    <div className="rounded-lg border text-card-foreground">
      <AlertDialog
        open={confirmAction !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmAction(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmAction?.type === "delete"
                ? t("dashboard:ai.deleteJobTitle")
                : t("dashboard:ai.retryJobTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmAction?.type === "delete"
                ? t("dashboard:ai.deleteJobConfirmation")
                : t("dashboard:ai.retryJobConfirmation")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirmAction?.type === "delete") {
                  confirmDelete(confirmAction.jobId);
                } else if (confirmAction?.type === "retry") {
                  confirmRetry(confirmAction.jobId);
                }
                setConfirmAction(null);
              }}
            >
              {confirmAction?.type === "delete"
                ? t("dashboard:ai.delete")
                : t("dashboard:ai.retry")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <div className="m-6 mb-4 flex items-center justify-between gap-4">
        <h2 className="font-bold text-md">{t("dashboard:ai.jobHistory")}</h2>
        <Button type="button" variant="outline" onClick={loadJobs}>
          {t("dashboard:ai.refresh")}
        </Button>
      </div>
      <Separator />
      {jobsMessage && (
        <div className="p-6">
          <Alert variant="destructive">
            <AlertTitle>{t("error")}</AlertTitle>
            <AlertDescription>{jobsMessage}</AlertDescription>
          </Alert>
        </div>
      )}
      {jobs === null ? (
        <p className="p-6 text-sm text-muted-foreground">
          {t("dashboard:ai.loadJobsHint")}
        </p>
      ) : jobs.length === 0 ? (
        <p className="p-6 text-sm text-muted-foreground">
          {t("dashboard:ai.noJobs")}
        </p>
      ) : (
        <>
          <ul className="[&_li:last-child]:border-0">
            {(jobs as Array<{
              id: string;
              kind: string;
              status: string;
              createdAt: string;
              url: string | null;
              fileName: string | null;
              canRetry?: boolean;
            }>).map((job) => (
              <li
                key={job.id}
                className="flex items-center py-4 px-6 gap-2 border-b"
              >
                <div className="flex-1">
                  <p className="font-bold">
                    {t(`dashboard:ai.kinds.${job.kind}`)}
                  </p>
                  <p className="text-foreground/70 text-sm">
                    {t(`dashboard:ai.statuses.${job.status}`)} ·{" "}
                    {new Date(job.createdAt).toLocaleString()}
                  </p>
                </div>
                {job.url && (
                  <Button asChild variant="outline" size="sm">
                    <a href={job.url} target="_blank" rel="noreferrer">
                      {t("dashboard:ai.viewResult")}
                    </a>
                  </Button>
                )}
                {job.kind === "video" &&
                  job.status !== "succeeded" &&
                  job.status !== "failed" && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={isSyncing}
                      onClick={() => syncJob(job.id)}
                    >
                      {t("dashboard:ai.sync")}
                    </Button>
                  )}
                {job.canRetry && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={isRetrying}
                    onClick={() => retryJob(job.id)}
                  >
                    {t("dashboard:ai.retry")}
                  </Button>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={isDeleting}
                  onClick={() => deleteJob(job.id)}
                >
                  {t("dashboard:ai.delete")}
                </Button>
              </li>
            ))}
          </ul>
          {nextCursor && (
            <div className="p-4 flex justify-center">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={isLoadingMore}
                onClick={loadMore}
              >
                {t("dashboard:ai.loadMore")}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
