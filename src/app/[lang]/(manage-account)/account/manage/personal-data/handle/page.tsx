import { redirect } from "next/navigation";
import { deleteUser } from "./actions";
import { auth, signOut } from "@/auth";

export default async function Page({
  searchParams: { token, identifier },
}: {
  searchParams: {
    token?: string;
    identifier?: string;
  };
}) {
  const session = await auth();
  if (token && identifier) {
    if (!session?.user) {
      const searchParams = new URLSearchParams();
      searchParams.set("token", token);
      searchParams.set("identifier", identifier);
      signOut({
        redirectTo: `/account/manage/personal-data/handle?${searchParams.toString()}`,
      });
    }

    deleteUser(token, identifier);
  }

  redirect("/");
}
