"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useTranslation } from "@beutl/ui/i18n-client";
import { useToast } from "@beutl/ui/use-toast";
import { Button } from "@beutl/ui/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@beutl/ui/ui/alert-dialog";
import type { ActionResult } from "@beutl/core";
import {
  resumeTopUpCheckoutRecovery,
  terminalizeTopUpCheckoutRecovery,
} from "./actions";

type Intervention = {
  attempt: {
    id: string;
    ownerUserId: string;
    stripeCustomerId: string;
    billingOfferId: string;
    status: string;
    recoveryLastError: string | null;
    recoveryInterventionAt: Date | null;
  };
  resolution: {
    revision: number;
    status: string;
    lastError: string | null;
    expectedPaymentIntentIds: string;
  };
};

export function TopUpInterventionPanel({
  lang,
  intervention,
}: {
  lang: string;
  intervention: Intervention;
}) {
  const { t } = useTranslation(lang);
  const { toast } = useToast();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [terminalizeOpen, setTerminalizeOpen] = useState(false);
  const [operatorReason, setOperatorReason] = useState("");
  const [operatorEvidence, setOperatorEvidence] = useState("");
  if (!intervention.attempt.recoveryInterventionAt) return null;
  const input = {
    topUpAttemptId: intervention.attempt.id,
    ownerUserId: intervention.attempt.ownerUserId,
    stripeCustomerId: intervention.attempt.stripeCustomerId,
    billingOfferId: intervention.attempt.billingOfferId,
    expectedRevision: intervention.resolution.revision,
    expectedInterventionAt:
      intervention.attempt.recoveryInterventionAt.toISOString(),
  };

  const run = (action: () => Promise<ActionResult>) => {
    startTransition(async () => {
      try {
        const result = await action();
        toast({
          title: result.success
            ? t("admin:users.aiTopUpInterventionSuccess")
            : t("admin:users.aiTopUpInterventionFailed"),
          description: result.success ? undefined : result.message,
          variant: result.success ? undefined : "destructive",
        });
      } catch (error) {
        toast({
          title: t("admin:users.aiTopUpInterventionFailed"),
          description: error instanceof Error ? error.message : String(error),
          variant: "destructive",
        });
      }
      router.refresh();
    });
  };

  return (
    <div className="rounded-md border border-amber-500/50 bg-amber-50/50 p-4 dark:bg-amber-950/20">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">
            {t("admin:users.aiTopUpInterventionTitle")}
          </h3>
          <p className="text-xs text-muted-foreground">
            {t("admin:users.aiTopUpInterventionHint")}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={pending}
            onClick={() => run(() => resumeTopUpCheckoutRecovery(input))}
          >
            {t("admin:users.aiTopUpInterventionResume")}
          </Button>
          <AlertDialog open={terminalizeOpen} onOpenChange={setTerminalizeOpen}>
            <AlertDialogTrigger asChild>
              <Button size="sm" variant="destructive" disabled={pending}>
                {t("admin:users.aiTopUpInterventionTerminalize")}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {t("admin:users.aiTopUpInterventionTerminalizeTitle")}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {t("admin:users.aiTopUpInterventionTerminalizeDescription")}
                </AlertDialogDescription>
                <textarea className="min-h-20 w-full rounded border p-2 text-sm" placeholder="Operator reason" value={operatorReason} onChange={(event) => setOperatorReason(event.target.value)} />
                <textarea className="min-h-20 w-full rounded border p-2 text-sm" placeholder="Evidence (Stripe lookup IDs, logs, or ticket)" value={operatorEvidence} onChange={(event) => setOperatorEvidence(event.target.value)} />
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>
                  {t("admin:common.cancel")}
                </AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => {
                    setTerminalizeOpen(false);
                    run(() => terminalizeTopUpCheckoutRecovery({ ...input, operatorReason, operatorEvidence }));
                  }}
                >
                  {t("admin:users.aiTopUpInterventionTerminalizeConfirm")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>
      <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
        <div>
          <dt className="text-muted-foreground">{t("admin:users.id")}</dt>
          <dd className="break-all font-mono">{intervention.attempt.id}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">
            {t("admin:users.aiTopUpInterventionRevision")}
          </dt>
          <dd className="font-mono">{intervention.resolution.revision}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">
            {t("admin:users.aiTopUpInterventionStatus")}
          </dt>
          <dd className="font-mono">{intervention.attempt.status}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">
            {t("admin:users.aiTopUpInterventionEvidence")}
          </dt>
          <dd className="break-all font-mono">
            {intervention.resolution.expectedPaymentIntentIds || "-"}
          </dd>
        </div>
        {(intervention.attempt.recoveryLastError ||
          intervention.resolution.lastError) && (
          <div className="sm:col-span-2">
            <dt className="text-muted-foreground">
              {t("admin:users.aiTopUpInterventionError")}
            </dt>
            <dd>{intervention.attempt.recoveryLastError || intervention.resolution.lastError}</dd>
          </div>
        )}
      </dl>
    </div>
  );
}
