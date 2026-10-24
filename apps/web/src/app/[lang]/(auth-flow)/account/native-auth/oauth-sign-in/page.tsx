import { redirect } from "next/navigation";
import { getAuth } from "@/lib/better-auth";
import { readNativeOAuthQuery } from "@/lib/native-oauth";

export default async function Page({
  searchParams,
  params,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
  params: Promise<{ lang: string }>;
}) {
  const { lang } = await params;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value])
      query.append(key, item);
  }
  const instance = await getAuth();
  if (!(await readNativeOAuthQuery(query.toString(), (await instance.$context).secret)))
    redirect(`/${lang}/account/sign-in`);
  redirect(
    `/${lang}/account/sign-in?returnUrl=${encodeURIComponent(`/api/auth/oauth2/authorize?${query}`)}`,
  );
}
