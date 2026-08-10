import type { FeedbackCategory, FeedbackStatus } from "@beutl/db";

// クライアントコンポーネントから使うため、@beutl/db の値 (Prisma Client) は import
// しない。Record の網羅性チェックにより、enum への追加も削除もここで型エラーになり、
// 不足しているメンバー名がそのままエラーメッセージに出る。
const statusSet: Record<FeedbackStatus, true> = {
  OPEN: true,
  IN_PROGRESS: true,
  RESOLVED: true,
};

const categorySet: Record<FeedbackCategory, true> = {
  BUG_REPORT: true,
  FEATURE_REQUEST: true,
  QUESTION: true,
  OTHER: true,
};

export const statuses = Object.keys(statusSet) as FeedbackStatus[];
export const categories = Object.keys(categorySet) as FeedbackCategory[];
