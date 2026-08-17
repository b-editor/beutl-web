// アプリの言語コード (ja / en) を Intl に渡す BCP47 タグへ写す。
// `lang === "ja" ? "ja-JP" : "en-US"` が各ページにコピーされていたのを1か所に集める。
export function toLocaleTag(lang: string): string {
  return lang === "ja" ? "ja-JP" : "en-US";
}

// Cloudflare Workers は UTC で動くので、timeZone を省くとサーバー描画とクライアントの
// ローカル時刻がずれる。既定を UTC に固定して、少なくとも実行環境によって出力が変わらない
// ようにする。閲覧者のゾーンで出したい場合は呼び出し側が timeZone を渡すこと。
const UTC = "UTC";

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

export function formatDate(
  value: Date | string,
  lang: string,
  timeZone: string = UTC,
): string {
  return new Intl.DateTimeFormat(toLocaleTag(lang), {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone,
  }).format(toDate(value));
}

export function formatDateTime(
  value: Date | string,
  lang: string,
  timeZone: string = UTC,
): string {
  return new Intl.DateTimeFormat(toLocaleTag(lang), {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  }).format(toDate(value));
}

export function formatCount(value: number, lang: string): string {
  return new Intl.NumberFormat(toLocaleTag(lang)).format(value);
}
