import "server-only";
import { headers } from "next/headers";

export async function getContentUrl(id?: string | null) {
  if (!id) return null;
  const url = (await headers()).get("x-url") as string;
  const origin = new URL(url).origin;
  return `${origin}/api/contents/${id}`;
}

export function contentPath(id: string): string {
  return `/api/contents/${id}`;
}
