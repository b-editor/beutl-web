"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

export function ClientRedirect({ url }: { url: string }) {
  const router = useRouter();
  useEffect(() => {
    router.push(url);
  }, [url]);

  return <></>
}