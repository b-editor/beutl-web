import { auth } from "@/lib/better-auth";
import { randomString } from "@/lib/create-hash";
import { updateNativeAppAuthCode } from "@/lib/db/native-app-auth";
import { isAllowedContinueUrlHost } from "@/lib/native-auth";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { ClientRedirect } from "./components";

export default async function Page(
  props: {
    searchParams: Promise<{ identifier: string }>;
    params: Promise<{ lang: string }>;
  }
) {
  const params = await props.params;

  const {
    lang
  } = params;

  const searchParams = await props.searchParams;

  const {
    identifier
  } = searchParams;

  const headersList = await headers();
  const session = await auth.api.getSession({ headers: headersList });
  const xurl = headersList.get("x-url") as string;
  if (!session?.user) {
    const continueUrl = `/${lang}/account/native-auth/continue?returnUrl=${encodeURIComponent(xurl)}`;

    redirect(
      `/${lang}/account/sign-in?returnUrl=${encodeURIComponent(continueUrl)}`,
    );
  } else {
    if (!session.user.id) {
      throw new Error("User id is not found");
    }

    const code = randomString(32);
    const userId = session.user.id;
    const codeExpires = new Date(Date.now() + 1000 * 60 * 30);
    const obj = await updateNativeAppAuthCode({
      id: identifier,
      userId,
      codeExpires,
      code,
    });

    const continueUrl = new URL(obj.continueUrl, xurl);
    continueUrl.searchParams.set("code", code);
    // continueUrl のホストが許可リストに含まれるか検証する
    if (!isAllowedContinueUrlHost(continueUrl.hostname)) {
      throw new Error("Invalid continue URL");
    }
    return <ClientRedirect url={continueUrl.toString()} />;
  }
}
