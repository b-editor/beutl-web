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
  // pathname は /{lang}/admin/... の形。filter(Boolean) 後は
  // [lang, "admin", section?] となり、section が users / feedback / audit-log。
  // ダッシュボードは /{lang}/admin ちょうど (2 セグメント) のときのみ active。
  const segments = useMemo(() => pathname?.split("/").filter(Boolean) ?? [], [pathname]);
  const slug = segments[2] ?? "admin";
  const isDashboard = segments.length === 2;

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
