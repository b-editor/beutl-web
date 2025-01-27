import Form from "./form";

export default function Page({
  params: { lang },
}: { params: { lang: string } }) {
  return <Form lang={lang} />;
}
