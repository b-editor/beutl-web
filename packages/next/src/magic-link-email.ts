import "server-only";
import { emailButton, sendEmail } from "@beutl/email";
import { getTranslation } from "@beutl/i18n";
import { getLanguageFromPathname, resolveLanguage } from "@beutl/i18n/language";

type MagicLinkContext = {
  headers?: Headers | undefined;
  request?: Request | undefined;
};

// サインイン画面は callbackURL に必ず `/${lang}` 接頭辞付きのパスを渡す
// (apps/*/account/sign-in/actions.ts)。マジックリンクの URL にはそれが
// クエリとして残るので、まずそこから言語を取り、無ければ Accept-Language で決める。
export function resolveMagicLinkLanguage(
  url: string,
  ctx?: MagicLinkContext,
): string {
  const callbackURL = new URL(url).searchParams.get("callbackURL");
  if (callbackURL) {
    const pathname = new URL(callbackURL, "http://localhost").pathname;
    const fromCallback = getLanguageFromPathname(pathname);
    if (fromCallback) return fromCallback;
  }
  const acceptLanguage =
    ctx?.headers?.get("accept-language") ??
    ctx?.request?.headers.get("accept-language");
  return resolveLanguage({ acceptLanguage });
}

// better-auth の magicLink プラグインに渡す sendMagicLink。公開サイトと管理 Worker で
// 同じメールを送るため共有する。
export async function sendMagicLinkEmail(
  { email, url }: { email: string; url: string },
  ctx?: MagicLinkContext,
): Promise<void> {
  const lang = resolveMagicLinkLanguage(url, ctx);
  const { t } = await getTranslation(lang);
  const { host } = new URL(url);
  await sendEmail({
    to: email,
    subject: t("auth:magicLink.subject", { host }),
    body: `
      <p>${t("auth:magicLink.body")}</p>
      ${emailButton(url, t("auth:signIn"))}
    `,
    lang,
  });
}
