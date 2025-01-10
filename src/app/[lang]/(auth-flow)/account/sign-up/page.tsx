import { auth } from "@/auth";
import Form from "./form";
import { localRedirect } from "@/lib/localRedirect";

export default async function Page({
  searchParams: { returnUrl, email },
  params: { lang },
}: {
  searchParams: { returnUrl?: string; email?: string };
  params: { lang: string };
}) {
  const session = await auth();
  if (session) {
    localRedirect(returnUrl || "/");
  }

  return <Form returnUrl={returnUrl} email={email} lang={lang} />;
}
