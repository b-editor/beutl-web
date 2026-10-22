import { auth } from "@/lib/better-auth";
import { randomString } from "@beutl/core";
import { updateNativeAppAuthCode } from "@beutl/db";
import { nativeAuthCallbackUrl } from "@beutl/core";
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

    // Revalidate persisted URLs too, including rows created before scheme validation.
    return <ClientRedirect url={nativeAuthCallbackUrl(obj.continueUrl, code)} />;
  }
}
