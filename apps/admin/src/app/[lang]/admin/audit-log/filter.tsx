"use client";

import { useTranslation } from "@beutl/ui/i18n-client";
import { Input } from "@beutl/ui/ui/input";
import { Button } from "@beutl/ui/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@beutl/ui/ui/select";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Filter } from "lucide-react";

const ALL_ACTIONS = "ALL";

export function AuditLogFilterForm({
  lang,
  action,
  userId,
  actions,
}: {
  lang: string;
  action?: string;
  userId?: string;
  // 保存されている action は "admin.userDeleted" のような完全修飾名。
  // 自由入力にすると部分一致のつもりで打った値が 0 件になるため、
  // サーバー側で列挙した候補から選ばせる。
  actions: string[];
}) {
  const { t } = useTranslation(lang);
  const router = useRouter();
  const [actionValue, setActionValue] = useState(action || ALL_ACTIONS);
  const [userIdValue, setUserIdValue] = useState(userId || "");

  // このコンポーネントは絞り込みのたびに再マウントされないため、初期値だけでは
  // 戻る/進むや外部リンクで URL が変わったときに入力欄が古いまま残る。
  useEffect(() => {
    setActionValue(action || ALL_ACTIONS);
    setUserIdValue(userId || "");
  }, [action, userId]);

  const apply = (e: React.FormEvent) => {
    e.preventDefault();
    const params = new URLSearchParams();
    if (actionValue && actionValue !== ALL_ACTIONS)
      params.set("action", actionValue);
    if (userIdValue) params.set("userId", userIdValue);
    router.push(`/${lang}/admin/audit-log?${params.toString()}`);
  };

  return (
    <form onSubmit={apply} className="flex flex-wrap items-center gap-3">
      <Select value={actionValue} onValueChange={setActionValue}>
        <SelectTrigger className="w-64">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_ACTIONS}>
            {t("admin:auditLog.allActions")}
          </SelectItem>
          {actions.map((name) => (
            <SelectItem key={name} value={name}>
              {name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Input
        type="text"
        value={userIdValue}
        onChange={(e) => setUserIdValue(e.target.value)}
        placeholder={t("admin:auditLog.userIdPlaceholder")}
        aria-label={t("admin:auditLog.userIdPlaceholder")}
        className="max-w-72"
      />
      <Button type="submit" variant="outline" size="sm">
        <Filter className="mr-2 h-4 w-4" />
        {t("admin:auditLog.apply")}
      </Button>
    </form>
  );
}
