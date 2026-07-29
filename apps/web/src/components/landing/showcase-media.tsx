"use client";

import { useEffect, useRef } from "react";

export interface ShowcaseSource {
  src: string;
  type: string;
}

/**
 * Playback is started from script rather than the autoplay attribute, so that
 * the poster is what remains on screen whenever the video does not run — the
 * reader asked for less motion, the browser refused autoplay, or the file has
 * not arrived yet. The markup is the same either way, so there is nothing for
 * hydration to disagree about.
 *
 * Once a video has painted a frame its poster is gone for good, so pausing
 * later leaves a still frame rather than the poster. That only happens if the
 * preference changes mid-visit, and a frozen frame of the editor is a fine
 * thing to be left with.
 */
export default function ShowcaseMedia({
  sources,
  poster,
  width,
  height,
  label,
}: {
  sources: ReadonlyArray<ShowcaseSource>;
  poster: string;
  width: number;
  height: number;
  label: string;
}) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;

    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let visible = false;

    const sync = () => {
      if (visible && !motion.matches) {
        // A refused play() leaves the poster up, which is the fallback anyway.
        video.play().catch(() => {});
      } else {
        video.pause();
      }
    };

    // No reason to decode video the reader has already scrolled past.
    const visibility = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      sync();
    });
    visibility.observe(video);
    motion.addEventListener("change", sync);

    return () => {
      visibility.disconnect();
      motion.removeEventListener("change", sync);
    };
  }, []);

  return (
    <video
      ref={ref}
      poster={poster}
      width={width}
      height={height}
      muted
      loop
      playsInline
      preload="metadata"
      aria-label={label}
      className="h-auto w-full"
    >
      {sources.map((source) => (
        <source key={source.src} src={source.src} type={source.type} />
      ))}
    </video>
  );
}
