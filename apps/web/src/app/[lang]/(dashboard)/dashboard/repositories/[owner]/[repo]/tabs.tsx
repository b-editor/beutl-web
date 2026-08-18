"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslation } from "@beutl/ui/i18n-client";
import { cn } from "@beutl/core";
import { FileCode, History, Settings } from "lucide-react";

export function RepositoryTabs({
  lang,
  owner,
  repo,
}: {
  lang: string;
  owner: string;
  repo: string;
}) {
  const { t } = useTranslation(lang);
  const pathname = usePathname() ?? "";
  const base = `/${lang}/dashboard/repositories/${owner}/${repo}`;

  // middleware は既定ロケールを rewrite するため、pathname にロケール接頭辞が
  // 付かないことがある。"repositories" を基準に owner/repo を読み飛ばして、
  // その次のセグメントを見る。リポジトリ名で位置を探すと、名前が "commits" や
  // "settings" のときに誤判定する。
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const rootIndex = segments.indexOf("repositories");
  const section =
    rootIndex === -1 ? undefined : segments[rootIndex + 3];

  const tabs = [
    { key: "files", href: base, label: t("repositories:files"), icon: FileCode },
    {
      key: "commits",
      href: `${base}/commits`,
      label: t("repositories:history"),
      icon: History,
    },
    {
      key: "settings",
      href: `${base}/settings`,
      label: t("repositories:settings"),
      icon: Settings,
    },
  ] as const;

  // ファイル閲覧は tree/ blob/ にも降りるので、それらも「ファイル」に含める。
  const active =
    section === "commits" || section === "settings" ? section : "files";

  return (
    <nav className="flex gap-1 border-b">
      {tabs.map((tab) => (
        <Link
          key={tab.key}
          href={tab.href}
          className={cn(
            "flex items-center gap-2 border-b-2 px-3 py-2 text-sm transition-colors",
            active === tab.key
              ? "border-foreground font-medium"
              : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          <tab.icon className="h-4 w-4" />
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
