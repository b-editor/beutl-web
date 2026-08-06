export type SocialLink = {
  href: string;
  iconSrc: string;
  label: string;
};

export const socialLinks: SocialLink[] = [
  {
    href: "https://github.com/b-editor",
    iconSrc: "/img/github-color.svg",
    label: "GitHub",
  },
  {
    href: "https://x.com/yuto_daisensei",
    iconSrc: "/img/x.svg",
    label: "X",
  },
  {
    href: "https://discord.gg/Bm3pnVc928",
    iconSrc: "/img/discord.svg",
    label: "Discord",
  },
];

export type NavLinkKey = "docs" | "store" | "privacy" | "telemetry";

export function navHref(key: NavLinkKey, lang: string): string {
  switch (key) {
    case "docs":
      return `https://docs.beutl.beditor.net/${lang}`;
    case "store":
      return `/${lang}/store`;
    case "privacy":
      return `/${lang}/docs/privacy`;
    case "telemetry":
      return `/${lang}/docs/telemetry`;
  }
}
