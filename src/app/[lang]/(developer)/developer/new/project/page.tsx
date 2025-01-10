import { authOrSignIn } from "@/lib/auth-guard";
import { Form } from "./components";

export default async function Page() {
  await authOrSignIn();

  return <Form />;
}
