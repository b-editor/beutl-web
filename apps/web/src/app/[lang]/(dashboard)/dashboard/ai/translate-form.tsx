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
import { Shimmer } from "@beutl/ui/ui/skeleton";
import { ArrowRight, Languages, Plus, Trash2 } from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { runAiStream } from "@/lib/ai-event-stream";
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
import {
  AdvancedOptions,
  AiAccessNotice,
  ModelSelect,
  AiWorkspace,
  CopyButton,
  DownloadButton,
  ResultPanel,
  ResultShimmer,
  ResultPlaceholder,
  blockedReason,
  blocksSubmit,
  canSubmitModelRequest,
  correctedModelId,
  keepsIdempotencyKey,
  requestSignature,
  useAiRequestNames,
  downloadTextFile,
  defaultModelId,
  type AiAccess,
} from "./shared";

export type LanguageOption = { code: string; name: string };

function positiveNumber(text: string): number | undefined {
  const value = Number(text);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

export function TranslateForm({
  lang,
  userId,
  access,
  languages,
}: {
  lang: string;
  userId: string;
  access: AiAccess;
  // Resolved on the server; see languageOptions in the page.
  languages: LanguageOption[];
}) {
  const { t } = useTranslation(lang);
  const [isPending, setIsPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // The subtitles translated so far in the run that is going on. Shown while it
  // runs and replaced by the finished set when it ends, so a half-translated
  // list is never mistaken for the result.
  const [arriving, setArriving] = useState<TranslatableSegment[]>([]);
  // Names this submission to the server, one name per request. Kept when a run
  // is cut off, because asking again under the same name recovers what was
  // already paid for — and kept per request, because a second run started while
  // the first is still uncollected must not take the first one's name with it.
  const names = useAiRequestNames(userId, "subtitle.translate");
  const [source, setSource] = useState("");
  const [model, setModel] = useState(() =>
    defaultModelId(access.models["subtitle.translate"] ?? []),
  );
  const translateModels = useMemo(
    () => access.models["subtitle.translate"] ?? [],
    [access.models],
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
  const [maxCharactersPerLine, setMaxCharactersPerLine] = useState("");
  const [maxLines, setMaxLines] = useState("");
  // Read when a result lands. Keeping the source out of that effect's
  // dependencies is the point: it must not re-run on every keystroke.
  const sourceRef = useRef(source);
  useEffect(() => {
    if (names.hasRestoredModel("") && !names.holdsModel("") && model !== "") {
      setModel("");
      return;
    }
    sourceRef.current = source;
  }, [model, names, source]);

  // Picking up where the transcription screen left off. Consumed once so a
  // later visit starts from an empty field rather than a stale transcript.
  useEffect(() => {
    const handoff = loadSubtitleHandoff();
    if (!handoff) return;
    setSource(toSrt(handoff.cues));
    setImportedFrom(handoff.sourceName);
    clearSubtitleHandoff();
  }, []);

  // Sent to the API rather than through a server action, because this screen
  // shows the translation as it arrives and a server action can only answer
  // once, at the end.
  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isPending || !parsed.ok || targetLanguage === "" || submitBlocked || !names.ready) {
      return;
    }

    const idempotencyKey = await names.acquireAndCommit(signature, model, null);
    if (!idempotencyKey) return;

    const glossaryEntries = parseGlossary(glossary);
    const style = {
      ...(Object.keys(glossaryEntries).length > 0
        ? { glossary: glossaryEntries }
        : {}),
      ...(charactersPerLine ? { maxCharactersPerLine: charactersPerLine } : {}),
      ...(lines ? { maxLines: lines } : {}),
    };
    const cues = parsed.cues;
    const body = JSON.stringify({
      ...(detectedSourceLanguage
        ? { sourceLanguage: detectedSourceLanguage }
        : {}),
      targetLanguage,
      segments: parsed.segments.map((segment, index) => {
        const cue = cues?.[index];
        return {
          id: segment.id,
          text: segment.text,
          // Sent only when the source carried timings: they are what lets the
          // model keep a line readable in the time its cue is on screen.
          ...(cue && cue.end > cue.start
            ? {
                context: {
                  groupId: segment.id,
                  partIndex: 0,
                  start: cue.start,
                  end: cue.end,
                },
              }
            : {}),
        };
      }),
      ...(Object.keys(style).length > 0 ? { style } : {}),
      ...(model ? { model } : {}),
    });

    setIsPending(true);
    setMessage(null);
    setArriving([]);
    const submittedSource = source;
    try {
      const outcome = await runAiStream<{ segments: TranslatableSegment[] }>(
        "translations",
        {
          body,
          idempotencyKey,
          onEvent: (event, data) => {
            if (event !== "segment") return;
            const segment = data as TranslatableSegment;
            setArriving((current) =>
              current.some((entry) => entry.id === segment.id)
                ? current
                : [...current, { id: segment.id, text: segment.text }],
            );
          },
        },
      );

      if (outcome.ok) {
        setTranslated(
          outcome.result.segments.map((segment) => ({
            id: segment.id,
            text: segment.text,
          })),
        );
        setTranslatedSource(submittedSource);
        names.settle(false);
        return;
      }

      setMessage(t(`api-errors:${outcome.errorCode}`));
      // A run that was cut off, one still going, or one whose paid result could
      // not be read may all be answered by asking again under the same name.
      // None of them is a settlement, so the name stays.
      names.settle(keepsIdempotencyKey(outcome.errorCode));
    } catch {
      // 送れたのかどうかも分からない。名前は捨てないし、次の送信も塞がない。
      names.settle(true);
      setMessage(t("api-errors:aiProviderError"));
    } finally {
      setIsPending(false);
      setArriving([]);
    }
  }

  const parsed = useMemo(() => parseSubtitleSource(source), [source]);
  // "auto" は選び手の言い方で、依頼には何も書かない。この画面は body を自分で
  // 組み立てるので、隠し欄と同じ言い換えをここでもする——そのまま送ると API に
  // 弾かれる。
  const detectedSourceLanguage = sourceLanguage === "auto" ? "" : sourceLanguage;
  // The cues the source carried, so a translation can be written back out as a
  // subtitle file instead of a bare list of strings.
  const sourceCues: SubtitleCue[] | null = parsed.ok ? parsed.cues : null;

  const blocked = blockedReason(
    access,
    ["subtitle.translate"],
    (access.models["subtitle.translate"] ?? []).length === 0,
  );
  // 送るのは読み解いたあとの区切りと語彙集。書き写したままを数えると、送るもの
  // が同じでも別の名前になり、サーバーには同じ依頼が二度届いて二度課金される。
  // 行数や 1 行の長さは入力欄の中にあって描画のたびには読めない——そのぶん粗い
  // が、粗いほうへ外れるのは安全側だ。
  // 送るのは、正の数のときだけ添えられる値。欄に書かれたままを数えると、送る
  // ものが同じでも別の名前になる。
  const charactersPerLine = positiveNumber(maxCharactersPerLine);
  const lines = positiveNumber(maxLines);
  const signature = requestSignature([
    model,
    detectedSourceLanguage,
    targetLanguage,
    charactersPerLine ?? null,
    lines ?? null,
    // 台詞の時刻も依頼の一部。読みやすさをその時間に合わせるために送っている
    // ので、数えないと、時刻だけ違う依頼が同じ名前で送られて断られる。
    ...(parsed.ok
      ? parsed.segments.flatMap((segment, index) => [
        segment.id,
        segment.text,
        sourceCues?.[index]?.start ?? null,
        sourceCues?.[index]?.end ?? null,
      ])
      : [source]),
    // 語彙集は並べ替えてから数える。サーバーは指紋を取るときに鍵を並べ替える
    // ので、行を入れ替えただけでは同じ依頼——数える順を揃えないと、別の名前で
    // 二度課金される。
    ...Object.entries(parseGlossary(glossary))
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .flat(),
  ]);
  useEffect(() => {
    if (names.ready) void names.ensure(signature);
  }, [names.ready, names, signature]);
  const holdsSelectedModel = names.holdsModel(model) || names.hasRestoredModel(model);
  useEffect(() => {
    const corrected = correctedModelId(
      translateModels,
      model,
      holdsSelectedModel,
    );
    if (corrected !== model) setModel(corrected);
  }, [holdsSelectedModel, model, translateModels]);
  const holdsName = names.holds(signature);
  const submitBlocked = blocksSubmit(blocked, holdsName) ||
    !canSubmitModelRequest(
      translateModels,
      model,
      holdsSelectedModel,
      holdsName,
    );
  const models = names.modelsWithHeld(translateModels);
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
      <form onSubmit={handleSubmit} className="flex flex-col gap-4 p-6">
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

        {/* Read in the direction the translation runs: source, arrow, target.
            Laid out as a grid rather than a row of columns so the labels share
            one row and the boxes another: the arrow then lands level with the
            boxes by construction, instead of by a margin that drifts whenever
            the text above or below changes. */}
        <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5">
          <Label htmlFor="sourceLanguage">
            {t("dashboard:ai.sourceLanguage")}
          </Label>
          <span />
          <Label htmlFor="targetLanguage">
            {t("dashboard:ai.targetLanguage")}
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
          <ArrowRight
            aria-hidden
            className="h-4 w-4 shrink-0 text-muted-foreground"
          />
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
        </div>
        {/* "auto" is the picker's word for "say nothing"; the request omits the
            field entirely, which is what the endpoint treats as detect. */}
        <input
          type="hidden"
          name="sourceLanguage"
          value={sourceLanguage === "auto" ? "" : sourceLanguage}
        />
        <input type="hidden" name="targetLanguage" value={targetLanguage} />

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
                value={maxCharactersPerLine}
                onChange={(event) =>
                  setMaxCharactersPerLine(event.target.value)
                }
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
                value={maxLines}
                onChange={(event) => setMaxLines(event.target.value)}
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

        {message && (
          <Alert variant="destructive">
            <AlertTitle>{t("error")}</AlertTitle>
            <AlertDescription>{message}</AlertDescription>
          </Alert>
        )}

        <SubmitButton
          className="w-full"
          forceSpinner={isPending}
          disabled={
            submitBlocked || !parsed.ok || targetLanguage === "" || isPending
          }
        >
          {t("dashboard:ai.translate")}
        </SubmitButton>
      </form>
    </Card>
  );

  const result = isPending ? (
    // What has been translated so far, as it arrives. Until the first line
    // lands there is nothing to show but the wait itself.
    arriving.length > 0 ? (
      <ResultPanel title={t("dashboard:ai.translating")}>
        <p className="text-sm text-muted-foreground">
          {t("dashboard:ai.translatedSoFar", {
            done: arriving.length,
            total: parsed.ok ? parsed.segments.length : arriving.length,
          })}
        </p>
        <ul className="flex flex-col gap-1">
          {arriving.map((segment) => (
            <li
              key={segment.id}
              className="whitespace-pre-wrap rounded-md border bg-background px-2 py-1 text-sm"
            >
              {segment.text}
            </li>
          ))}
        </ul>
        <Shimmer className="h-8 w-full" />
      </ResultPanel>
    ) : (
      <ResultShimmer label={t("dashboard:ai.processing")} />
    )
  ) : translated.length > 0 ? (
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
