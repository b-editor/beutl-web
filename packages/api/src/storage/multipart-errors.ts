// Keep this module dependency-free: the layered bucket needs it without
// pulling the database-backed upload reconcilers along.

/**
 * Whether a multipart operation failed because the service no longer knows
 * the upload id: R2 reports error 10024, S3 compatible services NoSuchUpload.
 * Both mean the handle was already completed or aborted, so retrying it can
 * never succeed.
 */
export function isTerminalMultipartAbortError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as Record<string, unknown>;
  const code = String(record.code ?? record.name ?? "").toLowerCase();
  if (code === "nosuchupload") return true;
  return /(?:\(\s*10024\s*\)|\b10024)\s*$/u.test(
    String(record.message ?? error),
  );
}
