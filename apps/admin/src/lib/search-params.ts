// Next.js は同名のクエリパラメータが繰り返されると値を配列で渡す (?q=a&q=b)。
// 配列のまま Prisma の where へ渡すとクエリ検証エラーで 500 になるため、
// 外部入力を読むページは必ずここを通して単一の文字列へ正規化する。
export function firstSearchParam(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
