/** Enable only after confirming the account uses Images Free, which rejects
 * new transformations at its limit instead of charging for overages. */
export function freeImageTransformsEnabled(env: {
  BEUTL_IMAGE_FREE_TRANSFORMS_ENABLED?: string;
}): boolean {
  return env.BEUTL_IMAGE_FREE_TRANSFORMS_ENABLED === "true";
}
