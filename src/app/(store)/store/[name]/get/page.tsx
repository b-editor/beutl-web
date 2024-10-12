import { auth } from "@/auth";
import { prisma } from "@/prisma";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";

export default async function Page({ params: { name } }: { params: { name: string } }) {
  const session = await auth();
  const xurl = headers().get("x-url") as string;
  if (!session?.user?.id) {
    redirect(`/account/sign-in?returnUrl=${encodeURIComponent(xurl)}`);
  }

  const pkg = await prisma.package.findFirst({
    where: {
      name: {
        equals: name,
        mode: "insensitive"
      },
      published: true
    },
    select: {
      id: true,
    }
  });
  if (!pkg) {
    notFound();
  }

  if (!await prisma.userPackage.findFirst({ where: { userId: session.user.id, packageId: pkg.id } })) {
    await prisma.userPackage.create({
      data: {
        userId: session.user.id,
        packageId: pkg.id
      }
    })
  }
  revalidatePath(`/store/${name}`);
  redirect(`/store/${name}`);
}