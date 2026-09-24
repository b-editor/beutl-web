"use client";

import { cn } from "@beutl/core";
import { useTranslation } from "@beutl/ui/i18n-client";
import Link from "next/link";
import { usePathname } from "next/navigation";

export function AiTabs({ lang }: { lang: string }) {
  const { t } = useTranslation(lang);
  // The default locale may be rewritten without a locale prefix.
  const section = (usePathname() ?? "").split("/").filter(Boolean).at(-1);

  const items = [
    { href: `/${lang}/admin/ai`, label: t("admin:ai.tab.settings"), active: section === "ai" },
    {
      href: `/${lang}/admin/ai/usage`,
      label: t("admin:ai.tab.usage"),
      active: section === "usage",
    },
    {
      href: `/${lang}/admin/ai/jobs`,
      label: t("admin:ai.tab.jobs"),
      active: section === "jobs",
    },
  ];

  return (
    <nav className="flex items-center gap-1 border-b">
      {items.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          className={cn(
            "-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors",
            item.active
              ? "border-foreground text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
