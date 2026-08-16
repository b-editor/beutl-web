import { z } from "zod";

export type TranscriptionSegment = {
  start: number;
  end: number;
  text: string;
};

export type TranscriptionWord = {
  start: number;
  end: number;
  word: string;
};

export type TranscriptionResult = {
  segments: TranscriptionSegment[];
  language?: string;
  words?: TranscriptionWord[];
};

export class InvalidTranscriptionResultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTranscriptionResultError";
  }
}

export const TRANSCRIPTION_TIMESTAMP_TOLERANCE_SECONDS = 0.05;

const transcriptionResponseSchema = z
  .object({
    language: z.unknown().optional(),
    segments: z.array(
      z.object({
        start: z.number().finite().nonnegative(),
        end: z.number().finite().positive(),
        text: z.string(),
      }).passthrough(),
    ).min(1),
    words: z.array(
      z.object({
        start: z.number().finite().nonnegative(),
        end: z.number().finite().positive(),
        word: z.string(),
      }).passthrough(),
    ).optional(),
  })
  .passthrough();

function validateTimedItems<T extends { start: number; end: number }>(
  items: T[],
  durationSeconds: number,
  description: string,
): T[] {
  let previousStart = -1;
  let previousEnd = 0;
  return items.map((item) => {
    if (
      item.end <= item.start ||
      item.end > durationSeconds + TRANSCRIPTION_TIMESTAMP_TOLERANCE_SECONDS ||
      item.start < previousStart ||
      item.end < previousEnd ||
      item.start < previousEnd - TRANSCRIPTION_TIMESTAMP_TOLERANCE_SECONDS
    ) {
      throw new InvalidTranscriptionResultError(
        `Transcription ${description} timestamps are invalid`,
      );
    }
    const normalized = item.end > durationSeconds
      ? { ...item, end: durationSeconds }
      : item;
    previousStart = normalized.start;
    previousEnd = normalized.end;
    return normalized;
  });
}

export function validateTranscriptionResult(
  value: unknown,
  durationSeconds: number,
): TranscriptionResult {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new InvalidTranscriptionResultError("Audio duration is invalid");
  }
  const parsed = transcriptionResponseSchema.safeParse(value);
  if (!parsed.success) {
    throw new InvalidTranscriptionResultError(
      "Transcription response structure is invalid",
    );
  }

  const segments = validateTimedItems(
    parsed.data.segments.map((segment) => ({
      start: segment.start,
      end: segment.end,
      text: segment.text.trim(),
    })),
    durationSeconds,
    "segment",
  );
  if (segments.some((segment) => segment.text.length === 0)) {
    throw new InvalidTranscriptionResultError(
      "Transcription contains an empty segment",
    );
  }

  const words = parsed.data.words === undefined
    ? undefined
    : validateTimedItems(
      parsed.data.words.map((word) => ({
        start: word.start,
        end: word.end,
        word: word.word.trim(),
      })),
      durationSeconds,
      "word",
    );
  if (words?.some((word) => word.word.length === 0)) {
    throw new InvalidTranscriptionResultError(
      "Transcription contains an empty word",
    );
  }

  const detectedLanguage =
    typeof parsed.data.language === "string" &&
      parsed.data.language.trim().length > 0
      ? parsed.data.language.trim()
      : undefined;
  return {
    segments,
    ...(detectedLanguage ? { language: detectedLanguage } : {}),
    ...(words && words.length > 0 ? { words } : {}),
  };
}
