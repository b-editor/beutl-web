import { unstable_isUnrecognizedActionError } from "next/navigation";

/**
 * Translation key for a Server Action call that threw instead of returning.
 * A page opened before a deployment can call an action the new build no
 * longer has; retrying from the same page fails again, so ask for a reload.
 */
export function actionFailureKey(error: unknown, fallback: string) {
  return unstable_isUnrecognizedActionError(error) ? "pageOutdated" : fallback;
}
