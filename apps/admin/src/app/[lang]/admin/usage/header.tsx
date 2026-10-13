import Link from "next/link";
import { getTranslation } from "@beutl/i18n";
import { DESKTOP_USAGE_RANGES, type DesktopUsageRange } from "../../../../lib/desktop-usage";
import type { DesktopErrorFilter } from "../../../../lib/desktop-errors";

export async function DesktopUsageHeader({
  lang,
  range,
  tab = "usage",
  level = "all",
}: {
  lang: string;
  range: DesktopUsageRange;
  tab?: "usage" | "errors";
  level?: DesktopErrorFilter;
}) {
  const { t } = await getTranslation(lang);
  const base = `/${lang}/admin/usage`;
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <h1 className="text-2xl font-bold">{t("admin:desktopUsage.title")}</h1>
        <nav
          aria-label={t("admin:desktopUsage.rangeLabel")}
          className="flex gap-1 rounded-lg border p-1"
        >
          {DESKTOP_USAGE_RANGES.map((value) => (
            <Link
              key={value}
              href={`${base}?range=${value}${tab === "errors" ? `&tab=errors&level=${level}` : ""}`}
              prefetch={false}
              aria-current={value === range ? "page" : undefined}
              className={`rounded-md px-3 py-2 text-sm ${value === range ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
            >
              {t(`admin:desktopUsage.range.${value}`)}
            </Link>
          ))}
        </nav>
      </div>
      <nav aria-label={t("admin:desktopUsage.tabs.label")} className="flex gap-4 border-b">
        {(["usage", "errors"] as const).map((value) => (
          <Link
            key={value}
            href={`${base}?range=${range}${value === "errors" ? "&tab=errors" : ""}`}
            prefetch={false}
            aria-current={value === tab ? "page" : undefined}
            className={`border-b-2 px-1 pb-3 text-sm font-medium ${value === tab ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"}`}
          >
            {t(`admin:desktopUsage.tabs.${value}`)}
          </Link>
        ))}
      </nav>
    </>
  );
}
