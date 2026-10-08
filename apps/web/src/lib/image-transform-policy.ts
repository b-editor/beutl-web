/** Enable only after confirming the account uses Images Free, which rejects
 * new transformations at its limit instead of charging for overages. */
export function freeImageTransformsEnabled(env: {
  BEUTL_IMAGE_FREE_TRANSFORMS_ENABLED?: string;
}): boolean {
  return env.BEUTL_IMAGE_FREE_TRANSFORMS_ENABLED === "true";
}

/** Expose the binding only to the content route with bounded presets. */
export function isContentImageTransformRequest(request: Request): boolean {
  return request.method === "GET" && /^\/api\/contents\/[a-z\d_-]+\/?$/iu.test(new URL(request.url).pathname);
}
