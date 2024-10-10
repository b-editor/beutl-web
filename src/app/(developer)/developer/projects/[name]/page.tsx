import { ScreenshotForm } from "./screenshot-form";
import { notFound } from "next/navigation";
import { retrievePackage } from "./actions";
import { PackageInfoForm } from "./package-info-form";
import { PackageDescriptionForm } from "./package-description-form";
import { PackageDetailsForm } from "./package-details-form";

export default async function Page({ params: { name } }: { params: { name: string } }) {
  const pkg = await retrievePackage(name);
  if (!pkg) {
    notFound();
  }

  return (
    <div className="max-w-5xl mx-auto py-10 lg:py-6 px-4 lg:px-6 bg-card lg:rounded-lg border text-card-foreground lg:my-4">
      <PackageInfoForm pkg={pkg} />

      <ScreenshotForm pkg={pkg} />

      <div className="flex max-lg:flex-col mt-6">
        <PackageDescriptionForm pkg={pkg} />
        {/* <div className="lg:basis-2/3 lg:pr-6">
          <h3 className="font-bold text-xl mt-6 border-b pb-2">説明</h3>
          <p className="mt-4 whitespace-pre-wrap" style={{ wordWrap: "break-word" }}>
            {pkg.description}
          </p>
          {selectedRelease && (
            <>
              <h3 className="font-bold text-xl mt-6 border-b pb-2">{selectedVersion === defaultVersion ? "最新のリリース" : "選択されているリリース"}</h3>
              <p className="mt-4 whitespace-pre-wrap" style={{ wordWrap: "break-word" }}>
                {selectedRelease.title}<br />
                {selectedRelease.body}
              </p>
            </>
          )}
        </div> */}
        <PackageDetailsForm pkg={pkg} />
        {/* <div className="lg:basis-1/3">
          <h4 className="font-bold text-lg mt-6 border-b pb-2">詳細</h4>
          <div className="flex gap-2 flex-col my-4">
            <h4>タグ</h4>
            <div className="flex gap-1 flex-wrap">
              {pkg.tags.map((tag) => (<Badge key={tag}>{tag}</Badge>))}
            </div>
          </div>
          <Separator />
          <div className="flex gap-2 my-4 justify-between">
            <h4>作者</h4>
            <Button asChild variant="link" className="p-0 h-auto" >
              <Link href="/">{pkg.owner.name}</Link>
            </Button>
          </div>
          <Separator />
          <div className="flex gap-2 my-4 justify-between">
            <h4>{selectedVersion === defaultVersion ? "最新のバージョン" : "選択されているバージョン"}</h4>
            <p>{selectedVersion}</p>
          </div>
          <Separator />
          <div className="flex gap-2 my-4 justify-between">
            <h4>ターゲットバージョン</h4>
            <p>{selectedRelease?.target_version}</p>
          </div>
        </div> */}
      </div>
    </div>
  )
}
