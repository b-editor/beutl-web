"use client";

import { useTranslation } from "@beutl/ui/i18n-client";
import { useRouter } from "next/navigation";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@beutl/ui/ui/select";
import type { FeedbackCategory, FeedbackStatus } from "@beutl/db";

// クライアントコンポーネントなので @beutl/db の値 (Prisma Client) は import しない。
// satisfies により、enum からメンバーが削除・改名された場合はここで型エラーになる。
const statuses = [
  "OPEN",
  "IN_PROGRESS",
  "RESOLVED",
] as const satisfies readonly FeedbackStatus[];
const categories = [
  "BUG_REPORT",
  "FEATURE_REQUEST",
  "QUESTION",
  "OTHER",
] as const satisfies readonly FeedbackCategory[];

export function FeedbackFilterForm({
  lang,
  status,
  category,
}: {
  lang: string;
  status?: string;
  category?: string;
}) {
  const { t } = useTranslation(lang);
  const router = useRouter();

  const navigate = (nextStatus: string, nextCategory: string) => {
    const params = new URLSearchParams();
    if (nextStatus && nextStatus !== "ALL") params.set("status", nextStatus);
    if (nextCategory && nextCategory !== "ALL") params.set("category", nextCategory);
    router.push(`/${lang}/admin/feedback?${params.toString()}`);
  };

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Select
        value={status || "ALL"}
        onValueChange={(v) => navigate(v, category || "ALL")}
      >
        <SelectTrigger className="w-40">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="ALL">{t("admin:feedback.allStatuses")}</SelectItem>
          {statuses.map((s) => (
            <SelectItem key={s} value={s}>
              {t(`admin:status.${s}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={category || "ALL"}
        onValueChange={(v) => navigate(status || "ALL", v)}
      >
        <SelectTrigger className="w-44">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="ALL">{t("admin:feedback.allCategories")}</SelectItem>
          {categories.map((c) => (
            <SelectItem key={c} value={c}>
              {t(`admin:category.${c}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
