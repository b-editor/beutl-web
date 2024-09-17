import { auth } from "@/auth";
import { redirect } from "next/navigation";
import Form from "./form";

export default async function Page({ searchParams: { returnUrl, email } }: { searchParams: { returnUrl?: string, email?: string } }) {
  const session = await auth();
  if (session) {
    redirect(returnUrl || "/");
  }

  return (
    <Form returnUrl={returnUrl} email={email} />
  )
}