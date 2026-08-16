import { getContentUrl } from "../content-url";
import { PUBLIC_AI_JOB_ERROR } from "./job-errors";

export type PublicAiJobRecord = {
  id: string;
  status: string;
  resultFileId: string | null;
  resultFile?: {
    name: string;
    mimeType: string;
  } | null;
};

export type PublicAiJobStatus = "running" | "succeeded" | "failed";

export function publicAiJobStatus(status: string): PublicAiJobStatus {
  if (status === "succeeded" || status === "failed") return status;
  return "running";
}

export function isTerminalAiJobStatus(status: string): boolean {
  return status === "succeeded" ||
    status === "failed";
}

export async function publicAiJobPayload(
  job: PublicAiJobRecord,
  request: Request,
) {
  return {
    jobId: job.id,
    status: publicAiJobStatus(job.status),
    fileId: job.resultFileId,
    url: job.resultFileId
      ? await getContentUrl(job.resultFileId, request)
      : null,
    fileName: job.resultFile?.name ?? null,
    contentType: job.resultFile?.mimeType ?? null,
    error: job.status === "failed" ? PUBLIC_AI_JOB_ERROR : null,
  };
}
