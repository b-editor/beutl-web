const VIDEO = "/img/agent-demo.mp4";
const POSTER = "/img/agent-demo-poster.png";
const WIDTH = 1920;
const HEIGHT = 1080;

/*
  Unlike the silent loop in the showcase, this video has a story and sound, so
  the reader starts it. preload="none" keeps its size off the first page load.
*/
export default function AgentDemoVideo({
  label,
  caption,
}: {
  label: string;
  caption: string;
}) {
  return (
    <figure>
      <video
        poster={POSTER}
        width={WIDTH}
        height={HEIGHT}
        controls
        playsInline
        preload="none"
        aria-label={label}
        className="h-auto w-full rounded-md"
      >
        <source src={VIDEO} type="video/mp4" />
      </video>
      <figcaption className="mt-3 text-xs leading-relaxed text-lp-muted [overflow-wrap:anywhere]">
        {caption}
      </figcaption>
    </figure>
  );
}
