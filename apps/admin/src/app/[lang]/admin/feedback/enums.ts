import type { FeedbackCategory, FeedbackStatus } from "@beutl/db";

// クライアントコンポーネントから使うため、@beutl/db の値 (Prisma Client) は import しない。
// satisfies により、enum からメンバーが削除・改名された場合はここで型エラーになる。
export const statuses = [
  "OPEN",
  "IN_PROGRESS",
  "RESOLVED",
] as const satisfies readonly FeedbackStatus[];

export const categories = [
  "BUG_REPORT",
  "FEATURE_REQUEST",
  "QUESTION",
  "OTHER",
] as const satisfies readonly FeedbackCategory[];
