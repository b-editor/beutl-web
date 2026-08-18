import type { Metadata } from "next";
import { Noto_Sans_JP } from "next/font/google";
import "../globals.css";
import { Toaster } from "@beutl/ui/ui/toaster";
import ProgressBarProvider from "@beutl/ui/progress-bar-provider";
import { notFound } from "next/navigation";
import { getTranslation, defaultLanguage, isAvailableLanguage } from "@beutl/i18n";

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
  // 404 は middleware により /[lang] 配下へリライトされるが、
  // ルート直下の /_not-found では lang パラメータが解決されないため
  // デフォルト言語にフォールバックする。
  const lang = params.lang ?? defaultLanguage;
  const { t } = await getTranslation(lang);
  return {
    metadataBase: process.env.METADATA_BASE_URL
      ? new URL(process.env.METADATA_BASE_URL)
      : undefined,
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

export default async function LangLayout(props: Props) {
  const params = await props.params;
  // 404 は middleware により /[lang] 配下へリライトされるが、
  // ルート直下の /_not-found では lang パラメータが解決されないため
  // デフォルト言語にフォールバックする。
  const lang = params.lang ?? defaultLanguage;
  // middleware がロケールを付けずに通すパス (/favicon.ico, /robots.txt, /img,
  // /api) は、実体が無いと [lang] に一致してこのツリーへ落ちる。そのまま描画
  // すると存在しないパスがトップページとして 200 で返るため、404 を返す。
  if (!isAvailableLanguage(lang)) {
    notFound();
  }
  const { children } = props;

  return (
    <html lang={lang} className="dark">
      <body className={`${notoSansJP.variable} antialiased`}>
        <ProgressBarProvider>
          {children}
          <Toaster />
        </ProgressBarProvider>
      </body>
    </html>
  );
}
