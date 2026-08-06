import { PageShell } from "@/components/page-shell";

export default async function Layout(props: {
  children: React.ReactNode;
  params: Promise<{ lang: string }>;
}) {
  const { lang } = await props.params;
  const { children } = props;
  return <PageShell lang={lang}>{children}</PageShell>;
}
