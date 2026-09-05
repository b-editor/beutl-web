"use client";

import { useTranslation } from "@beutl/ui/i18n-client";
import { Button } from "@beutl/ui/ui/button";
import { useState, useTransition } from "react";
import { resumePackagePaymentRefundInterventionAction } from "./actions";

type Row = {
  id: string;
  paymentIntentId: string;
  amount: number;
  currency: string;
  attempts: number;
  lastError: string | null;
  updatedAt: Date;
};

export function PackagePaymentRefundInterventions({ lang, rows }: { lang: string; rows: Row[] }) {
  const { t } = useTranslation(lang);
  if (!rows.length) return <p className="text-sm text-muted-foreground">{t("admin:ai.interventions.packagePayment.empty")}</p>;
  return <div className="flex flex-col gap-3">{rows.map((row) => <PackagePaymentRefundRow key={row.id} lang={lang} row={row} />)}</div>;
}

function PackagePaymentRefundRow({ lang, row }: { lang: string; row: Row }) {
  const { t } = useTranslation(lang);
  const [pending, startTransition] = useTransition();
  const [reason, setReason] = useState("");
  const [evidence, setEvidence] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const run = () => startTransition(async () => {
    if (reason.trim().length < 10 || evidence.trim().length < 10) {
      setMessage(t("admin:ai.interventions.messages.reasonAndEvidenceRequired"));
      return;
    }
    if (!window.confirm(t("admin:ai.interventions.packagePayment.resumeConfirm"))) return;
    const result = await resumePackagePaymentRefundInterventionAction(lang, {
      id: row.id,
      expectedUpdatedAt: row.updatedAt.toISOString(),
      operatorReason: reason,
      operatorEvidence: evidence,
    });
    let resultMessage = result.message ?? (result.success
      ? t("admin:ai.interventions.messages.packagePaymentRefundResumed")
      : t("admin:ai.interventions.common.failed"));
    if (result.message === "Unauthenticated") {
      resultMessage = t("admin:ai.interventions.common.unauthenticated");
    } else if (result.message === "Forbidden") {
      resultMessage = t("admin:ai.interventions.common.forbidden");
    }
    setMessage(resultMessage);
    if (result.success) window.location.reload();
  });
  return <div className="rounded-lg border p-4 text-sm">
    {message && <p className="mb-2 text-muted-foreground">{message}</p>}
    <p className="break-all font-mono">{t("admin:ai.interventions.packagePayment.attempt")}: {row.id}</p>
    <p className="break-all font-mono">{t("admin:ai.interventions.packagePayment.paymentIntent")}: {row.paymentIntentId}</p>
    <p>{row.amount} {row.currency.toUpperCase()} · {t("admin:ai.interventions.common.attempts", { count: row.attempts })}</p>
    <p className="text-muted-foreground">{row.lastError ?? t("admin:ai.interventions.packagePayment.operatorRequired")}</p>
    <textarea className="mt-2 min-h-16 w-full rounded border p-2" aria-label={t("admin:ai.interventions.common.reasonPlaceholder")} placeholder={t("admin:ai.interventions.common.reasonPlaceholder")} value={reason} onChange={(event) => setReason(event.target.value)} />
    <textarea className="mt-2 min-h-16 w-full rounded border p-2" aria-label={t("admin:ai.interventions.common.evidencePlaceholder")} placeholder={t("admin:ai.interventions.common.evidencePlaceholder")} value={evidence} onChange={(event) => setEvidence(event.target.value)} />
    <Button className="mt-2" size="sm" disabled={pending} onClick={run}>{t("admin:ai.interventions.common.resume")}</Button>
  </div>;
}
