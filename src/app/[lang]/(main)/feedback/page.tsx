import NavBar from "@/components/nav-bar";
import Footer from "@/components/footer";
import { getTranslation } from "@/app/i18n/server";
import { auth } from "@/lib/better-auth";
import { headers } from "next/headers";
import { FeedbackForm } from "./components";

export default async function Page(props: {
  params: Promise<{ lang: string }>;
  searchParams: Promise<{ traceId?: string }>;
}) {
  const { lang } = await props.params;
  const { traceId } = await props.searchParams;
  const { t } = await getTranslation(lang);

  let defaultName = "";
  let defaultEmail = "";
  try {
    const session = await auth.api.getSession({ headers: await headers() });
    if (session?.user) {
      defaultName = session.user.name || "";
      defaultEmail = session.user.email || "";
    }
  } catch {
    // Anonymous is fine
  }

  return (
    <div>
      <NavBar lang={lang} />
      <div className="container mx-auto px-6 py-12 md:px-12 max-w-2xl">
        <h2 className="font-bold text-2xl">{t("feedback:title")}</h2>
        <p className="text-muted-foreground mt-2">
          {t("feedback:description")}
        </p>
        <FeedbackForm
          lang={lang}
          defaultName={defaultName}
          defaultEmail={defaultEmail}
          traceId={traceId}
          className="mt-6"
        />
      </div>
      <Footer lang={lang} />
    </div>
  );
}
