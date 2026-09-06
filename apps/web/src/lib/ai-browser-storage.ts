export function accountScopedAiStorageKey(
  namespace: string,
  userId: string,
): string {
  if (namespace.length === 0) {
    throw new RangeError("A storage namespace is required");
  }
  if (userId.length === 0) {
    throw new RangeError("A user ID is required");
  }
  return `${namespace}:${encodeURIComponent(userId)}`;
}
