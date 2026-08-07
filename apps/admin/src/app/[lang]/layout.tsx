import type { Metadata } from "next";
import { getTranslation, defaultLanguage } from "@beutl/i18n";

type Props = {
  children: React.ReactNode;
  params: Promise<{
    lang: string;
  }>;
};

export async function generateMetadata(props: Props): Promise<Metadata> {
  const params = await props.params;
  const lang = params.lang ?? defaultLanguage;
  const { t } = await getTranslation(lang);
  return {
    title: "Beutl Admin",
    description: t("admin:nav.dashboard"),
  };
}

export default async function LangLayout(props: Props) {
  const { children } = props;

  return (
    <div className="min-h-screen bg-background text-foreground">
      {children}
    </div>
  );
}
