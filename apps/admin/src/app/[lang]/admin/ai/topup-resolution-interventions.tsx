"use client";

import { useTranslation } from "@beutl/ui/i18n-client";
import { Button } from "@beutl/ui/ui/button";
import { useState, useTransition } from "react";
import { terminalizeOrphanTopUpResolution } from "./actions";

type Row = {
  resolution: {
    topUpAttemptId: string;
    ownerUserId: string;
    stripeCustomerId: string;
    billingOfferId: string;
    revision: number;
    expectedPaymentIntentIds: string;
    lastError: string | null;
  };
  attempt: unknown;
};

export function TopUpResolutionInterventions({
  lang,
  rows,
}: {
  lang: string;
  rows: Row[];
}) {
  const { t } = useTranslation(lang);
  const [pending, startTransition] = useTransition();
  const [reason, setReason] = useState("");
  const [evidence, setEvidence] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  const run = (resolution: Row["resolution"]) =>
    startTransition(async () => {
      if (!reason.trim() || !evidence.trim()) {
        setMessage(t("admin:ai.interventions.messages.reasonAndEvidenceRequired"));
        return;
      }

      const result = await terminalizeOrphanTopUpResolution(lang, {
        topUpAttemptId: resolution.topUpAttemptId,
        ownerUserId: resolution.ownerUserId,
        stripeCustomerId: resolution.stripeCustomerId,
        billingOfferId: resolution.billingOfferId,
        expectedRevision: resolution.revision,
        operatorReason: reason,
        operatorEvidence: evidence,
      });
      let resultMessage =
        result.message ??
        t(
          result.success
            ? "admin:ai.interventions.messages.topUpTerminalized"
            : "admin:ai.interventions.common.failed",
        );
      if (result.message === "Unauthenticated") {
        resultMessage = t("admin:ai.interventions.common.unauthenticated");
      } else if (result.message === "Forbidden") {
        resultMessage = t("admin:ai.interventions.common.forbidden");
      }
      setMessage(resultMessage);
      if (result.success) window.location.reload();
    });

  if (!rows.length) {
    return (
      <p className="text-sm text-muted-foreground">
        {t("admin:ai.interventions.topUp.empty")}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {message && <p className="text-sm text-muted-foreground">{message}</p>}
      {rows.map(({ resolution, attempt }) => (
        <div
          key={resolution.topUpAttemptId}
          className="rounded-lg border p-4 text-sm"
        >
          <p className="break-all font-mono">
            {t("admin:ai.interventions.topUp.attempt")}: {resolution.topUpAttemptId}
          </p>
          <p className="break-all font-mono">
            {t("admin:ai.interventions.topUp.owner")}: {resolution.ownerUserId} ·{" "}
            {t(
              attempt
                ? "admin:ai.interventions.topUp.attemptPresent"
                : "admin:ai.interventions.topUp.orphanedAttempt",
            )}
          </p>
          <p className="text-muted-foreground">
            {t("admin:ai.interventions.topUp.revision", {
              revision: resolution.revision,
            })};{" "}
            {t("admin:ai.interventions.topUp.expectedPaymentIntents", {
              ids: resolution.expectedPaymentIntentIds || "[]",
            })}
          </p>
          <p>
            {resolution.lastError ?? t("admin:ai.interventions.topUp.operatorRequired")}
          </p>
          <textarea
            className="mt-2 min-h-16 w-full rounded border p-2"
            aria-label={t("admin:ai.interventions.common.reasonPlaceholder")}
            placeholder={t("admin:ai.interventions.common.reasonPlaceholder")}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <textarea
            className="mt-2 min-h-16 w-full rounded border p-2"
            aria-label={t("admin:ai.interventions.common.evidencePlaceholder")}
            placeholder={t("admin:ai.interventions.common.evidencePlaceholder")}
            value={evidence}
            onChange={(event) => setEvidence(event.target.value)}
          />
          <Button size="sm" disabled={pending} onClick={() => run(resolution)}>
            {t("admin:ai.interventions.topUp.terminalizeAfterRefundProof")}
          </Button>
        </div>
      ))}
    </div>
  );
}
