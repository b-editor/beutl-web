"use client";

import { useTranslation } from "@beutl/ui/i18n-client";
import SubmitButton from "@beutl/ui/submit-button";
import { Alert, AlertDescription, AlertTitle } from "@beutl/ui/ui/alert";
import { Button } from "@beutl/ui/ui/button";
import { Card } from "@beutl/ui/ui/card";
import { Input } from "@beutl/ui/ui/input";
import { Label } from "@beutl/ui/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@beutl/ui/ui/select";
import { Textarea } from "@beutl/ui/ui/textarea";
import { useToast } from "@beutl/ui/use-toast";
import { AudioLines, Languages, Merge, Plus, Scissors, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState, type ChangeEvent } from "react";
import { MAX_AI_TRANSCRIPTION_UPLOAD_BYTES } from "@beutl/core";
import {
  AudioExtractionError,
  extractAudioAsWav,
  isVideoFile,
  maximumExtractableSeconds,
  type AudioExtractionFailure,
} from "@/lib/audio-extract";
import {
  formatCueClock,
  readCues,
  readWords,
  splitCueAtWord,
  toPlainText,
  toSrt,
  toVtt,
  type SubtitleCue,
  type SubtitleWord,
} from "@/lib/subtitle-format";
import { saveSubtitleHandoff } from "@/lib/subtitle-handoff";
import { transcribeAction } from "./actions";
import {
  AiAccessNotice,
  ModelSelect,
  AiWorkspace,
  CopyButton,
  DownloadButton,
  IdempotencyKeyField,
  ResultPanel,
  ResultShimmer,
  ResultPlaceholder,
  blockedReason,
  downloadTextFile,
  defaultModelId,
  type AiAccess,
} from "./shared";
import type { LanguageOption } from "./translate-form";

// An empty field means "use the default"; anything else is held to at least 1.
// `Number(value) || fallback` sent a typed 0 to the fallback instead.
function positiveLimit(value: string, fallback: number): number {
  const trimmed = value.trim();
  if (trimmed === "") return fallback;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.floor(parsed));
}

function wrapText(text: string, lengthLimit: number): string[] {
  const lines: string[] = [];
  for (const line of text.split("\n")) {
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
  return lines;
}

function baseNameOf(fileName: string): string {
  const withoutExtension = fileName.replace(/\.[^.]+$/u, "");
  return withoutExtension.length > 0 ? withoutExtension : "transcription";
}

export function TranscribeForm({
  lang,
  access,
  languages,
}: {
  lang: string;
  access: AiAccess;
  // Resolved on the server, exactly as the translation screen does it; see
  // languageOptions in the page.
  languages: LanguageOption[];
}) {
  const { t } = useTranslation(lang);
  const { toast } = useToast();
  const router = useRouter();
  const [state, dispatch, isPending] = useActionState(transcribeAction, {
    success: false,
  });
  const [cues, setCues] = useState<SubtitleCue[]>([]);
  // Word timings and the detected language arrive with the transcript. Neither
  // reached this screen before, so a split could not land on a word and nobody
  // could see what language the model decided it had heard.
  const [words, setWords] = useState<SubtitleWord[]>([]);
  const [detectedLanguage, setDetectedLanguage] = useState<string | null>(null);
  const [audioName, setAudioName] = useState<string>("transcription");
  const [extracting, setExtracting] = useState(false);
  const [extractionError, setExtractionError] =
    useState<AudioExtractionFailure | null>(null);
  const [language, setLanguage] = useState("");
  const [model, setModel] = useState(() =>
    defaultModelId(access.models["audio.transcribe"] ?? []),
  );
  const [maxLineLength, setMaxLineLength] = useState<string>("42");
  const [maxLineCount, setMaxLineCount] = useState<string>("2");
  // What the focused timing field currently reads. A number input reports ""
  // for anything that is not yet a valid number — an emptied field, and every
  // keystroke of "12." on the way to 12.5 — and Number("") is 0, so writing the
  // field straight back moved the cue to the start of the track. Only one field
  // can be focused, so one draft is enough.
  const [timeDraft, setTimeDraft] = useState<{
    key: string;
    text: string;
  } | null>(null);

  // The action result is the starting point for editing, not the thing that is
  // rendered: every correction the user makes afterwards lives in `cues`.
  // A failed run carries no segments and must leave the current edits alone.
  useEffect(() => {
    if (state.segments === undefined) return;
    setCues(readCues(state.segments));
    setWords(readWords(state.words));
    setDetectedLanguage(state.language ?? null);
  }, [state.segments, state.words, state.language]);

  const blocked = blockedReason(
    access,
    ["audio.transcribe"],
    (access.models["audio.transcribe"] ?? []).length === 0,
  );
  const models = access.models["audio.transcribe"] ?? [];

  // A video is converted here rather than uploaded: the endpoint refuses a file
  // that carries video, and the audio alone is a fraction of the size. The
  // converted file replaces what the field holds, so the form still submits
  // exactly what the user picked.
  async function handleAudioChange(event: ChangeEvent<HTMLInputElement>) {
    const input = event.target;
    const file = input.files?.[0];
    setExtractionError(null);
    if (!file) {
      setAudioName("transcription");
      return;
    }
    setAudioName(baseNameOf(file.name));
    if (!isVideoFile(file)) return;

    setExtracting(true);
    try {
      const audio = await extractAudioAsWav(
        file,
        MAX_AI_TRANSCRIPTION_UPLOAD_BYTES,
      );
      const transfer = new DataTransfer();
      transfer.items.add(audio);
      input.files = transfer.files;
    } catch (error) {
      input.value = "";
      setExtractionError(
        error instanceof AudioExtractionError ? error.reason : "unsupportedFormat",
      );
    } finally {
      setExtracting(false);
    }
  }

  // The field keeps showing what was typed; the cue only moves once that text
  // is a time.
  function editCueTime(index: number, field: "start" | "end", text: string) {
    setTimeDraft({ key: `${index}:${field}`, text });
    const parsed = Number(text);
    if (text.trim() === "" || !Number.isFinite(parsed) || parsed < 0) return;
    updateCue(index, { [field]: parsed });
  }

  function cueTimeValue(index: number, field: "start" | "end", value: number) {
    const key = `${index}:${field}`;
    return timeDraft?.key === key ? timeDraft.text : String(value);
  }

  function updateCue(index: number, patch: Partial<SubtitleCue>) {
    setCues((current) =>
      current.map((cue, position) =>
        position === index ? { ...cue, ...patch } : cue,
      ),
    );
  }

  function removeCue(index: number) {
    setCues((current) => current.filter((_, position) => position !== index));
  }

  function addCue() {
    setCues((current) => {
      const last = current.at(-1);
      return [
        ...current,
        { start: last?.end ?? 0, end: (last?.end ?? 0) + 1, text: "" },
      ];
    });
  }

  function splitCue(index: number) {
    setCues((current) => {
      const cue = current[index];
      if (!cue) return current;
      const [head, tail] = splitCueAtWord(cue, words);
      return [
        ...current.slice(0, index),
        head,
        tail,
        ...current.slice(index + 1),
      ];
    });
  }

  function mergeWithNext(index: number) {
    setCues((current) => {
      if (index + 1 >= current.length) return current;
      return [
        ...current.slice(0, index),
        {
          start: current[index].start,
          end: current[index + 1].end,
          text: `${current[index].text} ${current[index + 1].text}`.trim(),
        },
        ...current.slice(index + 2),
      ];
    });
  }

  function wrapCues() {
    const lengthLimit = positiveLimit(maxLineLength, 42);
    const countLimit = positiveLimit(maxLineCount, 2);
    setCues((current) =>
      current.flatMap((cue) => {
        const lines = wrapText(cue.text, lengthLimit);
        if (lines.length <= countLimit) {
          return [{ ...cue, text: lines.join("\n") }];
        }
        // What does not fit becomes the next cue. Keeping only the first lines
        // would delete transcribed speech the user has already paid for, with
        // nothing on screen to say it happened.
        const groups: string[][] = [];
        for (let index = 0; index < lines.length; index += countLimit) {
          groups.push(lines.slice(index, index + countLimit));
        }
        // Split the original duration by how much text each part carries, so
        // the cues stay roughly in step with the speech.
        const totalLength = Math.max(
          groups.reduce((total, group) => total + group.join("").length, 0),
          1,
        );
        const duration = Math.max(cue.end - cue.start, 0);
        let start = cue.start;
        return groups.map((group, index) => {
          const end =
            index === groups.length - 1
              ? cue.end
              : start + (duration * group.join("").length) / totalLength;
          const piece = { start, end, text: group.join("\n") };
          start = end;
          return piece;
        });
      }),
    );
  }

  function sendToTranslation() {
    if (!saveSubtitleHandoff({ cues, sourceName: audioName })) {
      toast({
        title: t("dashboard:ai.handoffFailed"),
        variant: "destructive",
      });
      return;
    }
    router.push(`/${lang}/dashboard/ai/translate`);
  }

  const form = (
    <Card>
      <form action={dispatch} className="flex flex-col gap-4 p-6">
        <IdempotencyKeyField state={state} />
        <div className="flex flex-col space-y-1.5">
          <Label htmlFor="transcribeFile">{t("dashboard:ai.audio")}</Label>
          <Input
            id="transcribeFile"
            name="file"
            type="file"
            accept="audio/*,video/*"
            required
            onChange={handleAudioChange}
          />
          <p className="text-xs text-muted-foreground">
            {extracting
              ? t("dashboard:ai.audioExtracting")
              : t("dashboard:ai.audioHint", {
                  minutes: Math.floor(
                    maximumExtractableSeconds(MAX_AI_TRANSCRIPTION_UPLOAD_BYTES)
                      / 60,
                  ),
                })}
          </p>
          {extractionError && (
            <p className="text-xs text-destructive">
              {t(`dashboard:ai.audioExtractionErrors.${extractionError}`)}
            </p>
          )}
        </div>
        <ModelSelect
          lang={lang}
          models={models}
          value={model}
          onChange={setModel}
        />
        <div className="flex flex-col space-y-1.5">
          <Label htmlFor="transcribeLanguage">
            {t("dashboard:ai.language")}
          </Label>
          <Select value={language} onValueChange={setLanguage}>
            <SelectTrigger id="transcribeLanguage" className="max-w-[16rem]">
              {/* An unset language is not a blank field: the model detects it. */}
              <SelectValue placeholder={t("dashboard:ai.sourceLanguageAuto")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">
                {t("dashboard:ai.sourceLanguageAuto")}
              </SelectItem>
              {languages.map((option) => (
                <SelectItem key={option.code} value={option.code}>
                  {option.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {/* "auto" is the picker's word for "say nothing"; the request omits
              the field, which is what the endpoint treats as detect. */}
          <input
            type="hidden"
            name="language"
            value={language === "auto" ? "" : language}
          />
          <p className="text-xs text-muted-foreground">
            {t("dashboard:ai.languageHint")}
          </p>
        </div>

        {state.message && (
          <Alert variant="destructive">
            <AlertTitle>{t("error")}</AlertTitle>
            <AlertDescription>{state.message}</AlertDescription>
          </Alert>
        )}

        <SubmitButton
          className="w-full"
          forceSpinner={isPending}
          disabled={blocked !== null || isPending}
        >
          {t("dashboard:ai.transcribe")}
        </SubmitButton>
      </form>
    </Card>
  );

  const result = isPending ? (
    <ResultShimmer label={t("dashboard:ai.processing")} />
  ) : cues.length > 0 ? (
      <ResultPanel
        title={t("dashboard:ai.transcriptionDone")}
        actions={
          <>
            <DownloadButton
              label="SRT"
              onDownload={() =>
                downloadTextFile(
                  toSrt(cues),
                  `${audioName}.srt`,
                  "application/x-subrip;charset=utf-8",
                )
              }
            />
            <DownloadButton
              label="VTT"
              onDownload={() =>
                downloadTextFile(
                  toVtt(cues),
                  `${audioName}.vtt`,
                  "text/vtt;charset=utf-8",
                )
              }
            />
            <CopyButton
              lang={lang}
              text={() => toPlainText(cues)}
              label={t("dashboard:ai.copyText")}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={sendToTranslation}
            >
              <Languages className="mr-2 h-4 w-4" />
              {t("dashboard:ai.sendToTranslation")}
            </Button>
          </>
        }
      >
        {/* Cue length limits are a subtitle convention, not a general text
            setting, so they sit with the cues they reshape. */}
        <div className="flex flex-wrap items-end justify-between gap-2">
          <p className="text-sm text-muted-foreground">
            {t("dashboard:ai.cueCount", { total: cues.length })}
            {detectedLanguage && (
              <>
                {" · "}
                {t("dashboard:ai.detectedLanguage", {
                  language: detectedLanguage.toUpperCase(),
                })}
              </>
            )}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1">
              <Label
                htmlFor="maxLineLength"
                className="text-xs text-muted-foreground"
              >
                {t("dashboard:ai.maxLineLength")}
              </Label>
              <Input
                id="maxLineLength"
                type="number"
                min="1"
                max="200"
                value={maxLineLength}
                onChange={(event) => setMaxLineLength(event.target.value)}
                className="w-20"
              />
            </div>
            <div className="flex items-center gap-1">
              <Label
                htmlFor="maxLineCount"
                className="text-xs text-muted-foreground"
              >
                {t("dashboard:ai.maxLineCount")}
              </Label>
              <Input
                id="maxLineCount"
                type="number"
                min="1"
                max="10"
                value={maxLineCount}
                onChange={(event) => setMaxLineCount(event.target.value)}
                className="w-16"
              />
            </div>
            <Button type="button" variant="outline" size="sm" onClick={wrapCues}>
              {t("dashboard:ai.wrapCues")}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={addCue}>
              <Plus className="mr-2 h-4 w-4" />
              {t("dashboard:ai.addCue")}
            </Button>
          </div>
        </div>

        <ul className="flex flex-col gap-2">
          {cues.map((cue, index) => (
            <li
              key={index}
              className="flex flex-col gap-2 rounded-lg border bg-background p-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="w-6 shrink-0 text-sm font-bold tabular-nums text-muted-foreground">
                  {index + 1}
                </span>
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  value={cueTimeValue(index, "start", cue.start)}
                  onChange={(event) =>
                    editCueTime(index, "start", event.target.value)
                  }
                  onBlur={() => setTimeDraft(null)}
                  className="w-24"
                  aria-label={t("dashboard:ai.cueStart")}
                />
                <span className="text-muted-foreground">–</span>
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  value={cueTimeValue(index, "end", cue.end)}
                  onChange={(event) =>
                    editCueTime(index, "end", event.target.value)
                  }
                  onBlur={() => setTimeDraft(null)}
                  className="w-24"
                  aria-label={t("dashboard:ai.cueEnd")}
                />
                <span className="text-xs tabular-nums text-muted-foreground">
                  {formatCueClock(cue.start)} – {formatCueClock(cue.end)}
                </span>
                <div className="ml-auto flex gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-8 w-8 p-0"
                    aria-label={t("dashboard:ai.splitCue")}
                    title={t("dashboard:ai.splitCue")}
                    onClick={() => splitCue(index)}
                  >
                    <Scissors className="h-4 w-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-8 w-8 p-0"
                    aria-label={t("dashboard:ai.mergeCue")}
                    title={t("dashboard:ai.mergeCue")}
                    disabled={index + 1 >= cues.length}
                    onClick={() => mergeWithNext(index)}
                  >
                    <Merge className="h-4 w-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-8 w-8 p-0"
                    aria-label={t("dashboard:ai.delete")}
                    title={t("dashboard:ai.delete")}
                    onClick={() => removeCue(index)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <Textarea
                value={cue.text}
                onChange={(event) =>
                  updateCue(index, { text: event.target.value })
                }
                className="min-h-[48px]"
                aria-label={t("dashboard:ai.cueText", { number: index + 1 })}
              />
            </li>
          ))}
        </ul>
      </ResultPanel>
    ) : (
      <ResultPlaceholder
        icon={AudioLines}
        label={t("dashboard:ai.resultPlaceholderTranscription")}
      />
    );

  return (
    <div className="flex flex-col gap-4">
      {blocked && <AiAccessNotice lang={lang} reason={blocked} />}
      <AiWorkspace form={form} result={result} />
    </div>
  );
}
