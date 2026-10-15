import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Download, ExternalLink, PackageOpen } from "lucide-react";
import { findNugetPackage, findNugetVersion, releaseMetadata, sortNugetReleases } from "@beutl/api/nuget/catalog";
import { NUGET_SERVICE_INDEX, nugetPackageUrl, normalizeNugetId, normalizeNugetVersion } from "@beutl/core";
import { getTranslation } from "@beutl/i18n";
import { Button } from "@beutl/ui/ui/button";
import { Badge } from "@beutl/ui/ui/badge";
import { Markdown } from "@beutl/ui/ui/markdown";

const safeUrl = (value: string) => /^https?:\/\//iu.test(value) ? value : null;

export default async function Page({ params, searchParams }: {
  params: Promise<{ lang: string; name: string }>;
  searchParams: Promise<{ version?: string }>;
}) {
  const { lang, name } = await params, { version } = await searchParams;
  try { normalizeNugetId(name); if (version) normalizeNugetVersion(version); } catch { notFound(); }
  const pkg = await findNugetPackage(name, "DEVELOPMENT");
  if (!pkg?.Release.length) notFound();
  const releases = sortNugetReleases(pkg.Release);
  const release = version ? findNugetVersion(pkg, version) : releases.find((r) => r.nugetListed) ?? releases[0];
  if (!release) notFound();
  const { metadata: m, readme } = await releaseMetadata(pkg, release);
  const { t } = await getTranslation(lang);
  const snippets = [
    [".NET CLI", `dotnet add package ${pkg.name} --version ${release.version} --source ${NUGET_SERVICE_INDEX}`],
    ["Package Manager", `Install-Package ${pkg.name} -Version ${release.version} -Source ${NUGET_SERVICE_INDEX}`],
    ["PackageReference", `<PackageReference Include="${pkg.name}" Version="${release.version}" />`],
  ];
  return (
    <main className="max-w-6xl mx-auto px-4 py-10 md:px-8 space-y-8">
      <Link href={`/${lang}/store?type=development`} className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" />{t("developer:nuget.back")}</Link>
      <div className="flex flex-col md:flex-row justify-between gap-6">
        <div className="space-y-3 min-w-0"><div className="flex items-center gap-3"><PackageOpen className="size-7 shrink-0" /><h1 className="text-3xl font-bold break-all">{pkg.name}</h1></div>
          <div className="flex gap-2 flex-wrap"><Badge>{release.version}</Badge><Badge variant="outline">{t("developer:nuget.title")}</Badge>{!release.nugetListed && <Badge variant="secondary">{t("developer:nuget.unlisted")}</Badge>}</div>
          {m.title !== pkg.name && <p className="text-lg text-muted-foreground">{m.title}</p>}
        </div>
        <Button asChild variant="outline" className="shrink-0"><a href={nugetPackageUrl(pkg.name, release.version)}><Download className="mr-2 size-4" />{t("developer:nuget.download")}</a></Button>
      </div>
      <div className="grid lg:grid-cols-[minmax(0,1fr)_280px] gap-8">
        <div className="min-w-0 space-y-8">
          <p className="leading-relaxed whitespace-pre-wrap">{m.description}</p>
          <section className="rounded-xl border p-5 space-y-5"><h2 className="text-lg font-semibold">{t("developer:nuget.install")}</h2>
            {snippets.map(([label, code]) => <div key={label} className="space-y-2"><h3 className="text-xs font-medium text-muted-foreground">{label}</h3><pre className="rounded-md bg-muted p-3 text-xs leading-relaxed overflow-x-auto"><code>{code}</code></pre></div>)}
          </section>
          {readme && <section className="space-y-4 min-w-0 overflow-hidden"><h2 className="text-xl font-semibold">{t("developer:nuget.readme")}</h2><Markdown>{readme}</Markdown></section>}
          <section className="space-y-4"><h2 className="text-xl font-semibold">{t("developer:nuget.dependencies")}</h2>
            {!m.dependencyGroups.length && <p className="text-sm text-muted-foreground">{t("developer:nuget.noDependencies")}</p>}
            {m.dependencyGroups.map((group, i) => <div className="rounded-lg border overflow-hidden" key={i}>
              <h3 className="bg-muted/40 px-4 py-3 text-sm font-medium">{group.targetFramework || "Any"}</h3>
              {group.dependencies.length ? <ul className="divide-y">{group.dependencies.map((d) => <li key={d.id} className="px-4 py-3 text-sm flex flex-wrap justify-between gap-2"><Link className="underline underline-offset-4 break-all" href={`/${lang}/store?type=development&query=${encodeURIComponent(d.id)}`}>{d.id}</Link><code className="text-muted-foreground">{d.range}</code></li>)}</ul>
                : <p className="px-4 py-3 text-sm text-muted-foreground">{t("developer:nuget.noDependencies")}</p>}
            </div>)}
          </section>
          {m.releaseNotes && <section className="space-y-4"><h2 className="text-xl font-semibold">{t("developer:release.description")}</h2><Markdown>{m.releaseNotes}</Markdown></section>}
        </div>
        <aside className="space-y-6 min-w-0">
          <section className="rounded-xl border p-5 space-y-4"><h2 className="font-semibold">{t("developer:nuget.details")}</h2>
            <dl className="space-y-4 text-sm">
              {[[t("developer:nuget.authors"), m.authors], [t("developer:nuget.published"), release.createdAt.toLocaleDateString(lang)],
                [t("developer:nuget.downloads"), Number(release.downloads).toLocaleString(lang)], [t("developer:nuget.license"), m.license]].filter(([, v]) => v).map(([label, value]) => <div key={label}><dt className="text-muted-foreground text-xs mb-1">{label}</dt><dd className="break-words">{value}</dd></div>)}
            </dl>
            {[[t("developer:nuget.project"), m.projectUrl], [t("developer:nuget.repository"), m.repository.url], [t("developer:nuget.license"), m.licenseUrl]].map(([label, url]) => safeUrl(url) && <a key={label} href={url} rel="noreferrer" className="text-sm flex items-center gap-2 underline underline-offset-4">{label}<ExternalLink className="size-3" /></a>)}
            <div className="flex gap-1.5 flex-wrap">{m.tags.map((tag) => <Badge variant="secondary" key={tag} className="break-all">{tag}</Badge>)}</div>
          </section>
          <section className="rounded-xl border p-5 space-y-3"><h2 className="font-semibold">{t("developer:nuget.versions")} <span className="text-muted-foreground font-normal">({releases.length})</span></h2>
            <ul className="space-y-1 max-h-96 overflow-y-auto">{releases.map((r) => <li key={r.id}><Link href={`/${lang}/packages/${encodeURIComponent(pkg.name)}?version=${encodeURIComponent(r.version)}`} aria-current={r.id === release.id ? "page" : undefined}
              className={`flex justify-between rounded-md px-3 py-2 text-sm gap-2 ${r.id === release.id ? "bg-secondary font-medium" : "hover:bg-muted"}`}><span className="break-all">{r.version}</span>{!r.nugetListed && <span className="text-muted-foreground text-xs">{t("developer:nuget.unlisted")}</span>}</Link></li>)}</ul>
          </section>
        </aside>
      </div>
    </main>
  );
}
