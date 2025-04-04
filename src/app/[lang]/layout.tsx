import type { Metadata } from "next";
import { Noto_Sans_JP } from "next/font/google";
import "../globals.css";
import { Toaster } from "@/components/ui/toaster";
import { SessionProvider } from "next-auth/react";
import { LanguageProvider } from "../i18n/client";
import ProgressBarProvider from "@/components/providers/ProgressBarProvider";
import { getTranslation } from "../i18n/server";

export const runtime = "edge";

const notoSansJP = Noto_Sans_JP({
  subsets: ["latin"],
  variable: "--font-noto-sans-jp",
});

type Props = {
  children: React.ReactNode;
  params: Promise<{
    lang: string;
  }>;
};

export async function generateMetadata(props: Props): Promise<Metadata> {
  const params = await props.params;

  const {
    lang
  } = params;

  const { t } = await getTranslation(lang);
  return {
    metadataBase: process.env.METADATA_BASE_URL ? new URL(process.env.METADATA_BASE_URL) : undefined,
    title: "Beutl",
    description: t("main:description"),
    applicationName: "Beutl",
    openGraph: {
      title: "Beutl",
      description: t("main:description"),
      images: [
        {
          url: `/img/ogp-${lang}.png`,
          width: 2400,
          height: 1260,
        },
      ],
    },
  };
}

export default async function RootLayout(props: Props) {
  const params = await props.params;

  const {
    lang
  } = params;

  const {
    children
  } = props;

  return (
    <html lang={lang} className="dark">
      <body className={`${notoSansJP.variable} antialiased`}>
        <ProgressBarProvider>
          <LanguageProvider initialLanguage={lang}>
            <SessionProvider>
              {children}
              <Toaster />
            </SessionProvider>
          </LanguageProvider>
        </ProgressBarProvider>
      </body>
    </html>
  );
}
