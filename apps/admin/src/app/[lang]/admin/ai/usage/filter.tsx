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
import { AI_USAGE_RANGES, type AiUsageRange } from "@/lib/ai-usage-range";

export function AiUsageRangeFilter({
  lang,
  range,
}: {
  lang: string;
  range: AiUsageRange;
}) {
  const { t } = useTranslation(lang);
  const router = useRouter();

  return (
    <Select
      value={range}
      onValueChange={(next) =>
        router.push(`/${lang}/admin/ai/usage?range=${next}`)
      }
    >
      <SelectTrigger className="w-40">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {AI_USAGE_RANGES.map((value) => (
          <SelectItem key={value} value={value}>
            {t(`admin:ai.usage.range.${value}`)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
