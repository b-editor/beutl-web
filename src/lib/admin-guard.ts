import "server-only";

export function isAdmin(userId: string): boolean {
  const adminIds =
    process.env.ADMIN_USER_IDS?.split(",").map((s) => s.trim()) ?? [];
  return adminIds.includes(userId);
}
