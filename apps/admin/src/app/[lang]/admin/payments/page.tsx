import { getTranslation } from "@beutl/i18n";
import { requireAdmin } from "@/lib/auth-guard";
import { Pagination } from "@/components/admin/pagination";
import { fetchPaginated, parsePageParam } from "@/lib/pagination";
import {
  getPackagePaymentRefundInterventions,
  getTopUpCheckoutInterventions,
} from "../ai/queries";
import { PackagePaymentRefundInterventions } from "../ai/package-payment-refund-interventions";
import { TopUpResolutionInterventions } from "../ai/topup-resolution-interventions";
import { HelpPopover } from "@/components/admin/help-popover";

const PAGE_SIZE = 25;

export const dynamic = "force-dynamic";

export default async function Page(props: {
  params: Promise<{ lang: string }>;
  searchParams: Promise<{ page?: string | string[] }>;
}) {
  await requireAdmin();
  const { lang } = await props.params;
  const { page } = await props.searchParams;
  const { t } = await getTranslation(lang);
  const [topUpInterventions, packagePaymentRefundPage] = await Promise.all([
    getTopUpCheckoutInterventions(),
    fetchPaginated(
      (pageNumber) => getPackagePaymentRefundInterventions(pageNumber, PAGE_SIZE),
      parsePageParam(page),
      PAGE_SIZE,
    ),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold">{t("admin:payments.title")}</h1>
      </div>

      <section className="flex flex-col gap-3 rounded-lg border bg-card p-4">
        <div className="flex items-center gap-1">
          <h2 className="text-lg font-semibold">{t("admin:ai.interventions.topUp.title")}</h2>
          <HelpPopover lang={lang} title={t("admin:ai.interventions.topUp.title")}>
            {t("admin:ai.interventions.topUp.description")}
          </HelpPopover>
        </div>
        <TopUpResolutionInterventions lang={lang} rows={topUpInterventions} />
      </section>

      <section className="flex flex-col gap-3 rounded-lg border bg-card p-4">
        <div className="flex items-center gap-1">
          <h2 className="text-lg font-semibold">{t("admin:ai.interventions.packagePayment.title")}</h2>
          <HelpPopover lang={lang} title={t("admin:ai.interventions.packagePayment.title")}>
            {t("admin:ai.interventions.packagePayment.description")}
          </HelpPopover>
        </div>
        <PackagePaymentRefundInterventions
          lang={lang}
          rows={packagePaymentRefundPage.result.items}
        />
        <Pagination
          basePath={`/${lang}/admin/payments`}
          currentPage={packagePaymentRefundPage.currentPage}
          totalPages={packagePaymentRefundPage.totalPages}
          previousLabel={t("admin:common.previousPage")}
          nextLabel={t("admin:common.nextPage")}
        />
      </section>
    </div>
  );
}
