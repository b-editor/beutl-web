// デスクトップアプリからのログインページ
// 互換用に残しているが、今後は使わない

import { redirect } from "next/navigation";

export default function Page({
  searchParams: { returnUrl },
  params: { lang },
}: {
  searchParams: { returnUrl: string };
  params: { lang: string };
}) {
  redirect(
    `/${lang}/account/native-auth/sign-in?returnUrl=${encodeURIComponent(returnUrl)}`,
  );
}
