import { auth } from "@/auth";
import { prisma } from "@/prisma";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Form } from "./components";

export default async function Page() {
  const session = await auth();
  const url = headers().get("x-url") || "/";
  if (!session?.user) {
    const searchParams = new URLSearchParams();
    searchParams.set("returnUrl", url);
    redirect(`/account/sign-in?${searchParams.toString()}`);
  }

  const profile = await prisma.profile.findFirst({
    where: {
      userId: session.user.id,
    },
  });
  const socials = await prisma.socialProfile.findMany({
    where: {
      userId: session.user.id,
    },
    select: {
      value: true,
      provider: {
        select: {
          id: true,
          name: true,
          urlTemplate: true,
        }
      }
    }
  });

  return (
    <div>
      <h2 className="font-bold text-2xl">プロフィール</h2>
      <Form profile={profile} socials={socials} className="mt-4" />
    </div>
  )
}