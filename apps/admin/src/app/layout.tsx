import type { Metadata } from "next";
import "./globals.css";
import { Toaster } from "@beutl/ui/ui/toaster";
import ProgressBarProvider from "@beutl/ui/progress-bar-provider";

export const metadata: Metadata = {
  title: "Beutl Admin",
  description: "Beutl admin console",
  applicationName: "Beutl Admin",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ja" className="dark">
      <body className="antialiased">
        <ProgressBarProvider>
          {children}
          <Toaster />
        </ProgressBarProvider>
      </body>
    </html>
  );
}
