import "server-only";

/**
 * Publishes a CAS-protected artifact reference. Cleanup is durable and
 * best-effort here, so a retry/delete failure never replaces the authoritative
 * database result or the concurrency error returned to the caller.
 */
export async function publishReleaseArtifactReplacement<TResult>({
  replace,
  abandon,
  drain,
}: {
  replace: () => Promise<TResult>;
  abandon: () => Promise<void>;
  drain: () => Promise<unknown>;
}): Promise<TResult> {
  let result: TResult;
  try {
    result = await replace();
  } catch (error) {
    try {
      await abandon();
    } catch {
      // The persisted cleanup reservation remains eligible for the scheduled drainer.
    }
    try {
      await drain();
    } catch {
      // Cleanup retries must not replace the original concurrency error.
    }
    throw error;
  }

  try {
    await drain();
  } catch {
    // The committed replacement remains authoritative while cleanup retries later.
  }
  return result;
}
