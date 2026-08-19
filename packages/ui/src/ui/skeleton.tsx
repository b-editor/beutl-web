import { cn } from "@beutl/core";

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-md bg-muted", className)}
      {...props}
    />
  );
}

// A skeleton with a band of light travelling across it, for a wait the user
// started and is watching: a pulse reads as "disabled", this reads as "working".
// The gradient is three times the box so the band has somewhere to come from
// and somewhere to go.
function Shimmer({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="shimmer"
      className={cn(
        "animate-shimmer rounded-md bg-muted bg-[length:200%_100%] bg-[linear-gradient(90deg,transparent_0%,var(--color-accent)_50%,transparent_100%)] bg-[position:200%_0]",
        className,
      )}
      {...props}
    />
  );
}

export { Skeleton, Shimmer };
