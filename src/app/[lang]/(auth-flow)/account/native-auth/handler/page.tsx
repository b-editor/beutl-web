import { auth } from "@/lib/better-auth";
import { randomString } from "@/lib/create-hash";
import { getDb } from "@/db";
import { nativeAppAuth } from "@/db/schema";
import { eq } from "drizzle-orm";
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
    const db = getDb();
    const [obj] = await db
      .update(nativeAppAuth)
      .set({
        userId: session.user.id,
        codeExpires: new Date(Date.now() + 1000 * 60 * 30),
        code,
      })
      .where(eq(nativeAppAuth.id, identifier))
      .returning();

    const continueUrl = new URL(obj.continueUrl, xurl);
    continueUrl.searchParams.set("code", code);
    // localhostかを判定
    if (continueUrl.hostname !== "localhost") {
      throw new Error("Invalid continue URL");
    }
    // redirect(continueUrl.toString());
    return <ClientRedirect url={continueUrl.toString()} />;
  }
}
