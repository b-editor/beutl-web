"use client";

import { useEffect } from "react";

export function ClientRedirect({ url }: { url: string }) {
  useEffect(() => {
    location.href = url;
  }, [url]);

  return <></>
}