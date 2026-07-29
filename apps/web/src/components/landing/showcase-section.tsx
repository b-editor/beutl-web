import Image from "next/image";
import { cn } from "@beutl/core";
import { LP_WRAP } from "./lp-parts";
import ShowcaseMedia, { type ShowcaseSource } from "./showcase-media";

/*
  The poster and the video have to share one aspect ratio: the frame reserves
  its space from the numbers below, so a mismatch would make the picture jump
  the moment the video takes over.
*/
const POSTER = "/img/brand-image.png";
const WIDTH = 3164;
const HEIGHT = 1936;

/*
  Availability is declared, not detected — the site runs on Cloudflare Workers,
  where there is no filesystem to ask. While this is empty the section shows the
  poster alone and requests nothing that is not there; adding the capture here
  is what turns the video on.
*/
const SOURCES: ReadonlyArray<ShowcaseSource> = [];

const GLOW =
  "radial-gradient(75% 100% at 50% 0%, rgba(109,92,247,0.20), transparent 70%)";

/*
  Deliberately not wrapped in AnimatedSection. This sits directly under the hero
  and so is usually the largest thing painted first; fading it in from nothing
  would push back the moment the page looks loaded.
*/
export default function ShowcaseSection({
  label,
  caption,
}: {
  label: string;
  caption: string;
}) {
  return (
    <section className="relative overflow-hidden bg-lp-bg pt-[clamp(40px,6vw,72px)] pb-[clamp(48px,7vw,88px)]">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-[min(60vw,520px)]"
        style={{ background: GLOW }}
      />

      <figure className={cn(LP_WRAP, "relative")}>
        <div className="overflow-hidden rounded-2xl border border-lp-border bg-lp-bg2 shadow-[0_50px_120px_-50px_rgba(109,92,247,0.55)]">
          {SOURCES.length > 0 ? (
            <ShowcaseMedia
              sources={SOURCES}
              poster={POSTER}
              width={WIDTH}
              height={HEIGHT}
              label={label}
            />
          ) : (
            <Image
              src={POSTER}
              width={WIDTH}
              height={HEIGHT}
              alt={label}
              priority
              sizes="(min-width: 1180px) 1068px, 100vw"
              className="h-auto w-full"
            />
          )}
        </div>
        <figcaption className="mt-4 text-center text-sm text-lp-muted [overflow-wrap:anywhere]">
          {caption}
        </figcaption>
      </figure>
    </section>
  );
}
