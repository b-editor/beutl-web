import { redirect } from "next/navigation";

export default async function Page(props: { params: Promise<{ lang: string }> }) {
  const params = await props.params;

  const {
    lang
  } = params;

  redirect(`/${lang}/docs/telemetry`);
}
