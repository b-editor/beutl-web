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
  params: {
    lang: string;
  };
};

export async function generateMetadata({
  params: { lang },
}: Props): Promise<Metadata> {
  const { t } = await getTranslation(lang);
  return {
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

export default function RootLayout({ children, params: { lang } }: Props) {
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
