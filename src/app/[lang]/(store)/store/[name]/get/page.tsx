import { addAuditLog, auditLogActions } from "@/lib/audit-log";
import { authOrSignIn } from "@/lib/auth-guard";
import { existsUserPaymentHistory } from "@/lib/db/user-payment-history";
import { getDb } from "@/prisma";
import { notFound, redirect } from "next/navigation";

export default async function Page(props: { params: Promise<{ name: string; lang: string }> }) {
  const params = await props.params;

  const {
    name,
    lang
  } = params;

  const session = await authOrSignIn();

  const db = getDb();
  const pkg = await db.package.findFirst({
    where: {
      name: {
        equals: name,
        mode: "insensitive",
      },
      published: true,
    },
    select: {
      id: true,
      packagePricing: true,
    },
  });
  if (!pkg) {
    notFound();
  }

  if (pkg.packagePricing.length > 0) {
    // すでに支払いをしている場合、支払わずにuserPackageを作成する
    const record = await existsUserPaymentHistory({
      userId: session.user.id,
      packageId: pkg.id,
    });
    if (!record) {
      redirect(`/${lang}/store/${name}/checkout`);
    }
  }

  if (
    !(await db.userPackage.findFirst({
      where: { userId: session.user.id, packageId: pkg.id },
    }))
  ) {
    await db.userPackage.create({
      data: {
        userId: session.user.id,
        packageId: pkg.id,
      },
    });
    await addAuditLog({
      userId: session.user.id,
      action: auditLogActions.store.addToLibrary,
      details: `packageId: ${pkg.id}`,
    });
  }

  redirect(`/${lang}/store/${name}?message=PleaseOpenDesktopApp`);
}
