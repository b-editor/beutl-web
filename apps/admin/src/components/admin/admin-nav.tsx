"use client";

import { useTranslation } from "@beutl/ui/i18n-client";
import { LayoutDashboard, Users, MessageSquare, ScrollText, LogOut } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo } from "react";
import { cn } from "@beutl/core";

export function AdminNav({ lang }: { lang: string }) {
  const { t } = useTranslation(lang);
  const pathname = usePathname();
  // middleware は既定ロケールを redirect ではなく rewrite するため、pathname には
  // ロケール接頭辞が付く場合 (/ja/admin/users) と付かない場合 (/admin/users) がある。
  // どちらでも動くよう固定インデックスではなく "admin" の位置を基準に section を取る。
  const segments = useMemo(() => pathname?.split("/").filter(Boolean) ?? [], [pathname]);
  const adminIndex = segments.indexOf("admin");
  const slug = (adminIndex === -1 ? undefined : segments[adminIndex + 1]) ?? "admin";
  const isDashboard = adminIndex !== -1 && segments.length === adminIndex + 1;

  const items = [
    { slug: "admin", href: `/${lang}/admin`, label: t("admin:nav.dashboard"), icon: LayoutDashboard },
    { slug: "users", href: `/${lang}/admin/users`, label: t("admin:nav.users"), icon: Users },
    { slug: "feedback", href: `/${lang}/admin/feedback`, label: t("admin:nav.feedback"), icon: MessageSquare },
    { slug: "audit-log", href: `/${lang}/admin/audit-log`, label: t("admin:nav.auditLog"), icon: ScrollText },
  ] as const;

  return (
    <nav className="flex items-center gap-1">
      {items.map((item) => {
        const active =
          item.slug === "admin" ? isDashboard : slug === item.slug;
        return (
          <Link
            key={item.slug}
            href={item.href}
            className={cn(
              "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors",
              active
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
            )}
          >
            <item.icon className="h-4 w-4" />
            <span className="max-md:hidden">{item.label}</span>
          </Link>
        );
      })}
      <Link
        href={`/${lang}/account/sign-out`}
        className="flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
      >
        <LogOut className="h-4 w-4" />
        <span className="max-md:hidden">{t("admin:nav.signOut")}</span>
      </Link>
    </nav>
  );
}
