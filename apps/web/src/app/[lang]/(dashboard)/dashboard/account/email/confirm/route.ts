import { redirect } from "next/navigation";
import { approveEmailChange, updateEmail } from "../actions";

// Verification is a token-authorized mutation. Execute it before rendering
// the settings page, where Next.js does not allow cache revalidation.
export async function GET(request: Request, props: { params: Promise<{ lang: string }> }) {
  const { lang } = await props.params;
  const query = new URL(request.url).searchParams;
  const token = query.get("token");
  const identifier = query.get("identifier");
  if (!token || !identifier) redirect(`/${lang}/dashboard/account/email?status=emailUpdateFailed`);
  if (query.get("approval") === "1") await approveEmailChange(token, identifier);
  else await updateEmail(token, identifier);
}
