"use client";

import { useTranslation } from "@beutl/ui/i18n-client";
import { Avatar, AvatarFallback, AvatarImage } from "@beutl/ui/ui/avatar";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@beutl/ui/ui/collapsible";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@beutl/ui/ui/sidebar";
import {
  BookOpen,
  ChevronRight,
  CircleUser,
  Code2,
  CreditCard,
  HardDrive,
  LayoutDashboard,
  Library,
  LogOut,
  Mail,
  Shield,
  Store,
  Trash,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { navHref } from "@/components/site-links";

export type SidebarUser = {
  name?: string | null;
  email?: string | null;
  image?: string | null;
};

export function DashboardSidebar({
  lang,
  user,
}: {
  lang: string;
  user: SidebarUser;
}) {
  const { t } = useTranslation(lang);
  const pathname = usePathname();
  // middleware は既定ロケールを redirect ではなく rewrite するため、pathname には
  // ロケール接頭辞が付く場合 (/en/dashboard/storage) と付かない場合
  // (/dashboard/storage) がある。どちらでも動くよう固定インデックスではなく
  // "dashboard" の位置を基準に section を取る。(admin-nav.tsx と同じ手法)
  const segments = pathname?.split("/").filter(Boolean) ?? [];
  const dashboardIndex = segments.indexOf("dashboard");
  const section =
    (dashboardIndex === -1 ? undefined : segments[dashboardIndex + 1]) ??
    "overview";
  const accountSlug =
    dashboardIndex === -1 ? undefined : segments[dashboardIndex + 2];

  const items = [
    {
      section: "overview",
      href: `/${lang}/dashboard`,
      label: t("dashboard:nav.overview"),
      icon: LayoutDashboard,
    },
    {
      section: "storage",
      href: `/${lang}/dashboard/storage`,
      label: t("dashboard:nav.storage"),
      icon: HardDrive,
    },
    {
      section: "library",
      href: `/${lang}/dashboard/library`,
      label: t("dashboard:nav.library"),
      icon: Library,
    },
    {
      section: "developer",
      href: `/${lang}/dashboard/developer`,
      label: t("dashboard:nav.developer"),
      icon: Code2,
    },
    {
      // アカウントだけは遷移先を持たず、サブメニューを開くトリガーになる。
      section: "account",
      label: t("dashboard:nav.account"),
      icon: CircleUser,
    },
  ] as const;

  const accountItems = [
    { slug: "profile", label: t("account:profile.title"), icon: CircleUser },
    { slug: "email", label: t("account:email.title"), icon: Mail },
    { slug: "billing", label: t("account:billing.title"), icon: CreditCard },
    { slug: "security", label: t("account:security.title"), icon: Shield },
    { slug: "personal-data", label: t("account:data.title"), icon: Trash },
  ] as const;

  const siteItems = [
    {
      key: "docs",
      href: navHref("docs", lang),
      label: t("docs"),
      icon: BookOpen,
    },
    {
      key: "store",
      href: navHref("store", lang),
      label: t("store"),
      icon: Store,
    },
  ] as const;

  const displayName = user.name ?? user.email ?? "";

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            {/* 選択状態は下のメニューが持つので、ここは素性の表示に徹する。 */}
            <SidebarMenuButton size="lg" asChild tooltip={displayName}>
              <Link href={`/${lang}/dashboard/account/profile`}>
                <Avatar className="h-8 w-8 shrink-0 rounded-lg">
                  {user.image && (
                    <AvatarImage src={user.image} alt={displayName} />
                  )}
                  <AvatarFallback className="rounded-lg">
                    <CircleUser className="h-4 w-4" />
                  </AvatarFallback>
                </Avatar>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-semibold">{displayName}</span>
                  {user.email && (
                    <span className="truncate text-xs text-muted-foreground">
                      {user.email}
                    </span>
                  )}
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {items.map((item) =>
                item.section === "account" ? (
                  // アカウントは設定ページを子に持つので、shadcn の nav-main と
                  // 同じ Collapsible + SidebarMenuSub で開閉する。
                  <Collapsible
                    key={item.section}
                    asChild
                    defaultOpen={section === "account"}
                    className="group/collapsible"
                  >
                    <SidebarMenuItem>
                      <CollapsibleTrigger asChild>
                        <SidebarMenuButton
                          isActive={section === item.section}
                          tooltip={item.label}
                        >
                          <item.icon />
                          <span>{item.label}</span>
                          <ChevronRight className="ml-auto transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90" />
                        </SidebarMenuButton>
                      </CollapsibleTrigger>
                      <CollapsibleContent>
                        <SidebarMenuSub>
                          {accountItems.map((sub) => (
                            <SidebarMenuSubItem key={sub.slug}>
                              <SidebarMenuSubButton
                                asChild
                                isActive={accountSlug === sub.slug}
                              >
                                <Link
                                  href={`/${lang}/dashboard/account/${sub.slug}`}
                                >
                                  <sub.icon />
                                  <span>{sub.label}</span>
                                </Link>
                              </SidebarMenuSubButton>
                            </SidebarMenuSubItem>
                          ))}
                        </SidebarMenuSub>
                      </CollapsibleContent>
                    </SidebarMenuItem>
                  </Collapsible>
                ) : (
                  <SidebarMenuItem key={item.section}>
                    <SidebarMenuButton
                      asChild
                      isActive={section === item.section}
                      tooltip={item.label}
                    >
                      <Link href={item.href}>
                        <item.icon />
                        <span>{item.label}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ),
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          {/* ダッシュボードは共通の NavBar を出さないので、公開サイトへの出口を
              ここに置く。項目は NavBar の公開リンクと揃える。 */}
          {siteItems.map((item) => (
            <SidebarMenuItem key={item.key}>
              <SidebarMenuButton asChild tooltip={item.label}>
                <Link
                  href={item.href}
                  prefetch={item.key === "docs" ? false : undefined}
                >
                  <item.icon />
                  <span>{item.label}</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
          <SidebarMenuItem>
            <SidebarMenuButton asChild tooltip={t("signOut")}>
              <Link href={`/${lang}/account/sign-out`}>
                <LogOut />
                <span>{t("signOut")}</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
