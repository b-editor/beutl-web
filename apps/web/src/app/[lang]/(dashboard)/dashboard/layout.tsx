import { authOrSignIn } from "@/lib/auth-guard";
import { DashboardSidebar } from "@/components/dashboard/dashboard-sidebar";
import { getTranslation } from "@beutl/i18n";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@beutl/ui/ui/sidebar";
import { cookies } from "next/headers";

// ダッシュボードはサイト共通の NavBar を出さず、サイドバーだけをシェルにする。
export default async function Layout(props: {
  children: React.ReactNode;
  params: Promise<{ lang: string }>;
}) {
  const { lang } = await props.params;
  // ダッシュボード配下は全ページ認証必須。getSession は React cache 済みなので、
  // 配下の page が改めて authOrSignIn() を呼んでもセッション取得は 1 回で済む。
  const session = await authOrSignIn();
  const { t } = await getTranslation(lang);

  // SidebarProvider はクライアント側で sidebar_state クッキーを書くだけで読まない。
  // 初回描画から開閉状態を復元するためサーバー側で読む。
  const defaultOpen = (await cookies()).get("sidebar_state")?.value !== "false";

  return (
    <SidebarProvider defaultOpen={defaultOpen}>
      <DashboardSidebar
        lang={lang}
        user={{
          name: session.user?.name,
          email: session.user?.email,
          image: session.user?.image,
        }}
      />
      <SidebarInset>
        <header className="flex h-12 shrink-0 items-center border-b px-4">
          <SidebarTrigger aria-label={t("dashboard:toggleSidebar")} />
        </header>
        <div className="mx-auto w-full max-w-6xl px-4 py-6 md:px-6 md:py-8">
          {props.children}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
