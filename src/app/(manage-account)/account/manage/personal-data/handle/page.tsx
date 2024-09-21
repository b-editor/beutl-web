import { redirect } from "next/navigation";
import { deleteUser } from "./actions";
import { auth, signOut } from "@/auth";

export default async function Page({
  searchParams: {
    token, identifier,
  }
}: {
  searchParams: {
    token?: string, identifier?: string
  }
}) {
  const session = await auth();
  if (token && identifier) {
    if (!session?.user) {
      const url = new URL("/account/manage/personal-data/handle");
      url.searchParams.set("token", token);
      url.searchParams.set("identifier", identifier);
      signOut({
        redirectTo: url.toString(),
      });
    }

    deleteUser(token, identifier);
  }

  redirect("/");
}