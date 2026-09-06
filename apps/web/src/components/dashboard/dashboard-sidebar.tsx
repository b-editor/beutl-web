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
  useSidebar,
} from "@beutl/ui/ui/sidebar";
import {
  BookOpen,
  ChevronRight,
  CircleUser,
  Clapperboard,
  Code2,
  CreditCard,
  HardDrive,
  History,
  Image as ImageIcon,
  Languages,
  LayoutDashboard,
  Library,
  LogOut,
  Mail,
  ScrollText,
  Shield,
  Sparkles,
  Store,
  Trash,
  WandSparkles,
  AudioLines,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect } from "react";
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
  const { setOpenMobile } = useSidebar();

  // モバイルではサイドバーが Sheet になる。ダッシュボードの layout は子ルート間の
  // 遷移でマウントされたままなので、閉じないとシートとオーバーレイが遷移先に
  // 残り続ける。
  useEffect(() => {
    setOpenMobile(false);
  }, [pathname, setOpenMobile]);
  // middleware は既定ロケールを redirect ではなく rewrite するため、pathname には
  // ロケール接頭辞が付く場合 (/en/dashboard/storage) と付かない場合
  // (/dashboard/storage) がある。どちらでも動くよう固定インデックスではなく
  // "dashboard" の位置を基準に section を取る。(admin-nav.tsx と同じ手法)
  const segments = pathname?.split("/").filter(Boolean) ?? [];
  const dashboardIndex = segments.indexOf("dashboard");
  const section =
    (dashboardIndex === -1 ? undefined : segments[dashboardIndex + 1]) ??
    "overview";
  const subSlug =
    dashboardIndex === -1 ? undefined : segments[dashboardIndex + 2];

  const items = [
    {
      section: "overview",
      href: `/${lang}/dashboard`,
      label: t("dashboard:nav.overview"),
      icon: LayoutDashboard,
    },
    {
      // AI は機能ごとのページを子に持つので、アカウントと同じ開閉式サブメニューにする。
      section: "ai",
      label: t("dashboard:nav.ai"),
      icon: Sparkles,
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

  const aiItems = [
    {
      slug: "generate",
      label: t("dashboard:ai.imageGeneration"),
      icon: ImageIcon,
    },
    {
      slug: "edit",
      label: t("dashboard:ai.imageEdit"),
      icon: WandSparkles,
    },
    {
      slug: "transcribe",
      label: t("dashboard:ai.transcription"),
      icon: AudioLines,
    },
    {
      slug: "translate",
      label: t("dashboard:ai.translation"),
      icon: Languages,
    },
    {
      slug: "video",
      label: t("dashboard:ai.videoGeneration"),
      icon: Clapperboard,
    },
    {
      slug: "jobs",
      label: t("dashboard:ai.jobHistory"),
      icon: History,
    },
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
    {
      key: "terms",
      href: navHref("terms", lang),
      label: t("terms"),
      icon: ScrollText,
    },
    {
      key: "privacy",
      href: navHref("privacy", lang),
      label: t("privacy"),
      icon: Shield,
    },
    {
      key: "commercialTransactions",
      href: navHref("commercialTransactions", lang),
      label: t("commercialTransactions"),
      icon: ScrollText,
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
              <Link href={`/${lang}/dashboard/account/profile`} prefetch={false}>
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
                item.section === "account" || item.section === "ai" ? (
                  // アカウントと AI は設定/機能ページを子に持つので、shadcn の
                  // nav-main と同じ Collapsible + SidebarMenuSub で開閉する。
                  <Collapsible
                    // defaultOpen は uncontrolled なのでマウント時にしか効かない。
                    // 配下への出入りで張り直し、開閉状態を追従させる。
                    key={`${item.section}-${section === item.section}`}
                    asChild
                    defaultOpen={section === item.section}
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
                          {(item.section === "account" ? accountItems : aiItems).map((sub) => (
                            <SidebarMenuSubItem key={sub.slug}>
                              <SidebarMenuSubButton
                                asChild
                                isActive={subSlug === sub.slug}
                              >
                                <Link
                                  prefetch={false}
                                  href={
                                    item.section === "account"
                                      ? `/${lang}/dashboard/account/${sub.slug}`
                                      : `/${lang}/dashboard/ai/${sub.slug}`
                                  }
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
                      <Link href={item.href} prefetch={false}>
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
                <Link href={item.href} prefetch={false}>
                  <item.icon />
                  <span>{item.label}</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
          <SidebarMenuItem>
            <SidebarMenuButton asChild tooltip={t("signOut")}>
              <Link href={`/${lang}/account/sign-out`} prefetch={false}>
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
