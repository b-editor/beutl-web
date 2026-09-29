import type { ReactNode } from "react";
import { cn } from "@beutl/core";

export const LP_WRAP = "mx-auto w-full max-w-[1180px] px-[clamp(20px,5vw,56px)]";

export const LP_SECTION = "border-t border-lp-border py-[clamp(40px,6vw,72px)]";

export const LP_MOCK_PANEL =
  "overflow-hidden rounded-lg border border-lp-border bg-lp-bg2 p-4 sm:p-5";

const LP_BUTTON =
  "inline-flex items-center justify-center gap-2 rounded-md border border-transparent px-4 py-2.5 text-sm font-medium transition-colors outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] [&>svg]:size-4 [&>svg]:shrink-0";

export const LP_BUTTON_PRIMARY = cn(
  LP_BUTTON,
  // White clears 4.5:1 on the dark primary; the shared off-white token does not.
  "bg-primary text-white hover:bg-primary/90",
);

export const LP_BUTTON_GHOST = cn(
  LP_BUTTON,
  "border-lp-border2 text-lp-text hover:bg-white/[0.06]",
);

export const LP_CTA_ROW = "mt-6 flex flex-wrap gap-3";

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
        "inline-flex flex-wrap items-center gap-2 text-xs font-medium leading-relaxed text-lp-muted",
        className,
      )}
    >
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
        "mt-3 text-[clamp(24px,3vw,30px)] font-semibold tracking-[-0.02em] text-balance text-lp-text [overflow-wrap:anywhere] leading-[1.4]",
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
        "mt-4 max-w-[48ch] text-[15px] leading-[1.9] text-lp-muted [overflow-wrap:anywhere]",
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
        "rounded-md border border-lp-border bg-white/[0.02] px-[11px] py-[7px] text-xs font-semibold text-lp-muted",
        hot && "border-lp-coral/35 bg-lp-coral/[0.08] text-lp-coral",
      )}
    >
      {children}
    </span>
  );
}

export function FeatureSection({
  eyebrow,
  headline,
  body,
  tocId,
  extra,
  mockClassName,
  children,
}: {
  eyebrow: string;
  headline: string;
  body: string;
  tocId?: string;
  extra?: ReactNode;
  mockClassName?: string;
  children: ReactNode;
}) {
  return (
    <section className={LP_SECTION}>
      <div className={LP_WRAP}>
        <div className="grid grid-cols-1 items-center gap-8 min-[900px]:grid-cols-[1fr_1.2fr] min-[900px]:gap-16 [&>*]:min-w-0">
          <div>
            <Eyebrow>{eyebrow}</Eyebrow>
            <Headline text={headline} tocId={tocId} />
            <BodyText>{body}</BodyText>
            {extra}
          </div>
          <div className={cn(LP_MOCK_PANEL, mockClassName)}>{children}</div>
        </div>
      </div>
    </section>
  );
}
