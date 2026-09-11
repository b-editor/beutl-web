// AUTH_RESEND_KEY を読むため、クライアントバンドルに入らないことを保証する。
import "server-only";
import {
  getTranslation,
  defaultLanguage,
  type AvailableLanguage,
} from "@beutl/i18n";
import { emailAssets, type EmailAssetKey } from "./assets";

const SITE_URL = "https://beutl.beditor.net";

// apps/web/src/app/globals.css の `.dark` トークンを hex にしたもの。Web はダーク固定で
// 描画されるので、メールも同じ地色に置く。メールクライアントは CSS 変数や hsl() を
// 落とすことがあるため、ここでは値をベタ書きする。
const palette = {
  background: "#0a0911", // --background: 249 30% 5%
  card: "#100f14", // --card: 249 14% 7%
  foreground: "#eeecf9", // --foreground: 249 50% 95%
  mutedForeground: "#a9a4c6", // --muted-foreground: 249 23% 71%
  primary: "#6c59f7", // --primary: 247 91% 66%
  primaryForeground: "#f8f7fc", // --primary-foreground: 249 50% 98%
  // --border は白の 9% 透過。半透明を落とすクライアントがあるので、
  // --sidebar-border と同じくカード地に潰した不透明色を使う。
  border: "#242329",
} as const;

const fontFamily =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans JP', 'Hiragino Sans', Roboto, 'Helvetica Neue', Arial, sans-serif";

type SendEmailParams = {
  to: string;
  subject: string;
  /** 信頼できる HTML 断片。ユーザー入力を含める場合は呼び出し側でエスケープする。 */
  body: string;
  /** フッターのリンク文言に使う。省略時は既定言語。 */
  lang?: AvailableLanguage;
};

export async function sendEmail(params: SendEmailParams) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: options.from,
      to: params.to,
      subject: params.subject,
      text: htmlToPlainText(params.body),
      html: await renderUnsafeEmailTemplate(
        params.body,
        params.lang ?? defaultLanguage,
      ),
      // ロゴと SNS アイコンは cid: 参照のインライン添付にする。サイト側の配信に
      // 依存しないので、デプロイ前後や画像プロキシの都合で欠けることがない。
      attachments: Object.entries(emailAssets).map(([key, asset]) => ({
        filename: asset.filename,
        content: asset.base64,
        content_type: asset.contentType,
        content_id: assetContentId(key as EmailAssetKey),
      })),
    }),
  });

  if (!res.ok)
    throw new Error(`Resend error: ${JSON.stringify(await res.json())}`);
}

const options = {
  from: "Beutl <noreply@notifications.beditor.net>",
  apiKey: process.env.AUTH_RESEND_KEY as string,
};

function assetContentId(key: EmailAssetKey): string {
  return `beutl-email-${key}`;
}

/**
 * 同梱画像の <img>。macOS の Mail はインライン添付の width 属性を無視して原寸で
 * 出すことがあるので、CSS の width/height も併記する。
 */
function assetImg(key: EmailAssetKey, alt: string): string {
  const { size } = emailAssets[key];
  return `<img src="cid:${assetContentId(key)}" width="${size}" height="${size}" alt="${escapeAttribute(alt)}" style="display: block; border: 0; width: ${size}px; height: ${size}px;">`;
}

/**
 * 1px の罫線。Gmail (iOS) は border の色も反転するので、反転されない gradient 背景の
 * セルで描く。
 */
function rule(): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td height="1" style="height: 1px; font-size: 1px; line-height: 1px; ${surface(palette.border)}">&nbsp;</td>
                </tr>
              </table>`;
}

/**
 * 色付きの面に使う背景指定。
 *
 * Gmail (iOS) のダークモードは色を独自に反転するが、`background-image` の
 * linear-gradient は触らない。ベタ塗りの gradient を重ねて Web と同じ地色を保つ。
 * https://www.hteumeuleu.com/2021/fixing-gmail-dark-mode-css-blend-modes/
 */
function surface(color: string): string {
  return `background-color: ${color}; background-image: linear-gradient(${color}, ${color});`;
}

/**
 * Gmail (iOS) が白い文字を黒に反転するのを、blend mode で元に戻すためのラッパー。
 * Gmail 以外では素の div なので何も変わらない。`u + .body` は Gmail が DOCTYPE を
 * `<u></u>` に置き換えることを利用した Gmail 専用セレクタで、head の CSS で効かせる。
 *
 * 仕組み: Gmail が文字を黒、ラッパーの #000 背景を白に反転したあと、
 * difference で (白背景, 黒文字) → (黒背景, 白文字)、screen で黒背景が外側の面の色に
 * 透ける。したがって中に入れるのは白い文字だけで、色付きの面 (ボタン等) は入れない。
 */
function gmailText(inner: string): string {
  return `<div class="gmail-blend-screen"><div class="gmail-blend-difference">${inner}</div></div>`;
}

const BUTTON_CLASS = "email-button";

/**
 * Web の `<Button>` (variant=default, size=default) と同じ見た目のリンクボタン。
 * `<a>` に display:inline-block を効かせないクライアントがあるため table で組む。
 * 本文の中で単独の table として置かれる前提で、テンプレート側は本文をこの table の
 * 前後で分割し、文字だけを gmailText で包む。
 */
export function emailButton(href: string, label: string): string {
  return `<table role="presentation" class="${BUTTON_CLASS}" cellpadding="0" cellspacing="0" border="0" style="margin: 24px 0 8px;">
  <tr>
    <td bgcolor="${palette.primary}" style="${surface(palette.primary)} border-radius: 6px;">
      ${gmailText(`<a href="${escapeAttribute(href)}" target="_blank" style="display: inline-block; padding: 10px 16px; font-family: ${fontFamily}; font-size: 14px; font-weight: 500; line-height: 20px; color: ${palette.primaryForeground}; text-decoration: none; border-radius: 6px;">${escapeHtml(label)}</a>`)}
    </td>
  </tr>
</table>`;
}

/**
 * 本文をボタン table とそれ以外に分け、文字の部分だけ gmailText で包む。
 * ボタンは自分の面の中で blend を解決しているので、外側で二重に包まない。
 */
function wrapContentForGmail(content: string): string {
  const buttonPattern = new RegExp(
    `(<table[^>]*class="${BUTTON_CLASS}"[\\s\\S]*?</table>)`,
  );
  return content
    .split(buttonPattern)
    .map((segment) => {
      // split の捕捉グループで返るボタン table はそのまま、文字の断片だけ包む
      if (segment.startsWith("<table") && segment.includes(BUTTON_CLASS)) {
        return segment;
      }
      return segment.trim() ? gmailText(segment) : segment;
    })
    .join("");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/'/g, "&#39;");
}

/**
 * HTML 本文から text/plain 版を作る。リンクは「文言: URL」の形に残し、
 * ブロック要素の切れ目を改行にする。
 */
function htmlToPlainText(html: string): string {
  return html
    .replace(
      /<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
      (_, href: string, label: string) => {
        const text = label.replace(/<[^>]+>/g, "").trim();
        return text && text !== href ? `${text}: ${href}` : href;
      },
    )
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr|table)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function renderUnsafeEmailTemplate(
  content: string,
  lang: AvailableLanguage,
): Promise<string> {
  const { t } = await getTranslation(lang);
  const year = new Date().getFullYear();

  // apps/web/src/components/site-links.ts の socialLinks と同じ並び。
  const socialLinks: { href: string; icon: EmailAssetKey; label: string }[] = [
    { href: "https://github.com/b-editor", icon: "github", label: "GitHub" },
    { href: "https://x.com/yuto_daisensei", icon: "x", label: "X" },
    { href: "https://discord.gg/Bm3pnVc928", icon: "discord", label: "Discord" },
  ];
  const footerLinks = [
    { href: `${SITE_URL}/${lang}/docs/terms`, label: t("terms") },
    { href: `${SITE_URL}/${lang}/docs/privacy`, label: t("privacy") },
    { href: `https://docs.beutl.beditor.net/${lang}`, label: t("docs") },
  ];

  const socialCells = socialLinks
    .map(
      (link) => `<td style="padding-right: 32px;">
                        <a href="${link.href}" target="_blank" style="text-decoration: none;">
                          ${assetImg(link.icon, link.label)}
                        </a>
                      </td>`,
    )
    .join("\n                      ");
  const footerLinkCells = footerLinks
    .map(
      (link) => `<td style="padding-right: 12px; font-family: ${fontFamily}; font-size: 14px; line-height: 20px;">
                        <a href="${link.href}" target="_blank" style="color: ${palette.foreground}; text-decoration: none;">${escapeHtml(link.label)}</a>
                      </td>`,
    )
    .join("\n                      ");

  return `<!DOCTYPE html>
<html lang="${lang}" xmlns="http://www.w3.org/1999/xhtml">

<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <meta name="supported-color-schemes" content="dark">
  <title>Beutl</title>
  <style type="text/css">
    :root {
      color-scheme: dark;
      supported-color-schemes: dark;
    }

    a:hover {
      text-decoration: underline !important;
    }

    /* 本文はリンクや段落を含む HTML 断片なので、Web の prose に近い既定を当てる */
    .content-card a { color: ${palette.primary}; text-decoration: none; }
    .content-card p { margin: 0 0 12px; }
    .content-card h1, .content-card h2, .content-card h3 { margin: 0 0 16px; font-weight: 600; line-height: 1.3; }
    .content-card h2 { font-size: 20px; }

    /* Gmail 専用: ダークモードの色反転を blend mode で打ち消す (gmailText を参照) */
    u + .body .gmail-blend-screen { background: #000000; mix-blend-mode: screen; }
    u + .body .gmail-blend-difference { background: #000000; mix-blend-mode: difference; }
    /* blend mode で守れるのは白い文字だけなので、Gmail では文字色を白に寄せる */
    u + .body .gmail-blend-difference,
    u + .body .gmail-blend-difference a,
    u + .body .gmail-blend-difference td { color: #ffffff !important; }
    u + .body .content-card .gmail-blend-difference a { text-decoration: underline !important; }
    u + .body .email-button a { text-decoration: none !important; }

    @media only screen and (max-width: 600px) {
      .container {
        width: 100% !important;
      }

      .content-card {
        padding: 20px 16px !important;
      }
    }
  </style>
</head>

<body class="body" bgcolor="${palette.background}" style="margin: 0; padding: 0; width: 100% !important; ${surface(palette.background)} color: ${palette.foreground}; font-family: ${fontFamily}; font-size: 16px; line-height: 1.6; -webkit-font-smoothing: antialiased; -webkit-text-size-adjust: 100%;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${palette.background}" style="${surface(palette.background)}">
    <tr>
      <td align="center" style="padding: 0 16px 32px;">
        <table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" border="0" style="width: 600px; max-width: 100%;">

          <!-- Header: apps/web/src/components/nav-bar.tsx と同じロゴ + 見出し + 下罫線 -->
          <tr>
            <td style="padding: 12px 0;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td valign="middle" style="padding-right: 8px;">
                    <a href="${SITE_URL}/${lang}" target="_blank" style="text-decoration: none;">
                      ${assetImg("logo", "")}
                    </a>
                  </td>
                  <td valign="middle" style="font-family: ${fontFamily}; font-size: 20px; font-weight: 600; line-height: 28px; color: ${palette.foreground};">
                    ${gmailText(`<a href="${SITE_URL}/${lang}" target="_blank" style="text-decoration: none; color: ${palette.foreground};">Beutl</a>`)}
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td>
              ${rule()}
            </td>
          </tr>

          <!-- Body: Web のカード (bg-card / border / rounded-lg) に載せる。
               枠線は border ではなく、枠色の面に 1px の余白を空けてカードを重ねて描く -->
          <tr>
            <td style="padding: 32px 0 0;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${palette.border}" style="${surface(palette.border)} border-radius: 8px;">
                <tr>
                  <td style="padding: 1px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${palette.card}" style="${surface(palette.card)} border-radius: 7px;">
                      <tr>
                        <td class="content-card" style="padding: 24px; font-family: ${fontFamily}; font-size: 16px; line-height: 1.6; color: ${palette.foreground};">
                          ${wrapContentForGmail(content)}
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer: apps/web/src/components/footer.tsx と同じ SNS / 規約リンク / 著作権 -->
          <tr>
            <td style="padding: 32px 0 0;">
              ${rule()}
            </td>
          </tr>
          <tr>
            <td>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="padding: 24px 0 0;">
                    <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                      <tr>
                      ${socialCells}
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 32px 0 0;">
                    ${gmailText(`<table role="presentation" cellpadding="0" cellspacing="0" border="0">
                      <tr>
                      ${footerLinkCells}
                      </tr>
                    </table>`)}
                  </td>
                </tr>
                <tr>
                  <td align="right" style="padding: 16px 0 0; font-family: ${fontFamily}; font-size: 14px; line-height: 20px; color: ${palette.mutedForeground};">
                    ${gmailText(`&copy; 2020-${year} b-editor`)}
                  </td>
                </tr>
              </table>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>

</html>`;
}
