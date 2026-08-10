import type { FeedbackCategory, FeedbackStatus } from "@beutl/db";

// クライアントコンポーネントから使うため、@beutl/db の値 (Prisma Client) は import しない。
// satisfies は削除・改名しか検出しないので、列挙漏れがあると引数が never になって
// 型エラーになるこのヘルパーを通し、enum への追加も検出できるようにする。
const exhaustive =
  <TEnum extends string>() =>
  <const TList extends readonly TEnum[]>(
    list: TList &
      ([Exclude<TEnum, TList[number]>] extends [never] ? unknown : never),
  ): TList =>
    list;

export const statuses = exhaustive<FeedbackStatus>()([
  "OPEN",
  "IN_PROGRESS",
  "RESOLVED",
]);

export const categories = exhaustive<FeedbackCategory>()([
  "BUG_REPORT",
  "FEATURE_REQUEST",
  "QUESTION",
  "OTHER",
]);
