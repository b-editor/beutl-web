import { redirect } from "next/navigation";
import { resolveSafeRedirectPath } from "@beutl/core";

const DOCS_ORIGIN = "https://docs.beutl.beditor.net";

type Props = {
  params: Promise<{
    lang: string;
    slug: string[];
  }>;
};

export default async function Page(props: Props) {
  const params = await props.params;

  const {
    slug,
    lang
  } = params;

  const path = resolveSafeRedirectPath(
    `/${encodeURIComponent(lang)}/${slug.map((segment) => encodeURIComponent(segment)).join("/")}`,
    DOCS_ORIGIN,
  );
  redirect(`${DOCS_ORIGIN}${path ?? "/"}`);
}
