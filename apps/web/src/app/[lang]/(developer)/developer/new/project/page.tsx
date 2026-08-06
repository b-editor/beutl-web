import { authOrSignIn } from "@/lib/auth-guard";
import { Form } from "./components";

export default async function Page(props: { params: Promise<{ lang: string }> }) {
  const { lang } = await props.params;
  await authOrSignIn();

  return <Form lang={lang} />;
}
