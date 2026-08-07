import { requireAdmin } from "@/lib/auth-guard";
import { AdminNav } from "@/components/admin/admin-nav";

export default async function Layout(props: {
  children: React.ReactNode;
  params: Promise<{ lang: string }>;
}) {
  const { lang } = await props.params;
  const { children } = props;
  await requireAdmin();

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-20 border-b bg-background">
        <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-4 md:px-6">
          <div className="flex items-center gap-2 font-semibold">
            Beutl Admin
          </div>
          <AdminNav lang={lang} />
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-8 md:px-6">{children}</main>
    </div>
  );
}
