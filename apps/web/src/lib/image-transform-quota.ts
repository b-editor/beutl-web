const QUOTA_RETRY_MS = 5 * 60 * 1000;
const FAILED_PROBE_RETRY_MS = 30 * 1000;

type QuotaState = {
  limited: boolean;
  retryAfter: number;
  probing: boolean;
};

// A binding belongs to one Worker isolate. Share its backoff across files and
// presets, without keeping requests, streams, or caller identity in global state.
const quotaStates = new WeakMap<object, QuotaState>();

/** Pause after quota exhaustion and allow one probe after the backoff expires.
 * Cold isolates probe independently; this is not an account-wide quota meter. */
export async function withImageTransformQuota<T>(
  images: object,
  transform: () => Promise<T>,
): Promise<T | null> {
  let state = quotaStates.get(images);
  if (!state) {
    state = { limited: false, retryAfter: 0, probing: false };
    quotaStates.set(images, state);
  }
  if (state.probing || Date.now() < state.retryAfter) return null;
  const probe = state.limited;
  if (probe) state.probing = true;

  try {
    const result = await transform();
    if (probe) {
      state.limited = false;
      state.retryAfter = 0;
    }
    return result;
  } catch (error) {
    if (isImageQuotaError(error)) {
      const report = !state.limited || probe;
      state.limited = true;
      state.retryAfter = Date.now() + QUOTA_RETRY_MS;
      if (report) console.warn("Images Free quota exhausted; pausing transformations for five minutes");
      return null;
    }
    // A failed recovery probe must not fan out into simultaneous retries.
    if (probe) state.retryAfter = Date.now() + FAILED_PROBE_RETRY_MS;
    throw error;
  } finally {
    if (probe) state.probing = false;
  }
}

function isImageQuotaError(error: unknown): boolean {
  const cause = error instanceof Error ? error.cause : undefined;
  return [error, cause].some((candidate) => {
    if (candidate === null || typeof candidate !== "object") return false;
    const { code, message } = candidate as { code?: unknown; message?: unknown };
    return code === 9422 || code === "9422" ||
      (typeof message === "string" && /(?:error|err|code)\s*[:=]?\s*9422\b/iu.test(message));
  });
}
