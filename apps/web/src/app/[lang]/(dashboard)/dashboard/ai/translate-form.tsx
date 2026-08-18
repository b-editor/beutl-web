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
import { ArrowRight, Languages, Plus, Trash2 } from "lucide-react";
import {
  useActionState,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  applyTranslationToCues,
  MAX_GLOSSARY_ENTRIES,
  parseGlossary,
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
  AdvancedOptions,
  AiAccessNotice,
  ModelSelect,
  AiWorkspace,
  CopyButton,
  DownloadButton,
  IdempotencyKeyField,
  ResultPanel,
  ResultPlaceholder,
  blockedReason,
  downloadTextFile,
  defaultModelId,
  type AiAccess,
} from "./shared";

export type LanguageOption = { code: string; name: string };

export function TranslateForm({
  lang,
  access,
  languages,
}: {
  lang: string;
  access: AiAccess;
  // Resolved on the server; see languageOptions in the page.
  languages: LanguageOption[];
}) {
  const { t } = useTranslation(lang);
  const [state, dispatch] = useActionState(translateAction, { success: false });
  const [source, setSource] = useState("");
  const [model, setModel] = useState(() =>
    defaultModelId(access.models["subtitle.translate"] ?? []),
  );
  const [sourceLanguage, setSourceLanguage] = useState("");
  const [targetLanguage, setTargetLanguage] = useState("");
  const [importedFrom, setImportedFrom] = useState<string | null>(null);
  const [translated, setTranslated] = useState<TranslatableSegment[]>([]);
  // The source the translation on screen belongs to. Editing the field after a
  // run leaves the two out of step, and re-timing then writes the old text onto
  // the new cues — a subtitle file that looks finished and is not.
  const [translatedSource, setTranslatedSource] = useState<string | null>(null);
  const [glossary, setGlossary] = useState("");
  // Read when a result lands. Keeping the source out of that effect's
  // dependencies is the point: it must not re-run on every keystroke.
  const sourceRef = useRef(source);
  useEffect(() => {
    sourceRef.current = source;
  }, [source]);

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
      setTranslatedSource(sourceRef.current);
    }
  }, [state.segments]);

  const parsed = useMemo(() => parseSubtitleSource(source), [source]);
  // The cues the source carried, so a translation can be written back out as a
  // subtitle file instead of a bare list of strings.
  const sourceCues: SubtitleCue[] | null = parsed.ok ? parsed.cues : null;

  const blocked = blockedReason(access, ["subtitle.translate"]);
  const models = access.models["subtitle.translate"] ?? [];
  const contextsJson = useMemo(() => {
    if (!parsed.ok || !parsed.cues) return "";
    return JSON.stringify(
      Object.fromEntries(
        parsed.segments.map((segment, index) => {
          const cue = parsed.cues?.[index];
          return [segment.id, { start: cue?.start ?? 0, end: cue?.end ?? 0 }];
        }),
      ),
    );
  }, [parsed]);
  const glossaryEntryCount = useMemo(
    () => Object.keys(parseGlossary(glossary)).length,
    [glossary],
  );
  const sourceChanged =
    translatedSource !== null && translatedSource !== source;
  const translatedCues =
    !sourceChanged && sourceCues && parsed.ok
      ? applyTranslationToCues(sourceCues, parsed.segments, translated)
      : null;

  const form = (
    <Card>
      <form action={dispatch} className="flex flex-col gap-4 p-6">
        <IdempotencyKeyField state={state} />
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

        <ModelSelect
          lang={lang}
          models={models}
          value={model}
          onChange={setModel}
        />

        {/* Read in the direction the translation runs: source, arrow, target. */}
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex min-w-[9rem] flex-1 flex-col space-y-1.5">
            <Label htmlFor="sourceLanguage">
              {t("dashboard:ai.sourceLanguage")}
            </Label>
            <Select value={sourceLanguage} onValueChange={setSourceLanguage}>
              <SelectTrigger id="sourceLanguage">
                {/* An unset source is not a blank field: the model detects it. */}
                <SelectValue placeholder={t("dashboard:ai.sourceLanguageAuto")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">
                  {t("dashboard:ai.sourceLanguageAuto")}
                </SelectItem>
                {languages.map((language) => (
                  <SelectItem key={language.code} value={language.code}>
                    {language.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {/* "auto" is the picker's word for "say nothing"; the request omits
                the field entirely, which is what the endpoint treats as detect. */}
            <input
              type="hidden"
              name="sourceLanguage"
              value={sourceLanguage === "auto" ? "" : sourceLanguage}
            />
          </div>
          <ArrowRight
            aria-hidden
            className="mb-2.5 h-4 w-4 shrink-0 text-muted-foreground"
          />
          <div className="flex min-w-[9rem] flex-1 flex-col space-y-1.5">
            <Label htmlFor="targetLanguage">
              {t("dashboard:ai.targetLanguage")}
            </Label>
            <Select value={targetLanguage} onValueChange={setTargetLanguage}>
              <SelectTrigger id="targetLanguage">
                <SelectValue
                  placeholder={t("dashboard:ai.targetLanguagePlaceholder")}
                />
              </SelectTrigger>
              <SelectContent>
                {languages.map((language) => (
                  <SelectItem key={language.code} value={language.code}>
                    {language.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <input
              type="hidden"
              name="targetLanguage"
              value={targetLanguage}
            />
          </div>
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
          {/* The source already carries timings when it is a subtitle file.
              Sending them lets the model keep each line readable in the time
              its cue is on screen. */}
          <input type="hidden" name="contexts" value={contextsJson} />
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

        <AdvancedOptions lang={lang}>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col space-y-1.5">
              <Label htmlFor="maxCharactersPerLine">
                {t("dashboard:ai.maxCharactersPerLine")}
              </Label>
              <Input
                id="maxCharactersPerLine"
                name="maxCharactersPerLine"
                type="number"
                min={1}
                max={200}
                step={1}
                placeholder="42"
              />
            </div>
            <div className="flex flex-col space-y-1.5">
              <Label htmlFor="maxLines">{t("dashboard:ai.maxLines")}</Label>
              <Input
                id="maxLines"
                name="maxLines"
                type="number"
                min={1}
                max={10}
                step={1}
                placeholder="2"
              />
            </div>
          </div>
          <div className="flex flex-col space-y-1.5">
            <Label htmlFor="glossary">{t("dashboard:ai.glossary")}</Label>
            <Textarea
              id="glossary"
              name="glossary"
              rows={4}
              className="font-mono text-xs"
              placeholder={"Beutl = Beutl\nタイムライン = timeline"}
              value={glossary}
              onChange={(event) => setGlossary(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {t("dashboard:ai.glossaryHint", {
                total: glossaryEntryCount,
                max: MAX_GLOSSARY_ENTRIES,
              })}
            </p>
          </div>
        </AdvancedOptions>

        {state.message && (
          <Alert variant="destructive">
            <AlertTitle>{t("error")}</AlertTitle>
            <AlertDescription>{state.message}</AlertDescription>
          </Alert>
        )}

        <SubmitButton
          className="w-full"
          disabled={blocked !== null || !parsed.ok || targetLanguage === ""}
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
            {sourceChanged
              ? t("dashboard:ai.translationSourceChanged")
              : t("dashboard:ai.translationWithoutTimings")}
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
              setTranslated((current) => {
                // Derived from the highest id in use, not the length: after a
                // deletion the length collides with an id that is still there.
                const next =
                  current.reduce(
                    (highest, segment) =>
                      Math.max(highest, Number(segment.id) || 0),
                    0,
                  ) + 1;
                return [...current, { id: String(next), text: "" }];
              })
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
                {!sourceChanged && sourceCues?.[index] && (
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
