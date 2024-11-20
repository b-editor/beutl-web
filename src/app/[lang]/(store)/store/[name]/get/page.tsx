import { authOrSignIn } from "@/lib/auth-guard";
import { prisma } from "@/prisma";
import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";

export default async function Page({ params: { name } }: { params: { name: string } }) {
  const session = await authOrSignIn();

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
      packagePricing: true,
    }
  });
  if (!pkg) {
    notFound();
  }

  if (pkg.packagePricing.length > 0) {
    redirect(`/store/${name}/checkout`);
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
  redirect(`/store/${name}?message=PleaseOpenDesktopApp`);
}