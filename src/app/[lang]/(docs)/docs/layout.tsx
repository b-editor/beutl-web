import Footer from "@/components/footer";
import NavBar from "@/components/nav-bar";

export default async function Layout(
  props: {
    children: React.ReactNode;
    params: Promise<{
      lang: string;
    }>;
  }
) {
  const params = await props.params;

  const {
    lang
  } = params;

  const {
    children
  } = props;

  return (
    <div>
      <NavBar lang={lang} />
      {children}
      <Footer lang={lang} />
    </div>
  );
}
