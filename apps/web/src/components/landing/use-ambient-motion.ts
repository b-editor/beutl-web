"use client";

import { type RefObject, useEffect } from "react";

type Options = {
  /** Fraction of the element that must be visible before the loop runs. */
  threshold?: number;
  /** Called whenever prefers-reduced-motion is, or becomes, active, so a mock
   * can switch to a still frame that makes sense on its own. */
  onReducedMotion?: () => void;
};

/**
 * Runs `frame` on every animation frame while `ref` is on screen, passing the
 * seconds of animation shown so far and since the previous frame. Return
 * `false` from `frame` to end the loop for good, for a one-shot animation.
 *
 * Nothing runs under prefers-reduced-motion, and the preference is followed
 * live: turning it on mid-loop stops the loop, turning it off resumes it. The
 * loop also stops while the element is scrolled away, which keeps several
 * always-on mocks from burning frames off screen.
 */
export function useAmbientMotion(
  ref: RefObject<Element | null>,
  frame: (time: number, delta: number) => boolean | void,
  { threshold = 0, onReducedMotion }: Options = {},
) {
  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let visible = false;
    let finished = false;
    let handle = 0;
    /** Timestamp of the previous frame, or null right after (re)starting. */
    let previous: number | null = null;
    /** Seconds of animation actually shown. It advances by each frame's
     * delta, capped, so time spent in a background tab (where frames are
     * suspended but timestamps keep moving) or scrolled away is not counted. */
    let time = 0;

    const stop = () => {
      cancelAnimationFrame(handle);
      handle = 0;
    };

    const tick = (now: number) => {
      const delta =
        previous === null ? 0 : Math.min(0.1, (now - previous) / 1000);
      previous = now;
      time += delta;
      if (frame(time, delta) === false) {
        finished = true;
        handle = 0;
        return;
      }
      handle = requestAnimationFrame(tick);
    };

    const sync = () => {
      if (motion.matches) {
        stop();
        onReducedMotion?.();
      } else if (visible && !finished) {
        if (!handle) {
          previous = null;
          handle = requestAnimationFrame(tick);
        }
      } else {
        stop();
      }
    };

    const observer = new IntersectionObserver(
      ([entry]) => {
        visible = entry.isIntersecting && entry.intersectionRatio >= threshold;
        sync();
      },
      { threshold },
    );
    observer.observe(element);
    motion.addEventListener("change", sync);
    sync();

    return () => {
      observer.disconnect();
      motion.removeEventListener("change", sync);
      stop();
    };
    // `frame` and `onReducedMotion` are expected to be stable for the life of
    // the component; the mocks define them over refs and state setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, threshold]);
}
