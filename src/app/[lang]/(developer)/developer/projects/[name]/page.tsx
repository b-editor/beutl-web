import { ScreenshotForm } from "./screenshot-form";
import { notFound } from "next/navigation";
import { retrievePackage } from "./actions";
import { PackageInfoForm } from "./package-info-form";
import { PackageDescriptionForm } from "./package-description-form";
import { PackageDetailsForm } from "./package-details-form";
import { PackagePricingForm } from "./package-pricing-form";
import { ReleaseForm } from "./release-form";
import { isAdmin } from "@/lib/admin-guard";
import { throwIfUnauth } from "@/lib/auth-guard";

export default async function Page(props: { params: Promise<{ name: string }> }) {
  const params = await props.params;

  const {
    name
  } = params;

  const session = await throwIfUnauth();
  const isAdminUser = isAdmin(session.user.id);
  const pkg = await retrievePackage(name);
  if (!pkg) {
    notFound();
  }

  return (
    <>
      <div className="max-w-5xl mx-auto py-10 lg:py-6 px-4 lg:px-6 bg-card lg:rounded-lg border text-card-foreground lg:my-4">
        <PackageInfoForm pkg={pkg} />

        <ScreenshotForm pkg={pkg} />

        <div className="flex max-lg:flex-col mt-6">
          <div className="lg:basis-2/3 lg:pr-6">
            <PackageDescriptionForm pkg={pkg} />
            <ReleaseForm pkg={pkg} />
          </div>
          <div className="lg:basis-1/3">
            <PackageDetailsForm pkg={pkg} />
            {isAdminUser && <PackagePricingForm pkg={pkg} />}
          </div>
        </div>
      </div>
    </>
  );
}
