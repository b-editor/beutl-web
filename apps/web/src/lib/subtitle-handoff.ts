import type { SubtitleCue } from "./subtitle-format";

// Transcribing and translating are separate pages, but they are one task: get
// subtitles out of an audio track in another language. Handing the cues over
// through session storage means the second page starts from the first page's
// result instead of the user copying JSON between two tabs.
//
// Session storage, not local storage: this is a leftover from the current
// visit, and transcripts are the user's own speech.

const HANDOFF_KEY = "beutl:ai:subtitle-handoff";

export type SubtitleHandoff = {
  cues: SubtitleCue[];
  // Shown so the translate page can say what it picked up.
  sourceName: string | null;
};

export function saveSubtitleHandoff(handoff: SubtitleHandoff): boolean {
  if (typeof window === "undefined") return false;
  try {
    window.sessionStorage.setItem(HANDOFF_KEY, JSON.stringify(handoff));
    return true;
  } catch {
    return false;
  }
}

export function loadSubtitleHandoff(): SubtitleHandoff | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(HANDOFF_KEY);
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

export function clearSubtitleHandoff(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(HANDOFF_KEY);
  } catch {
    // Nothing to clean up when storage is unavailable.
  }
}
