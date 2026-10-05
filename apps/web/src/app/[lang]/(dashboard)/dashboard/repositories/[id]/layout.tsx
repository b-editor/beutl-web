import type { ReactNode } from "react";
import { RepositoryNavigationProvider } from "./navigation";

// The provider lives here, above the pages, so a navigation's pending state
// survives while the next page renders.
export default function Layout({ children }: { children: ReactNode }) {
  return <RepositoryNavigationProvider>{children}</RepositoryNavigationProvider>;
}
