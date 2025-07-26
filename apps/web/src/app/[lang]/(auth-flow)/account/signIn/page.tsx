// デスクトップアプリからのログインページ
// 互換用に残しているが、今後は使わない

import { redirect } from "next/navigation";

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

  redirect(
    `/${lang}/account/native-auth/sign-in?returnUrl=${encodeURIComponent(returnUrl)}`,
  );
}
