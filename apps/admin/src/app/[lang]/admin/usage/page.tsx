import { requireAdmin } from "../../../../lib/auth-guard";
import { firstSearchParam } from "../../../../lib/search-params";
import { parseDesktopUsageRange } from "../../../../lib/desktop-usage";
import { fetchDesktopUsage } from "../../../../lib/desktop-usage-server";
import { parseDesktopErrorFilter } from "../../../../lib/desktop-errors";
import { fetchDesktopErrors } from "../../../../lib/desktop-errors-server";
import { DesktopErrorsView } from "./errors";
import { DesktopUsageView } from "./view";

export const dynamic = "force-dynamic";

export default async function Page(props: {
  params: Promise<{ lang: string }>;
  searchParams: Promise<{
    range?: string | string[];
    tool?: string | string[];
    tab?: string | string[];
    level?: string | string[];
  }>;
}) {
  await requireAdmin();
  const { lang } = await props.params;
  const params = await props.searchParams;
  const range = parseDesktopUsageRange(firstSearchParam(params.range));
  if (firstSearchParam(params.tab) === "errors") {
    const level = parseDesktopErrorFilter(firstSearchParam(params.level));
    return DesktopErrorsView({
      lang,
      range,
      level,
      result: await fetchDesktopErrors(range, level),
    });
  }
  return DesktopUsageView({
    lang,
    range,
    requestedTool: firstSearchParam(params.tool),
    result: await fetchDesktopUsage(range),
  });
}
