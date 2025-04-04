import { redirect } from "next/navigation";

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

  redirect(`https://docs.beutl.beditor.net/${lang}/${slug.join("/")}`);
}
