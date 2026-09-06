"use client";

import { useTranslation } from "@beutl/ui/i18n-client";
import { Button } from "@beutl/ui/ui/button";
import { useState, useTransition } from "react";
import {
  resumeStorageMultipartCleanup,
  resumeStorageUploadInterventionAction,
  terminalizeStorageMultipartCleanup,
  terminalizeStorageUploadInterventionAction,
} from "./actions";

type Row = {
  objectKey: string;
  uploadId: string;
  attempts: number;
  lastError: string | null;
  interventionAt: Date;
  revision: number;
};

function localizedActionMessage(
  message: string | undefined,
  fallback: string,
  unauthenticated: string,
  forbidden: string,
): string {
  if (message === "Unauthenticated") return unauthenticated;
  if (message === "Forbidden") return forbidden;
  return message ?? fallback;
}

export function StorageMultipartInterventions({
  lang,
  rows,
}: {
  lang: string;
  rows: Row[];
}) {
  const { t } = useTranslation(lang);
  if (!rows.length) {
    return (
      <p className="text-sm text-muted-foreground">
        {t("admin:ai.interventions.multipart.empty")}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {rows.map((row) => (
        <StorageMultipartInterventionRow
          key={`${row.objectKey}:${row.uploadId}`}
          lang={lang}
          row={row}
        />
      ))}
    </div>
  );
}

function StorageMultipartInterventionRow({
  lang,
  row,
}: {
  lang: string;
  row: Row;
}) {
  const { t } = useTranslation(lang);
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [evidence, setEvidence] = useState("");

  const run = (terminalize: boolean) =>
    startTransition(async () => {
      if (terminalize && (!reason.trim() || !evidence.trim())) {
        setMessage(t("admin:ai.interventions.messages.reasonAndEvidenceRequired"));
        return;
      }
      if (
        terminalize &&
        !window.confirm(t("admin:ai.interventions.multipart.terminalizeConfirm"))
      ) {
        return;
      }

      const result = await (terminalize
        ? terminalizeStorageMultipartCleanup
        : resumeStorageMultipartCleanup)(lang, {
        objectKey: row.objectKey,
        uploadId: row.uploadId,
        expectedRevision: row.revision,
        expectedInterventionAt: row.interventionAt.toISOString(),
        ...(terminalize
          ? { operatorReason: reason, operatorEvidence: evidence }
          : {}),
      });
      const fallback = result.success
        ? t(
            terminalize
              ? "admin:ai.interventions.messages.multipartTerminalized"
              : "admin:ai.interventions.messages.multipartResumed",
          )
        : t("admin:ai.interventions.common.failed");
      setMessage(
        localizedActionMessage(
          result.message,
          fallback,
          t("admin:ai.interventions.common.unauthenticated"),
          t("admin:ai.interventions.common.forbidden"),
        ),
      );
      if (result.success) window.location.reload();
    });

  return (
    <div className="rounded-lg border p-4 text-sm">
      {message && <p className="mb-2 text-muted-foreground">{message}</p>}
      <p className="break-all font-medium">
        {t("admin:ai.interventions.common.objectKey")}: {row.objectKey}
      </p>
      <p className="break-all">
        {t("admin:ai.interventions.common.multipartUploadId")}: {row.uploadId}
      </p>
      <p className="text-muted-foreground">
        {t("admin:ai.interventions.common.attempts", { count: row.attempts })};{" "}
        {row.lastError ?? t("admin:ai.interventions.common.unknownError")}
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
      <div className="mt-2 flex gap-2">
        <Button size="sm" disabled={pending} onClick={() => run(false)}>
          {t("admin:ai.interventions.common.resume")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => run(true)}
        >
          {t("admin:ai.interventions.multipart.terminalize")}
        </Button>
      </div>
    </div>
  );
}

type UploadRow = {
  id: string;
  userId: string;
  objectKey: string;
  uploadId: string | null;
  completionAttempts: number;
  completionLastError: string | null;
  completionInterventionAt: Date;
  completionRevision: number;
  completionState: string;
};

export function StorageUploadInterventions({
  lang,
  rows,
}: {
  lang: string;
  rows: UploadRow[];
}) {
  const { t } = useTranslation(lang);
  if (!rows.length) {
    return (
      <p className="text-sm text-muted-foreground">
        {t("admin:ai.interventions.upload.empty")}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {rows.map((row) => (
        <StorageUploadInterventionRow key={row.id} lang={lang} row={row} />
      ))}
    </div>
  );
}

function StorageUploadInterventionRow({
  lang,
  row,
}: {
  lang: string;
  row: UploadRow;
}) {
  const { t } = useTranslation(lang);
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [evidence, setEvidence] = useState("");

  const run = (terminalize: boolean) =>
    startTransition(async () => {
      if (!reason.trim() || !evidence.trim()) {
        setMessage(t("admin:ai.interventions.messages.reasonAndEvidenceRequired"));
        return;
      }
      const confirmationKey = terminalize
        ? "admin:ai.interventions.upload.terminalizeConfirm"
        : "admin:ai.interventions.upload.resumeConfirm";
      if (!window.confirm(t(confirmationKey))) return;

      const result = await (terminalize
        ? terminalizeStorageUploadInterventionAction
        : resumeStorageUploadInterventionAction)(lang, {
        id: row.id,
        userId: row.userId,
        objectKey: row.objectKey,
        uploadId: row.uploadId,
        expectedRevision: row.completionRevision,
        expectedInterventionAt: row.completionInterventionAt.toISOString(),
        operatorReason: reason,
        operatorEvidence: evidence,
      });
      const fallback = result.success
        ? t(
            terminalize
              ? "admin:ai.interventions.messages.uploadTerminalized"
              : "admin:ai.interventions.messages.uploadResumed",
          )
        : t("admin:ai.interventions.common.failed");
      setMessage(
        localizedActionMessage(
          result.message,
          fallback,
          t("admin:ai.interventions.common.unauthenticated"),
          t("admin:ai.interventions.common.forbidden"),
        ),
      );
      if (result.success) window.location.reload();
    });

  return (
    <div className="rounded-lg border p-4 text-sm">
      {message && <p className="mb-2 text-muted-foreground">{message}</p>}
      <p className="break-all font-medium">
        {t("admin:ai.interventions.common.recordId")}: {row.id}
      </p>
      <p className="break-all">
        {t("admin:ai.interventions.common.objectKey")}: {row.objectKey}
      </p>
      {row.uploadId && (
        <p className="break-all">
          {t("admin:ai.interventions.common.multipartUploadId")}: {row.uploadId}
        </p>
      )}
      <p className="text-muted-foreground">
        {t("admin:ai.interventions.common.attempts", {
          count: row.completionAttempts,
        })};{" "}
        {row.completionLastError ?? t("admin:ai.interventions.common.unknownError")}
      </p>
      {row.completionState === "unknown" ? (
        <p className="mt-2 text-amber-700">
          {t("admin:ai.interventions.upload.unknownOutcome")}
        </p>
      ) : (
        <>
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
          <div className="mt-2 flex gap-2">
            <Button size="sm" disabled={pending} onClick={() => run(false)}>
              {t("admin:ai.interventions.common.resume")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => run(true)}
            >
              {t("admin:ai.interventions.common.terminalize")}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
