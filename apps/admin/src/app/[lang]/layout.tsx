import type { Metadata } from "next";
import "../globals.css";
import { Toaster } from "@beutl/ui/ui/toaster";
import ProgressBarProvider from "@beutl/ui/progress-bar-provider";
import { notFound } from "next/navigation";
import { getTranslation, defaultLanguage, isAvailableLanguage } from "@beutl/i18n";

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
    applicationName: "Beutl Admin",
    // 管理画面は検索エンジンに載せない。
    robots: { index: false, follow: false },
  };
}

export default async function LangLayout(props: Props) {
  const params = await props.params;
  // 404 は middleware により /[lang] 配下へリライトされるが、
  // ルート直下の /_not-found では lang パラメータが解決されないため
  // デフォルト言語にフォールバックする。
  const lang = params.lang ?? defaultLanguage;
  // middleware がロケールを付けずに通すパス (/favicon.ico, /robots.txt, /img,
  // /api) は、実体が無いと [lang] に一致してこのツリーへ落ちる。ブラウザが
  // 自動で投げる /favicon.ico がその代表で、言語として扱えない値のまま描画に
  // 進むと Intl が例外を投げて 500 になる。存在しないパスなので 404 を返す。
  if (!isAvailableLanguage(lang)) {
    notFound();
  }
  const { children } = props;

  return (
    <html lang={lang} className="dark">
      <body className="antialiased">
        <ProgressBarProvider>
          <div className="min-h-screen bg-background text-foreground">
            {children}
          </div>
          <Toaster />
        </ProgressBarProvider>
      </body>
    </html>
  );
}
