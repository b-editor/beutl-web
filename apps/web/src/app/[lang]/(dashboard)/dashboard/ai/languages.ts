import "server-only";
import { ISO_639_1_LANGUAGE_CODES } from "@beutl/core";
import type { LanguageOption } from "./translate-form";

// The languages by name, in the reader's own language, ordered as that language
// orders them. A code says nothing to someone who does not already know it.
//
// Resolved here rather than in the form because Intl carries different display
// data per runtime — this server names every code, a browser may not name the
// rarest — and a list built on both sides would render one label during
// hydration and another after it.
export function languageOptions(lang: string): LanguageOption[] {
  let nameOf: (code: string) => string;
  try {
    const display = new Intl.DisplayNames([lang], { type: "language" });
    nameOf = (code) => display.of(code) ?? code;
  } catch {
    // Without display names the codes are still selectable, which is what this
    // control offered before.
    nameOf = (code) => code;
  }
  const named = ISO_639_1_LANGUAGE_CODES.map((code) => ({
    code,
    name: nameOf(code),
  }));
  // Two codes can share a name — Akan is both ak and tw — and two identical
  // rows in a list leave nothing to choose between.
  const uses = new Map<string, number>();
  for (const language of named) {
    uses.set(language.name, (uses.get(language.name) ?? 0) + 1);
  }
  return named
    .map((language) => ({
      code: language.code,
      name:
        (uses.get(language.name) ?? 0) > 1
          ? `${language.name} (${language.code})`
          : language.name,
    }))
    .sort((left, right) => left.name.localeCompare(right.name, lang));
}
