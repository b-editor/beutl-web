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
