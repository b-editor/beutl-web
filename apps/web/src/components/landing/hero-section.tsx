import Link from "next/link";
import { Download, Github } from "lucide-react";
import { cn } from "@beutl/core";
import ShaderCanvas from "./shader-canvas";
import {
  Eyebrow,
  LP_BUTTON_GHOST,
  LP_BUTTON_PRIMARY,
  LP_CTA_ROW,
  LP_WRAP,
} from "./lp-parts";

const SCRIM_BACKGROUND =
  "linear-gradient(90deg, rgba(9,8,15,0.86) 0%, rgba(9,8,15,0.5) 36%, rgba(9,8,15,0) 64%), linear-gradient(0deg, rgba(9,8,15,0.9) 2%, rgba(9,8,15,0) 40%)";

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
    <section className="relative flex min-h-[90svh] items-center overflow-hidden bg-lp-bg">
      <ShaderCanvas />
      <div
        className="pointer-events-none absolute inset-0 z-[1]"
        style={{ background: SCRIM_BACKGROUND }}
      />

      <div className={cn(LP_WRAP, "relative z-[2] pt-10 pb-15")}>
        <Eyebrow>{texts.eyebrow}</Eyebrow>
        {/* The 32px floor is relaxed below ~372px viewports: at that size the
            first line no longer fits on one line and the heading breaks to
            three lines. Above it the size matches the design as-is. */}
        <h1 className="mt-[22px] text-[clamp(min(32px,8.6vw),8vw,74px)] font-extrabold tracking-[-0.02em] [overflow-wrap:anywhere] [word-break:keep-all] leading-[1.1]">
          {texts.titleLine1}
          <br />
          <span className="bg-[linear-gradient(100deg,var(--color-lp-indigo-bright)_10%,var(--color-lp-coral)_90%)] bg-clip-text text-transparent">
            {texts.titleLine2}
          </span>
        </h1>
        <p className="mt-6 max-w-[42ch] text-[clamp(16px,2vw,20px)] text-lp-muted [overflow-wrap:anywhere]">
          {texts.lede}
        </p>
        <div className={LP_CTA_ROW}>
          <Link href={downloadHref} className={LP_BUTTON_PRIMARY}>
            <Download />
            {texts.download}
          </Link>
          <Link href={githubHref} className={LP_BUTTON_GHOST}>
            <Github />
            {texts.github}
          </Link>
        </div>
      </div>
    </section>
  );
}
