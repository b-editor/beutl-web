import "server-only";
import { headers } from "next/headers";
import { redirect, type RedirectType } from "next/navigation";

export function localRedirect(url: string, type?: RedirectType): never {
  if (process.env.NODE_ENV !== "production") {
    redirect(url, type);
  }

  if (url.startsWith("/")) {
    redirect(url, type);
  }

  // headersからホスト取得
  const xurl = headers().get("x-url") as string;
  const origin = new URL(xurl).origin;
  const urlObj = new URL(url);
  if (urlObj.origin !== origin) {
    throw new Error(`Invalid redirect: ${url}`);
  }

  redirect(url, type);
}