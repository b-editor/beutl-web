"use client";

import { useTranslation } from "@beutl/ui/i18n-client";
import { Input } from "@beutl/ui/ui/input";
import { Button } from "@beutl/ui/ui/button";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Filter } from "lucide-react";

export function AuditLogFilterForm({
  lang,
  action,
  userId,
}: {
  lang: string;
  action?: string;
  userId?: string;
}) {
  const { t } = useTranslation(lang);
  const router = useRouter();
  const [actionValue, setActionValue] = useState(action || "");
  const [userIdValue, setUserIdValue] = useState(userId || "");

  // このコンポーネントは絞り込みのたびに再マウントされないため、初期値だけでは
  // 戻る/進むや外部リンクで URL が変わったときに入力欄が古いまま残る。
  useEffect(() => {
    setActionValue(action || "");
    setUserIdValue(userId || "");
  }, [action, userId]);

  const apply = (e: React.FormEvent) => {
    e.preventDefault();
    const params = new URLSearchParams();
    if (actionValue) params.set("action", actionValue);
    if (userIdValue) params.set("userId", userIdValue);
    router.push(`/${lang}/admin/audit-log?${params.toString()}`);
  };

  return (
    <form onSubmit={apply} className="flex flex-wrap items-center gap-3">
      <Input
        type="text"
        value={actionValue}
        onChange={(e) => setActionValue(e.target.value)}
        placeholder={t("admin:auditLog.action")}
        className="max-w-56"
      />
      <Input
        type="text"
        value={userIdValue}
        onChange={(e) => setUserIdValue(e.target.value)}
        placeholder={t("admin:auditLog.userIdPlaceholder")}
        className="max-w-72"
      />
      <Button type="submit" variant="outline" size="sm">
        <Filter className="mr-2 h-4 w-4" />
        {t("admin:auditLog.apply")}
      </Button>
    </form>
  );
}
