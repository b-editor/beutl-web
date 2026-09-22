import type { Translator } from "@beutl/i18n";

export function getDashboardGreeting(
  t: Translator,
  name: string | null | undefined,
): string {
  const displayName = name?.trim();
  if (!displayName) return t("dashboard:overview.greetingWithoutName");

  // This string is a React text child, not HTML. Let React escape it once so
  // names containing ampersands or angle brackets stay readable and safe.
  return t("dashboard:overview.greeting", {
    name: displayName,
    interpolation: { escapeValue: false },
  });
}
