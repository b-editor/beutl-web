import { ScreenshotForm } from "./screenshot-form";
import { notFound } from "next/navigation";
import { retrievePackage } from "./actions";
import { PackageInfoForm } from "./package-info-form";
import { PackageDescriptionForm } from "./package-description-form";
import { PackageDetailsForm } from "./package-details-form";
import { ReleaseForm } from "./release-form";

export default async function Page({
  params: { name },
}: { params: { name: string } }) {
  const pkg = await retrievePackage(name);
  if (!pkg) {
    notFound();
  }

  return (
    <>
      <div className="bg-secondary py-4 *:text-center">
        <p>この画面は実装途中です</p>
        <p>詳細な編集はデスクトップアプリをご利用ください</p>
      </div>
      <div className="max-w-5xl mx-auto py-10 lg:py-6 px-4 lg:px-6 bg-card lg:rounded-lg border text-card-foreground lg:my-4">
        <PackageInfoForm pkg={pkg} />

        <ScreenshotForm pkg={pkg} />

        <div className="flex max-lg:flex-col mt-6">
          <div className="lg:basis-2/3 lg:pr-6">
            <PackageDescriptionForm pkg={pkg} />
            <ReleaseForm pkg={pkg} />
          </div>
          <PackageDetailsForm pkg={pkg} />
        </div>
      </div>
    </>
  );
}
