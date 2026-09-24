import { requireAdmin } from "@/lib/auth-guard";
import { AdminSidebar } from "@/components/admin/admin-sidebar";
import { getTranslation } from "@beutl/i18n";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@beutl/ui/ui/sidebar";
import { cookies } from "next/headers";

export default async function Layout(props: {
  children: React.ReactNode;
  params: Promise<{ lang: string }>;
}) {
  const { lang } = await props.params;
  const { children } = props;
  await requireAdmin();
  const { t } = await getTranslation(lang);
  const defaultOpen = (await cookies()).get("sidebar_state")?.value !== "false";

  return (
    <SidebarProvider defaultOpen={defaultOpen}>
      <AdminSidebar lang={lang} />
      <SidebarInset className="min-w-0">
        <header className="flex h-12 shrink-0 items-center border-b px-4">
          <SidebarTrigger aria-label={t("admin:nav.toggleSidebar")} />
          <span className="ml-3 text-sm font-semibold md:hidden">Beutl Admin</span>
        </header>
        <div className="mx-auto w-full max-w-6xl min-w-0 px-4 py-6 md:px-6 md:py-8">
          {children}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
