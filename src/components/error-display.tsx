import { cn } from "@/lib/utils";
import type { ComponentProps } from "react";

export function ErrorDisplay({ errors, ...props }: { errors: string[] } & ComponentProps<"div">) {
  return (
    <div {...props} className={cn(props.className, "text-sm font-medium text-destructive")}>
      <ul>
        {/* biome-ignore lint/suspicious/noArrayIndexKey: <explanation> */}
        {errors.map((error, i) => <li key={i}>{error}</li>)}
      </ul>
    </div>
  )
}
