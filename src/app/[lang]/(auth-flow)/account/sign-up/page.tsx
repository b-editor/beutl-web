import { auth } from "@/auth";
import Form from "./form";
import { localRedirect } from "@/lib/localRedirect";

export default async function Page({ searchParams: { returnUrl, email } }: { searchParams: { returnUrl?: string, email?: string } }) {
  const session = await auth();
  if (session) {
    localRedirect(returnUrl || "/");
  }

  return (
    <Form returnUrl={returnUrl} email={email} />
  )
}