"use client";

import { Copy } from "lucide-react";
import { Button } from "@beutl/ui/ui/button";
import { Input } from "@beutl/ui/ui/input";
import { cn } from "@beutl/core";

export function CopyableInput({ id, value, copyLabel, onCopy, secret = false, selectOnFocus = false, className }: {
  id: string;
  value: string;
  copyLabel: string;
  onCopy: (value: string) => void;
  secret?: boolean;
  selectOnFocus?: boolean;
  className?: string;
}) {
  return <div className="flex gap-2">
    <Input
      id={id}
      type={secret ? "password" : "text"}
      autoComplete={secret ? "off" : undefined}
      readOnly
      value={value}
      className={cn("min-w-0 font-mono", className)}
      onFocus={selectOnFocus ? (event) => event.target.select() : undefined}
    />
    <Button type="button" variant="outline" size="icon" aria-label={copyLabel} onClick={() => onCopy(value)}>
      <Copy className="size-4" aria-hidden />
    </Button>
  </div>;
}
