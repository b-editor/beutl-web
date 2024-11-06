import Footer from "@/components/footer";
import NavBar from "@/components/nav-bar";

export default async function Layout({
  children,
  params: { lang },
}: {
    children: React.ReactNode;
    params: {
      lang: string;
    };
}) {
  return (
    <div>
      <NavBar lang={lang} />
      {children}
      <Footer />
    </div>
  )
}