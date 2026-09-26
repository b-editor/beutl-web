"use client";

import { useTranslation } from "@beutl/ui/i18n-client";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@beutl/ui/ui/collapsible";
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
  ChevronRight,
  CreditCard,
  HardDrive,
  LayoutDashboard,
  LogOut,
  MessageSquare,
  Package,
  ScrollText,
  Sparkles,
  Users,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

type Group = "ai" | "storage" | "payments";

// 開いているのは現在のセクションのグループだけにする。
function groupsOpenFor(section: string | undefined): Record<Group, boolean> {
  return { ai: section === "ai", storage: section === "storage", payments: section === "payments" };
}

export function AdminSidebar({ lang }: { lang: string }) {
  const { t } = useTranslation(lang);
  const pathname = usePathname();
  const { isMobile, open, setOpen, setOpenMobile } = useSidebar();

  useEffect(() => {
    setOpenMobile(false);
  }, [pathname, setOpenMobile]);

  // The default locale may be rewritten without a locale prefix.
  const segments = pathname?.split("/").filter(Boolean) ?? [];
  const adminIndex = segments.indexOf("admin");
  const section = adminIndex < 0 ? undefined : segments[adminIndex + 1];
  const subSection = adminIndex < 0 ? undefined : segments[adminIndex + 2];
  const [openGroups, setOpenGroups] = useState(() => groupsOpenFor(section));

  useEffect(() => {
    setOpenGroups(groupsOpenFor(section));
  }, [section]);

  const items = [
    { section: undefined, href: `/${lang}/admin`, label: t("admin:nav.dashboard"), icon: LayoutDashboard },
    { section: "users", href: `/${lang}/admin/users`, label: t("admin:nav.users"), icon: Users },
    { section: "feedback", href: `/${lang}/admin/feedback`, label: t("admin:nav.feedback"), icon: MessageSquare },
    { section: "packages", href: `/${lang}/admin/packages`, label: t("admin:nav.packages"), icon: Package },
    { section: "ai", label: t("admin:nav.ai"), icon: Sparkles },
    { section: "storage", label: t("admin:nav.storage"), icon: HardDrive },
    { section: "payments", label: t("admin:nav.payments"), icon: CreditCard },
    { section: "audit-log", href: `/${lang}/admin/audit-log`, label: t("admin:nav.auditLog"), icon: ScrollText },
  ] as const;
  const children = {
    ai: [
      { slug: undefined, label: t("admin:ai.tab.settings") },
      { slug: "usage", label: t("admin:ai.tab.usage") },
      { slug: "jobs", label: t("admin:ai.tab.jobs") },
    ],
    storage: [
      { slug: undefined, label: t("admin:storage.files.title") },
      { slug: "usage", label: t("admin:storage.usagePage.title") },
      { slug: "migration", label: t("admin:storage.migration.title") },
      { slug: "interventions", label: t("admin:storage.interventions.title") },
    ],
    payments: [
      { slug: undefined, label: t("admin:payments.title") },
      { slug: "subscriptions", label: t("admin:payments.subscriptions.title") },
    ],
  } as const;

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild tooltip="Beutl Admin">
              <Link href={`/${lang}/admin`} prefetch={false}>
                <span className="flex size-8 shrink-0 items-center justify-center">
                  <Image
                    src="/img/logo_dark.svg"
                    width={24}
                    height={24}
                    className="size-6"
                    alt=""
                  />
                </span>
                <span className="font-semibold">Beutl Admin</span>
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
                !("href" in item) ? (
                  <Collapsible
                    key={item.section}
                    asChild
                    open={openGroups[item.section]}
                    onOpenChange={(nextOpen) =>
                      setOpenGroups((previous) => ({ ...previous, [item.section]: nextOpen }))
                    }
                    className="group/collapsible"
                  >
                    <SidebarMenuItem>
                      {!isMobile && !open ? (
                        <SidebarMenuButton
                          isActive={section === item.section}
                          tooltip={item.label}
                          aria-label={item.label}
                          onClick={() => {
                            setOpenGroups(groupsOpenFor(item.section));
                            setOpen(true);
                          }}
                        >
                          <item.icon />
                          <span>{item.label}</span>
                        </SidebarMenuButton>
                      ) : (
                        <CollapsibleTrigger asChild>
                          <SidebarMenuButton isActive={section === item.section} tooltip={item.label}>
                            <item.icon />
                            <span>{item.label}</span>
                            <ChevronRight className="ml-auto transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90" />
                          </SidebarMenuButton>
                        </CollapsibleTrigger>
                      )}
                      <CollapsibleContent>
                        <SidebarMenuSub>
                          {children[item.section].map((child) => (
                            <SidebarMenuSubItem key={child.slug ?? "index"}>
                              <SidebarMenuSubButton asChild isActive={section === item.section && subSection === child.slug}>
                                <Link href={`/${lang}/admin/${item.section}${child.slug ? `/${child.slug}` : ""}`} prefetch={false}>
                                  <span>{child.label}</span>
                                </Link>
                              </SidebarMenuSubButton>
                            </SidebarMenuSubItem>
                          ))}
                        </SidebarMenuSub>
                      </CollapsibleContent>
                    </SidebarMenuItem>
                  </Collapsible>
                ) : (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton asChild isActive={section === item.section} tooltip={item.label}>
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
          <SidebarMenuItem>
            <SidebarMenuButton asChild tooltip={t("admin:nav.signOut")}>
              <Link href={`/${lang}/account/sign-out`} prefetch={false}>
                <LogOut />
                <span>{t("admin:nav.signOut")}</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
