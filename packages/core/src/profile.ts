// Authentication-provider fields are not a fallback for the public identity.
export function profileDisplayName(
  profile?: { displayName?: string | null; userName?: string | null } | null,
): string | null {
  return profile?.displayName?.trim() || profile?.userName || null;
}
