import Link from "next/link";
import { Download, Github } from "lucide-react";
import { cn } from "@beutl/core";
import {
  Eyebrow,
  LP_BUTTON_GHOST,
  LP_BUTTON_PRIMARY,
  LP_CTA_ROW,
  LP_WRAP,
} from "./lp-parts";

export interface HeroTexts {
  eyebrow: string;
  titleLine1: string;
  titleLine2: string;
  lede: string;
  download: string;
  github: string;
}

export default function HeroSection({
  texts,
  downloadHref,
  githubHref,
}: {
  texts: HeroTexts;
  downloadHref: string;
  githubHref: string;
}) {
  return (
    <section className="pt-[clamp(48px,7vw,88px)] pb-10 md:pb-12">
      <div className={cn(LP_WRAP, "grid items-end gap-8 lg:grid-cols-[1.4fr_1fr] lg:gap-12")}>
        <div>
          <Eyebrow>{texts.eyebrow}</Eyebrow>
          <h1 className="mt-5 text-[clamp(min(28px,7.2vw),4.2vw,48px)] font-semibold tracking-[-0.035em] [overflow-wrap:anywhere] [word-break:keep-all] leading-[1.4]">
            {texts.titleLine1}
            <br />
            {texts.titleLine2}
          </h1>
        </div>
        <div>
          <p className="max-w-[44ch] text-[15px] leading-relaxed text-lp-muted [overflow-wrap:anywhere]">
            {texts.lede}
          </p>
          <div className={LP_CTA_ROW}>
            <Link href={downloadHref} className={LP_BUTTON_PRIMARY}>
              <Download aria-hidden="true" />
              {texts.download}
            </Link>
            <Link href={githubHref} className={LP_BUTTON_GHOST}>
              <Github aria-hidden="true" />
              {texts.github}
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
