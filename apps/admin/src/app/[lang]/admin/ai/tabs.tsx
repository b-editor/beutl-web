"use client";

import { cn } from "@beutl/core";
import { useTranslation } from "@beutl/ui/i18n-client";
import Link from "next/link";
import { usePathname } from "next/navigation";

// middleware は既定ロケールを rewrite するため、pathname にロケール接頭辞が
// 付く場合と付かない場合がある。末尾のセグメントだけで現在地を判定する。
function isUsagePath(pathname: string | null): boolean {
  return (pathname ?? "").split("/").filter(Boolean).at(-1) === "usage";
}

export function AiTabs({ lang }: { lang: string }) {
  const { t } = useTranslation(lang);
  const usage = isUsagePath(usePathname());

  const items = [
    { href: `/${lang}/admin/ai`, label: t("admin:ai.tab.settings"), active: !usage },
    {
      href: `/${lang}/admin/ai/usage`,
      label: t("admin:ai.tab.usage"),
      active: usage,
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
