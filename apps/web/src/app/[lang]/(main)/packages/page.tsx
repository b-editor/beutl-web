import { redirect } from "next/navigation";

export default async function Page({ params, searchParams }: {
  params: Promise<{ lang: string }>;
  searchParams: Promise<{ q?: string; page?: string }>;
}) {
  const { lang } = await params;
  const { q, page } = await searchParams;
  const query = new URLSearchParams({ type: "development" });
  if (q) query.set("query", q);
  if (page) query.set("page", page);
  redirect(`/${lang}/store?${query}`);
}
