import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PreviewViewer } from "@/features/preview/viewer";

export const metadata: Metadata = {
  title: "Preview · Beutl",
  robots: { index: false, follow: false },
};

export default async function PreviewPage({ params }: {
  params: Promise<{ lang: string; room: string; session: string }>;
}) {
  const { lang, room, session } = await params;
  if (!/^[a-f0-9]{64}$/u.test(room) || !/^[a-f0-9-]{36}$/u.test(session)) notFound();
  // Signaling and the HttpOnly cookie keep the same unlocalized room path.
  return <PreviewViewer lang={lang} basePath={`/preview/${room}/${session}/`} />;
}
