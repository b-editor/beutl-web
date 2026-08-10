import { firstSearchParam } from "./search-params";

// skip は 64bit 整数に収める必要があり、pageSize を掛けた値が溢れない上限に切る。
const MAX_PAGE = 1_000_000;

// URL の page パラメータは任意の文字列を取りうる。整数に丸めずに Prisma の skip へ
// 渡すと "2.01" (小数) や "1e999" (Infinity)、"1e19" (整数だが巨大) でクエリ検証
// エラーになるため、ここで MAX_PAGE 以下の正整数へ正規化する。
export function parsePageParam(page: string | string[] | undefined): number {
  const raw = firstSearchParam(page);
  // Number() は "0x10" (16進) や " 2 " (空白入り) も受理する。URL の page は
  // 10進の数字列だけを正規化対象にする。
  if (raw === undefined || !/^\d+$/.test(raw)) return 1;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 1;

  return Math.min(MAX_PAGE, Math.max(1, Math.floor(parsed)));
}

export async function fetchPaginated<TResult extends { total: number }>(
  fetchPage: (page: number) => Promise<TResult>,
  requestedPage: number,
  pageSize: number,
): Promise<{ result: TResult; currentPage: number; totalPages: number }> {
  let result = await fetchPage(requestedPage);

  const totalPages = Math.max(1, Math.ceil(result.total / pageSize));
  const currentPage = Math.min(requestedPage, totalPages);
  // 範囲外のページを最終ページに丸めた場合、再取得しないと空のテーブルが表示される。
  // 全体が 0 件なら丸めても結果は変わらないので、無駄なクエリを発行しない。
  if (currentPage !== requestedPage && result.total > 0) {
    result = await fetchPage(currentPage);
  }

  return { result, currentPage, totalPages };
}
