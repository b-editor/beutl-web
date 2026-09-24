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
  ScrollText,
  Sparkles,
  Users,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect } from "react";

export function AdminSidebar({ lang }: { lang: string }) {
  const { t } = useTranslation(lang);
  const pathname = usePathname();
  const { setOpenMobile } = useSidebar();

  useEffect(() => {
    setOpenMobile(false);
  }, [pathname, setOpenMobile]);

  // The default locale may be rewritten without a locale prefix.
  const segments = pathname?.split("/").filter(Boolean) ?? [];
  const adminIndex = segments.indexOf("admin");
  const section = adminIndex < 0 ? undefined : segments[adminIndex + 1];
  const subSection = adminIndex < 0 ? undefined : segments[adminIndex + 2];

  const items = [
    { section: undefined, href: `/${lang}/admin`, label: t("admin:nav.dashboard"), icon: LayoutDashboard },
    { section: "users", href: `/${lang}/admin/users`, label: t("admin:nav.users"), icon: Users },
    { section: "feedback", href: `/${lang}/admin/feedback`, label: t("admin:nav.feedback"), icon: MessageSquare },
    { section: "ai", label: t("admin:nav.ai"), icon: Sparkles },
    { section: "storage", label: t("admin:nav.storage"), icon: HardDrive },
    { section: "payments", href: `/${lang}/admin/payments`, label: t("admin:nav.payments"), icon: CreditCard },
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
                item.section === "ai" || item.section === "storage" ? (
                  <Collapsible
                    key={`${item.section}-${section === item.section}`}
                    asChild
                    defaultOpen={section === item.section}
                    className="group/collapsible"
                  >
                    <SidebarMenuItem>
                      <CollapsibleTrigger asChild>
                        <SidebarMenuButton isActive={section === item.section} tooltip={item.label}>
                          <item.icon />
                          <span>{item.label}</span>
                          <ChevronRight className="ml-auto transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90" />
                        </SidebarMenuButton>
                      </CollapsibleTrigger>
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
