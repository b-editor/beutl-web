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

export default function ShowcaseSection({
  label,
  caption,
}: {
  label: string;
  caption: string;
}) {
  return (
    <section className="pb-[clamp(40px,6vw,72px)]">
      <figure className={LP_WRAP}>
        <div className="overflow-hidden rounded-lg border border-lp-border2 bg-lp-bg2">
          <ShowcaseMedia
            sources={SOURCES}
            poster={POSTER}
            width={WIDTH}
            height={HEIGHT}
            label={label}
          />
        </div>
        <figcaption className="mt-3 text-xs leading-relaxed text-lp-muted [overflow-wrap:anywhere]">
          {caption}
        </figcaption>
      </figure>
    </section>
  );
}
