// Worker のタイムゾーンは UTC。ロケール既定の書式では UTC である旨が出ないため、
// JST の管理者が 9 時間ずれた値をローカル時刻と誤読する。監査ログを Grafana の
// ログと突き合わせられるよう、UTC であることを明示して描画する。
export function formatTimestamp(value: Date, lang: string): string {
  return value.toLocaleString(lang, {
    timeZone: "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
}
