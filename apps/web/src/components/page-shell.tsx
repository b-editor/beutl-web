import NavBar from "@/components/nav-bar";
import Footer from "@/components/footer";

export function PageShell({
  lang,
  footer = false,
  children,
}: {
  lang: string;
  footer?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <NavBar lang={lang} />
      {children}
      {footer && <Footer lang={lang} />}
    </div>
  );
}
