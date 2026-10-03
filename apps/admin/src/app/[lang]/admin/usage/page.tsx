import { requireAdmin } from "../../../../lib/auth-guard";
import { firstSearchParam } from "../../../../lib/search-params";
import { parseDesktopUsageRange } from "../../../../lib/desktop-usage";
import { fetchDesktopUsage } from "../../../../lib/desktop-usage-server";
import { DesktopUsageView } from "./view";

export const dynamic = "force-dynamic";

export default async function Page(props: {
  params: Promise<{ lang: string }>;
  searchParams: Promise<{
    range?: string | string[];
    tool?: string | string[];
  }>;
}) {
  await requireAdmin();
  const { lang } = await props.params;
  const params = await props.searchParams;
  const range = parseDesktopUsageRange(firstSearchParam(params.range));
  return DesktopUsageView({
    lang,
    range,
    requestedTool: firstSearchParam(params.tool),
    result: await fetchDesktopUsage(range),
  });
}
