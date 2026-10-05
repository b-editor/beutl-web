"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useMemo, useTransition, type ComponentProps, type ReactNode } from "react";
import { cn } from "@beutl/core";

// The repository pages share one transition, so whatever is about to be
// replaced dims while the next folder, version or history page renders, as
// the storage list does.
const Navigation = createContext<{ pending: boolean; navigate: (href: string) => void }>({
  pending: false,
  navigate: () => undefined,
});

export function RepositoryNavigationProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const navigate = useCallback((href: string) => startTransition(() => router.push(href)), [router]);
  const value = useMemo(() => ({ pending, navigate }), [pending, navigate]);
  return <Navigation.Provider value={value}>{children}</Navigation.Provider>;
}

export const useRepositoryNavigation = () => useContext(Navigation);

/** A link whose plain clicks navigate in the shared transition; modified clicks stay the browser's. */
export function PendingLink({ href, onClick, ...props }: Omit<ComponentProps<typeof Link>, "href" | "prefetch"> & { href: string }) {
  const { navigate } = useRepositoryNavigation();
  return (
    <Link
      prefetch={false}
      href={href}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        navigate(href);
      }}
      {...props}
    />
  );
}

/** Dims what is about to be replaced, as the storage list does while it navigates. */
export function PendingArea({ children, className }: { children: ReactNode; className?: string }) {
  const { pending } = useRepositoryNavigation();
  return (
    <div aria-busy={pending} className={cn("transition-opacity", pending && "opacity-60", className)}>
      {children}
    </div>
  );
}
