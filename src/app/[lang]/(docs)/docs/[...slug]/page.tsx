import { redirect } from "next/navigation"

type Props = {
  params: {
    lang: string
    slug: string[]
  }
}

export default function Page({ params: { slug, lang } }: Props) { 
  redirect(`https://docs.beutl.beditor.net/${lang}/${slug.join('/')}`)
}