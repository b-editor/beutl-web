import type { ReactNode } from "react";
import { cn } from "@beutl/core";
import AnimatedSection from "./animated-section";

export const LP_WRAP = "mx-auto w-full max-w-[1180px] px-[clamp(20px,5vw,56px)]";

export const LP_SECTION = "border-t border-lp-border py-[clamp(48px,7vw,88px)]";

export const LP_MOCK_PANEL =
  "overflow-hidden rounded-2xl border border-lp-border bg-gradient-to-b from-lp-surface to-lp-bg2 p-5";

const LP_BUTTON =
  "inline-flex items-center justify-center gap-2 rounded-lg border border-transparent px-6 py-3 text-[15px] font-semibold transition-all outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] [&>svg]:size-[18px] [&>svg]:shrink-0";

export const LP_BUTTON_PRIMARY = cn(
  LP_BUTTON,
  "bg-[linear-gradient(100deg,var(--color-lp-indigo),var(--color-lp-indigo-bright))] text-white shadow-[0_8px_22px_-12px_color-mix(in_srgb,var(--color-lp-indigo)_70%,transparent)] hover:-translate-y-0.5",
);

export const LP_BUTTON_GHOST = cn(
  LP_BUTTON,
  "border-lp-border2 bg-white/[0.04] text-lp-text hover:-translate-y-0.5 hover:bg-white/[0.08]",
);

export const LP_CTA_ROW = "mt-[34px] flex flex-wrap gap-[14px]";

/** Both patterns below are built from this, so a new boundary is added once. */
const PHRASE_BOUNDARY_CHARS = "、。！？・";
const PHRASE_BOUNDARY = new RegExp(`[${PHRASE_BOUNDARY_CHARS}]`);
const PHRASE_SPLIT = new RegExp(`([${PHRASE_BOUNDARY_CHARS}|])`);

/**
 * Splits a headline at Japanese punctuation and at an explicit "|" marker, which
 * is itself never rendered. Each phrase is emitted as its own inline-block span,
 * so a headline normally wraps only between phrases.
 *
 * It is not a guarantee. A phrase wider than the line still breaks inside
 * itself, because the headline carries overflow-wrap: anywhere — without it a
 * long phrase would push the page sideways instead, which matters more here.
 *
 * Body copy gets none of this and is left to the browser's per-character CJK
 * breaking.
 */
export function splitPhrases(text: string): string[] {
  const phrases: string[] = [];
  let current = "";
  const flush = () => {
    if (current) {
      phrases.push(current);
      current = "";
    }
  };

  const tokens = text.split(PHRASE_SPLIT).filter(Boolean);
  tokens.forEach((token, index) => {
    if (token === "|") {
      flush();
      return;
    }
    current += token;
    // Keep a run of punctuation on the phrase it closes, so that a line never
    // opens with a lone ？ or 、.
    const nextToken = tokens[index + 1] ?? "";
    if (PHRASE_BOUNDARY.test(token) && !PHRASE_BOUNDARY.test(nextToken)) {
      flush();
    }
  });
  flush();

  return phrases;
}

export function Eyebrow({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-[9px] text-xs font-extrabold tracking-[0.14em] text-lp-indigo-bright uppercase",
        "before:h-0.5 before:w-[22px] before:shrink-0 before:rounded-[2px] before:bg-gradient-to-r before:from-lp-indigo before:to-lp-coral before:content-['']",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function EyebrowBadge({ children }: { children: ReactNode }) {
  return (
    <span className="ml-[10px] inline-flex items-center rounded-full border border-lp-indigo/30 bg-lp-indigo/[0.12] px-[10px] py-[3px] align-middle text-xs font-extrabold text-lp-indigo-bright">
      {children}
    </span>
  );
}

/**
 * `tocId` marks the heading as a FeaturesToc target; the toc tracks scroll
 * position through the `.features-header` class and reads the id from it.
 */
export function Headline({
  text,
  tocId,
  className,
}: {
  text: string;
  tocId?: string;
  className?: string;
}) {
  return (
    <h2
      id={tocId}
      className={cn(
        "mt-4 text-[clamp(24px,3.6vw,38px)] font-extrabold tracking-[-0.01em] text-balance text-lp-text [overflow-wrap:anywhere] leading-[1.2]",
        tocId && "features-header scroll-mt-20 md:scroll-mt-36",
        className,
      )}
    >
      {splitPhrases(text).map((phrase, index) => (
        <span key={`${index}-${phrase}`} className="inline-block max-w-full">
          {phrase}
        </span>
      ))}
    </h2>
  );
}

export function BodyText({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <p
      className={cn(
        "mt-[18px] max-w-[46ch] text-[clamp(15px,1.6vw,17px)] text-lp-muted [overflow-wrap:anywhere]",
        className,
      )}
    >
      {children}
    </p>
  );
}

export function Chip({ children, hot }: { children: ReactNode; hot?: boolean }) {
  return (
    <span
      className={cn(
        "rounded-lg border border-lp-border bg-white/[0.02] px-[11px] py-[7px] text-xs font-semibold text-lp-muted",
        hot && "border-lp-coral/35 bg-lp-coral/[0.08] text-lp-coral",
      )}
    >
      {children}
    </span>
  );
}

export function FeatureSection({
  eyebrow,
  badge,
  headline,
  body,
  tocId,
  reverse,
  extra,
  mockClassName,
  children,
}: {
  eyebrow: string;
  badge?: string;
  headline: string;
  body: string;
  tocId?: string;
  reverse?: boolean;
  extra?: ReactNode;
  mockClassName?: string;
  children: ReactNode;
}) {
  return (
    <section className={LP_SECTION}>
      <AnimatedSection className={LP_WRAP}>
        <div className="grid grid-cols-1 items-center gap-10 min-[900px]:grid-cols-2 min-[900px]:gap-14 [&>*]:min-w-0">
          <div className={cn(reverse && "min-[900px]:order-2")}>
            <Eyebrow>
              {eyebrow}
              {badge ? <EyebrowBadge>{badge}</EyebrowBadge> : null}
            </Eyebrow>
            <Headline text={headline} tocId={tocId} />
            <BodyText>{body}</BodyText>
            {extra}
          </div>
          <div className={cn(LP_MOCK_PANEL, mockClassName)}>{children}</div>
        </div>
      </AnimatedSection>
    </section>
  );
}
