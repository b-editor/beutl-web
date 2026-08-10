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
import { categories, statuses } from "./enums";

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
