import { auth } from "@/lib/better-auth";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { resolveNativeAuthReturnUrl } from "@beutl/next/local-redirect";

export default async function Page(
  props: {
    searchParams: Promise<{ returnUrl: string }>;
    params: Promise<{ lang: string }>;
  }
) {
  const params = await props.params;

  const {
    lang
  } = params;

  const searchParams = await props.searchParams;

  const {
    returnUrl
  } = searchParams;

  // 旧デスクトップ (/account/signIn) の譲渡ページ。返り先
  // (createAuthUri が返した handler URL = 同一オリジンのサイト内パス) を
  // native-auth の許可で検証し、そのまま接続する。同意は handler の
  // カードで 1 度だけ行うため continue 画面は挟まない。
  const session = await auth.api.getSession({ headers: await headers() });
  if (session?.user) {
    redirect((await resolveNativeAuthReturnUrl(returnUrl)) ?? `/${lang}`);
  }

  redirect(`/${lang}/account/sign-in?returnUrl=${encodeURIComponent(returnUrl)}`);
}
