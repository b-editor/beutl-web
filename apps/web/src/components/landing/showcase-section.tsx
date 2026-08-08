import { cn } from "@beutl/core";
import { LP_WRAP } from "./lp-parts";
import ShowcaseMedia, { type ShowcaseSource } from "./showcase-media";

/*
  The poster and the video have to share one aspect ratio: the frame reserves
  its space from the numbers below, so a mismatch would make the picture jump
  the moment the video takes over.
*/
const POSTER = "/img/showcase-poster.png";
const WIDTH = 2048;
const HEIGHT = 1152;

/*
  The poster is the video's own first frame, so the picture does not change when
  playback starts. It is a plain PNG because the poster attribute is a raw URL
  that never reaches next/image, and a screenshot of UI text survives lossless
  compression better than it survives a lossy one.
*/
const SOURCES: ReadonlyArray<ShowcaseSource> = [
  { src: "/img/showcase.webm", type: "video/webm" },
  { src: "/img/showcase.mp4", type: "video/mp4" },
];

const GLOW =
  "radial-gradient(75% 100% at 50% 0%, color-mix(in srgb, var(--color-lp-indigo) 20%, transparent), transparent 70%)";

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
          <ShowcaseMedia
            sources={SOURCES}
            poster={POSTER}
            width={WIDTH}
            height={HEIGHT}
            label={label}
          />
        </div>
        <figcaption className="mt-4 text-center text-sm text-lp-muted [overflow-wrap:anywhere]">
          {caption}
        </figcaption>
      </figure>
    </section>
  );
}
