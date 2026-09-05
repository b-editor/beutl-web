import type { SubtitleCue } from "./subtitle-format";
import { accountScopedAiStorageKey } from "./ai-browser-storage";

// Transcribing and translating are separate pages, but they are one task: get
// subtitles out of an audio track in another language. Handing the cues over
// through session storage means the second page starts from the first page's
// result instead of the user copying JSON between two tabs.
//
// Session storage, not local storage: this is a leftover from the current
// visit, and transcripts are the user's own speech.

const HANDOFF_NAMESPACE = "beutl:ai:subtitle-handoff";

function handoffKey(userId: string): string {
  return accountScopedAiStorageKey(HANDOFF_NAMESPACE, userId);
}

export type SubtitleHandoff = {
  cues: SubtitleCue[];
  // Shown so the translate page can say what it picked up.
  sourceName: string | null;
};

export function saveSubtitleHandoff(
  userId: string,
  handoff: SubtitleHandoff,
): boolean {
  if (typeof window === "undefined") return false;
  try {
    window.sessionStorage.setItem(handoffKey(userId), JSON.stringify(handoff));
    return true;
  } catch {
    return false;
  }
}

export function loadSubtitleHandoff(userId: string): SubtitleHandoff | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(handoffKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object") return null;
    const record = parsed as { cues?: unknown; sourceName?: unknown };
    if (!Array.isArray(record.cues) || record.cues.length === 0) return null;
    const cues = record.cues.filter(
      (cue): cue is SubtitleCue =>
        cue !== null &&
        typeof cue === "object" &&
        typeof (cue as SubtitleCue).start === "number" &&
        typeof (cue as SubtitleCue).end === "number" &&
        typeof (cue as SubtitleCue).text === "string",
    );
    if (cues.length === 0) return null;
    return {
      cues,
      sourceName:
        typeof record.sourceName === "string" ? record.sourceName : null,
    };
  } catch {
    return null;
  }
}

export function clearSubtitleHandoff(userId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(handoffKey(userId));
  } catch {
    // Nothing to clean up when storage is unavailable.
  }
}
