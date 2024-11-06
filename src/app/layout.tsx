import type { Metadata } from "next";
import { Noto_Sans_JP } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { SessionProvider } from "next-auth/react";

const notoSansJP = Noto_Sans_JP({
  subsets: ["latin"],
  variable: '--font-noto-sans-jp'
});


export const metadata: Metadata = {
  title: "Beutl"
};

type Props = {
  children: React.ReactNode;
  params: {
    lang: string;
  }
}

export default function RootLayout({ children }: Props) {
  return (
    <html lang="ja" className="dark">
      <body
        className={`${notoSansJP.variable} antialiased`}
      >
        <SessionProvider>
          {children}
          <Toaster />
        </SessionProvider>
      </body>
    </html>
  );
}
