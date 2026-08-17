// Worker のタイムゾーンは UTC。ロケール既定の書式では UTC である旨が出ないため、
// JST の管理者が 9 時間ずれた値をローカル時刻と誤読する。監査ログを Grafana の
// ログと突き合わせられるよう、UTC であることを明示して描画する。

// Intl.DateTimeFormat の生成はロケールデータの解決を伴い、format() 自体より
// 桁違いに重い。一覧は 1 描画で数十行を書式化するため、ロケール単位で使い回す。
const formatters = new Map<string, Intl.DateTimeFormat>();

function getFormatter(lang: string): Intl.DateTimeFormat {
  let formatter = formatters.get(lang);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(lang, {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      timeZoneName: "short",
    });
    formatters.set(lang, formatter);
  }
  return formatter;
}

export function formatTimestamp(value: Date, lang: string): string {
  return getFormatter(lang).format(value);
}

// 利用状況の集計は 1 画面で数十個の数値を描画するため、書式化器を使い回す。
const numberFormatters = new Map<string, Intl.NumberFormat>();

export function formatNumber(value: number, lang: string): string {
  let formatter = numberFormatters.get(lang);
  if (!formatter) {
    formatter = new Intl.NumberFormat(lang);
    numberFormatters.set(lang, formatter);
  }
  return formatter.format(value);
}

// 増減はどちらの向きかが一目で分かる必要があるため、正の値にも符号を付ける。
export function formatSignedNumber(value: number, lang: string): string {
  return value > 0 ? `+${formatNumber(value, lang)}` : formatNumber(value, lang);
}
