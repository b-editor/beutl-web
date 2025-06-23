import { addAuditLog, auditLogActions } from "@/lib/audit-log";
import { authOrSignIn } from "@/lib/auth-guard";
import { existsUserPaymentHistory } from "@/lib/db/user-payment-history";
import { drizzle } from "@/drizzle";
import { notFound, redirect } from "next/navigation";
import { and, eq, ilike } from "drizzle-orm";
import { packagePricing, packages, userPackage } from "@/drizzle/schema";

export default async function Page(props: { params: Promise<{ name: string; lang: string }> }) {
  const params = await props.params;

  const {
    name,
    lang
  } = params;

  const session = await authOrSignIn();
  const db = await drizzle();
  const pkg = await db
    .select({
      id: packages.id,
    })
    .from(packages)
    .where(
      and(
        ilike(packages.name, name),
        eq(packages.published, true),
      )
    )
    .limit(1)
    .then((rows) => rows.at(0));
  if (!pkg) {
    notFound();
  }

  const pricings = await db
    .select()
    .from(packagePricing)
    .where(eq(packagePricing.packageId, pkg.id));

  if (pricings.length > 0) {
    // すでに支払いをしている場合、支払わずにuserPackageを作成する
    const record = await existsUserPaymentHistory({
      userId: session.user.id,
      packageId: pkg.id,
    });
    if (!record) {
      redirect(`/${lang}/store/${name}/checkout`);
    }
  }
  const userPackageRecord = await db
    .select()
    .from(userPackage)
    .where(
      and(
        eq(userPackage.userId, session.user.id),
        eq(userPackage.packageId, pkg.id)
      )
    )
    .limit(1)
    .then((rows) => rows.at(0));

  if (!userPackageRecord) {
    await db
      .insert(userPackage)
      .values({
        userId: session.user.id,
        packageId: pkg.id,
      });
    await addAuditLog({
      userId: session.user.id,
      action: auditLogActions.store.addToLibrary,
      details: `packageId: ${pkg.id}`,
    });
  }

  redirect(`/${lang}/store/${name}?message=PleaseOpenDesktopApp`);
}
