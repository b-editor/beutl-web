import { redirect } from "next/navigation";

export default function Page({
  params: { lang },
}: { params: { lang: string } }) {
  redirect(`/${lang}/account/manage/profile`);
}
