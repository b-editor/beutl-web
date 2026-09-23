/** Read this only after client data loads; initial SSR must not depend on the viewer's zone. */
export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}
