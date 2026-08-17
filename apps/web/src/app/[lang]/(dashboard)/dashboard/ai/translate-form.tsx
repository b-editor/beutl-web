"use client";

import { useTranslation } from "@beutl/ui/i18n-client";
import SubmitButton from "@beutl/ui/submit-button";
import { Alert, AlertDescription, AlertTitle } from "@beutl/ui/ui/alert";
import { Button } from "@beutl/ui/ui/button";
import { Card } from "@beutl/ui/ui/card";
import { Input } from "@beutl/ui/ui/input";
import { Label } from "@beutl/ui/ui/label";
import { Textarea } from "@beutl/ui/ui/textarea";
import { Languages, Plus, Trash2 } from "lucide-react";
import { useActionState, useEffect, useMemo, useState } from "react";
import {
  applyTranslationToCues,
  parseSubtitleSource,
  toPlainText,
  toSegmentsJson,
  toSrt,
  toVtt,
  type SubtitleCue,
  type TranslatableSegment,
} from "@/lib/subtitle-format";
import {
  clearSubtitleHandoff,
  loadSubtitleHandoff,
} from "@/lib/subtitle-handoff";
import { translateAction } from "./actions";
import {
  AiAccessNotice,
  AiWorkspace,
  CopyButton,
  DownloadButton,
  ResultPanel,
  ResultPlaceholder,
  blockedReason,
  downloadTextFile,
  type AiAccess,
} from "./shared";

const COMMON_LANGUAGES = ["en", "ja", "zh", "ko", "es", "fr", "de", "pt"];

export function TranslateForm({
  lang,
  access,
}: {
  lang: string;
  access: AiAccess;
}) {
  const { t } = useTranslation(lang);
  const [state, dispatch] = useActionState(translateAction, { success: false });
  const [source, setSource] = useState("");
  const [importedFrom, setImportedFrom] = useState<string | null>(null);
  const [translated, setTranslated] = useState<TranslatableSegment[]>([]);

  // Picking up where the transcription screen left off. Consumed once so a
  // later visit starts from an empty field rather than a stale transcript.
  useEffect(() => {
    const handoff = loadSubtitleHandoff();
    if (!handoff) return;
    setSource(toSrt(handoff.cues));
    setImportedFrom(handoff.sourceName);
    clearSubtitleHandoff();
  }, []);

  useEffect(() => {
    if (Array.isArray(state.segments)) {
      setTranslated(
        (state.segments as TranslatableSegment[]).map((segment) => ({
          id: segment.id,
          text: segment.text,
        })),
      );
    }
  }, [state.segments]);

  const parsed = useMemo(() => parseSubtitleSource(source), [source]);
  // The cues the source carried, so a translation can be written back out as a
  // subtitle file instead of a bare list of strings.
  const sourceCues: SubtitleCue[] | null = parsed.ok ? parsed.cues : null;

  const blocked = blockedReason(access, ["subtitle.translate"]);
  const translatedCues =
    sourceCues && sourceCues.length === translated.length
      ? applyTranslationToCues(sourceCues, translated)
      : null;

  const form = (
    <Card>
      <form action={dispatch} className="flex flex-col gap-4 p-6">
        {importedFrom !== null && (
          <Alert>
            <AlertTitle>{t("dashboard:ai.importedTitle")}</AlertTitle>
            <AlertDescription>
              {t("dashboard:ai.importedDescription", {
                source: importedFrom || t("dashboard:ai.transcription"),
              })}
            </AlertDescription>
          </Alert>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col space-y-1.5">
            <Label htmlFor="targetLanguage">
              {t("dashboard:ai.targetLanguage")}
            </Label>
            <Input
              id="targetLanguage"
              name="targetLanguage"
              placeholder="en"
              list="aiTranslateLanguages"
              maxLength={16}
              required
            />
          </div>
          <div className="flex flex-col space-y-1.5">
            <Label htmlFor="sourceLanguage">
              {t("dashboard:ai.sourceLanguage")}
            </Label>
            <Input
              id="sourceLanguage"
              name="sourceLanguage"
              placeholder="ja"
              list="aiTranslateLanguages"
              maxLength={16}
            />
          </div>
          <datalist id="aiTranslateLanguages">
            {COMMON_LANGUAGES.map((code) => (
              <option key={code} value={code} />
            ))}
          </datalist>
        </div>

        <div className="flex flex-col space-y-1.5">
          <Label htmlFor="subtitleSource">
            {t("dashboard:ai.subtitleSource")}
          </Label>
          <Textarea
            id="subtitleSource"
            value={source}
            onChange={(event) => setSource(event.target.value)}
            placeholder={t("dashboard:ai.subtitleSourcePlaceholder")}
            className="min-h-[220px] font-mono text-xs"
          />
          {/* Whatever was pasted is converted here, so the endpoint keeps
              receiving the JSON it validates. */}
          <input
            type="hidden"
            name="segments"
            value={parsed.ok ? toSegmentsJson(parsed.segments) : ""}
          />
          <p
            className={
              parsed.ok || source.trim().length === 0
                ? "text-sm text-muted-foreground"
                : "text-sm text-destructive"
            }
          >
            {parsed.ok
              ? t("dashboard:ai.subtitleSourceParsed", {
                  total: parsed.segments.length,
                  format: t(`dashboard:ai.subtitleFormats.${parsed.format}`),
                })
              : source.trim().length === 0
                ? t("dashboard:ai.subtitleSourceHint")
                : t(`dashboard:ai.subtitleSourceErrors.${parsed.reason}`)}
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
          disabled={blocked !== null || !parsed.ok}
        >
          {t("dashboard:ai.translate")}
        </SubmitButton>
      </form>
    </Card>
  );

  const result =
    translated.length > 0 ? (
      <ResultPanel
        title={t("dashboard:ai.translationDone")}
        actions={
          <>
            {translatedCues && (
              <>
                <DownloadButton
                  label="SRT"
                  onDownload={() =>
                    downloadTextFile(
                      toSrt(translatedCues),
                      "translated.srt",
                      "application/x-subrip;charset=utf-8",
                    )
                  }
                />
                <DownloadButton
                  label="VTT"
                  onDownload={() =>
                    downloadTextFile(
                      toVtt(translatedCues),
                      "translated.vtt",
                      "text/vtt;charset=utf-8",
                    )
                  }
                />
              </>
            )}
            <DownloadButton
              label="JSON"
              onDownload={() =>
                downloadTextFile(
                  toSegmentsJson(translated),
                  "translated.json",
                  "application/json;charset=utf-8",
                )
              }
            />
            <CopyButton
              lang={lang}
              text={() =>
                translatedCues
                  ? toPlainText(translatedCues)
                  : translated.map((segment) => segment.text).join("\n")
              }
              label={t("dashboard:ai.copyText")}
            />
          </>
        }
      >
        {!translatedCues && (
          <p className="text-sm text-muted-foreground">
            {t("dashboard:ai.translationWithoutTimings")}
          </p>
        )}
        <div className="flex items-center justify-between gap-4">
          <p className="text-sm text-muted-foreground">
            {t("dashboard:ai.cueCount", { total: translated.length })}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              setTranslated((current) => [
                ...current,
                { id: String(current.length + 1), text: "" },
              ])
            }
          >
            <Plus className="mr-2 h-4 w-4" />
            {t("dashboard:ai.addCue")}
          </Button>
        </div>
        <ul className="flex flex-col gap-2">
          {translated.map((segment, index) => (
            <li
              key={segment.id}
              className="flex flex-col gap-2 rounded-lg border bg-background p-3"
            >
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold tabular-nums text-muted-foreground">
                  {index + 1}
                </span>
                {sourceCues?.[index] && (
                  <span className="truncate text-xs text-muted-foreground">
                    {sourceCues[index].text}
                  </span>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="ml-auto h-8 w-8 shrink-0 p-0"
                  aria-label={t("dashboard:ai.delete")}
                  onClick={() =>
                    setTranslated((current) =>
                      current.filter((_, position) => position !== index),
                    )
                  }
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
              <Textarea
                value={segment.text}
                onChange={(event) =>
                  setTranslated((current) =>
                    current.map((item, position) =>
                      position === index
                        ? { ...item, text: event.target.value }
                        : item,
                    ),
                  )
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
        icon={Languages}
        label={t("dashboard:ai.resultPlaceholderTranslation")}
      />
    );

  return (
    <div className="flex flex-col gap-4">
      {blocked && <AiAccessNotice lang={lang} reason={blocked} />}
      <AiWorkspace form={form} result={result} />
    </div>
  );
}
