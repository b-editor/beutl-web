import { listFilesForAdmin, type AdminFileOrder } from "@beutl/db";
import { formatBytes } from "@beutl/core";
import { getTranslation } from "@beutl/i18n";
import type { StorageStores } from "@beutl/api";
import { Badge } from "@beutl/ui/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@beutl/ui/ui/table";
import Link from "next/link";
import { requireAdmin } from "@/lib/auth-guard";
import { formatTimestamp } from "@/lib/format";
import { fetchPaginated, parsePageParam } from "@/lib/pagination";
import { firstSearchParam } from "@/lib/search-params";
import { getStorageStores, locateFiles, type FileLocation } from "@/lib/storage";
import { Pagination } from "@/components/admin/pagination";
import { MoveFileButton, StorageBatchPanel, StorageSearchForm } from "./components";

const PAGE_SIZE = 20;

// The location column is read from the stores on every render; never cache it.
export const dynamic = "force-dynamic";

function LocationCell({
  location,
  t,
}: {
  location: FileLocation | undefined;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  if (!location) return null;
  if (location.kind === "error") {
    return (
      <span className="text-xs text-destructive">
        {t("admin:storage.location.unknown", { error: location.error })}
      </span>
    );
  }
  if (location.locations.length === 0) {
    return <Badge variant="destructive">{t("admin:storage.location.missing")}</Badge>;
  }
  return (
    <div className="flex flex-wrap gap-1">
      {location.locations.map((entry) => (
        <Badge key={entry.provider} variant="secondary">
          {t(`admin:storage.providers.${entry.provider}`)}
        </Badge>
      ))}
    </div>
  );
}

export default async function Page(props: {
  params: Promise<{ lang: string }>;
  searchParams: Promise<{
    q?: string | string[];
    page?: string | string[];
    order?: string | string[];
  }>;
}) {
  await requireAdmin();
  const { lang } = await props.params;
  const searchParams = await props.searchParams;
  const q = firstSearchParam(searchParams.q);
  const order: AdminFileOrder =
    firstSearchParam(searchParams.order) === "desc" ? "desc" : "asc";
  const { t } = await getTranslation(lang);

  let stores: StorageStores | null = null;
  let configError: string | null = null;
  try {
    stores = await getStorageStores();
  } catch (error) {
    configError = error instanceof Error ? error.message : String(error);
  }

  const { result, currentPage, totalPages } = await fetchPaginated(
    (pageNumber) =>
      listFilesForAdmin({ query: q, page: pageNumber, pageSize: PAGE_SIZE, order }),
    parsePageParam(searchParams.page),
    PAGE_SIZE,
  );
  const locations = stores
    ? await locateFiles(result.items, stores.stores)
    : new Map<string, FileLocation>();
  const [primary, fallback] = stores?.stores ?? [];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold">{t("admin:storage.title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("admin:storage.description")}
        </p>
      </div>

      {configError ? (
        <p className="rounded-lg border border-destructive p-4 text-sm text-destructive">
          {t("admin:storage.stores.configError", { error: configError })}
        </p>
      ) : (
        <section className="grid gap-4 sm:grid-cols-2">
          <div className="rounded-lg border bg-card p-4 text-card-foreground">
            <p className="text-xs text-muted-foreground">{t("admin:storage.stores.primary")}</p>
            <p className="mt-1 font-medium">{primary?.label ?? t("admin:storage.stores.none")}</p>
          </div>
          <div className="rounded-lg border bg-card p-4 text-card-foreground">
            <p className="text-xs text-muted-foreground">{t("admin:storage.stores.fallback")}</p>
            <p className="mt-1 font-medium">{fallback?.label ?? t("admin:storage.stores.none")}</p>
          </div>
        </section>
      )}

      {stores && stores.stores.length > 1 && (
        <StorageBatchPanel
          lang={lang}
          destinations={stores.stores.map((store) => ({
            provider: store.provider,
            label: store.label,
          }))}
          defaultTo={stores.primary}
        />
      )}

      <StorageSearchForm lang={lang} query={q} order={order} />

      {result.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("admin:storage.noResults")}</p>
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("admin:storage.columns.name")}</TableHead>
                <TableHead>{t("admin:storage.columns.owner")}</TableHead>
                <TableHead className="text-right">{t("admin:storage.columns.size")}</TableHead>
                <TableHead>{t("admin:storage.columns.createdAt")}</TableHead>
                <TableHead>{t("admin:storage.columns.location")}</TableHead>
                <TableHead className="text-right">{t("admin:storage.columns.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.items.map((file) => {
                const location = locations.get(file.objectKey);
                const present = new Set(
                  location?.kind === "located"
                    ? location.locations.map((entry) => entry.provider)
                    : [],
                );
                // A file that is nowhere has nothing to move; one found in
                // both stores can be consolidated into either.
                const targets =
                  location?.kind === "located" && present.size > 0
                    ? (stores?.stores ?? []).filter(
                        (store) => !(present.size === 1 && present.has(store.provider)),
                      )
                    : [];
                return (
                  <TableRow key={file.id}>
                    <TableCell className="max-w-xs">
                      <div className="truncate font-medium" title={file.name}>{file.name}</div>
                      <div className="truncate text-xs text-muted-foreground" title={file.objectKey}>
                        {file.objectKey}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Link
                        href={`/${lang}/admin/users/${file.user.id}`}
                        className="hover:underline"
                      >
                        {file.user.email}
                      </Link>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatBytes(Number(file.size))}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatTimestamp(file.createdAt, lang)}
                    </TableCell>
                    <TableCell>
                      <LocationCell location={location} t={t} />
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        {targets.map((store) => (
                          <MoveFileButton
                            key={store.provider}
                            lang={lang}
                            fileId={file.id}
                            to={store.provider}
                          />
                        ))}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>

          <Pagination
            basePath={`/${lang}/admin/storage`}
            params={{ q, order }}
            currentPage={currentPage}
            totalPages={totalPages}
            previousLabel={t("admin:common.previousPage")}
            nextLabel={t("admin:common.nextPage")}
          />
        </>
      )}
    </div>
  );
}
