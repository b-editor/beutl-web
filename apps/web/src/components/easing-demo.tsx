"use client";

import { useEffect, useId, useRef, useState } from "react";

/**
 * Curves are sampled from the real easing functions rather than hand-drawn, so
 * each card shows the shape it is named after: Back overshoots and settles back,
 * Bounce lands in decreasing hops, Elastic oscillates past the target.
 */
const CURVE_X0 = 4;
const CURVE_W = 117;
/** y for value 0 and value 1. Overshoot past 1 rises above CURVE_Y1. */
const CURVE_Y0 = 88;
const CURVE_Y1 = 8;

/** One pass along the curve, then a beat at the end before it repeats. */
const PLAY_SECONDS = 1.4;
const HOLD_SECONDS = 0.5;

function bounceOut(t: number) {
  const n1 = 7.5625;
  const d1 = 2.75;
  if (t < 1 / d1) return n1 * t * t;
  if (t < 2 / d1) {
    const u = t - 1.5 / d1;
    return n1 * u * u + 0.75;
  }
  if (t < 2.5 / d1) {
    const u = t - 2.25 / d1;
    return n1 * u * u + 0.9375;
  }
  const u = t - 2.625 / d1;
  return n1 * u * u + 0.984375;
}

const EASING_FUNCTIONS = {
  easeIn: (t: number) => t * t * t,
  easeInOut: (t: number) =>
    t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2,
  easeOut: (t: number) => 1 - Math.pow(1 - t, 3),
  easeElastic: (t: number) =>
    t === 0 || t === 1
      ? t
      : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) +
        1,
  easeBack: (t: number) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  },
  easeBounce: bounceOut,
};

export type EasingName = keyof typeof EASING_FUNCTIONS;

function point(fn: (t: number) => number, t: number) {
  return {
    x: CURVE_X0 + t * CURVE_W,
    y: CURVE_Y0 + fn(t) * (CURVE_Y1 - CURVE_Y0),
  };
}

function sample(fn: (t: number) => number, steps = 96) {
  const points: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const { x, y } = point(fn, i / steps);
    points.push(`${x.toFixed(1)} ${y.toFixed(1)}`);
  }
  return `M${points.join("L")}`;
}

const EASING_PATHS = Object.fromEntries(
  Object.entries(EASING_FUNCTIONS).map(([name, fn]) => [name, sample(fn)]),
) as Record<EasingName, string>;

/**
 * Hovering plays the easing: a dot runs along the curve and the curve lights up
 * behind it, looping while the pointer stays. Leaving lets the current pass
 * finish rather than cutting it off, which is also what makes a tap on a touch
 * screen (enter and leave back to back) play exactly once.
 */
export default function EasingDemo({
  easing,
  color,
  label,
}: {
  easing: EasingName;
  color: string;
  label: string;
}) {
  // useId output contains characters that are not safe inside url(#...).
  const clipId = `easing-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const [progress, setProgress] = useState<number | null>(null);
  const hoveredRef = useRef(false);
  const frameRef = useRef(0);

  useEffect(() => () => cancelAnimationFrame(frameRef.current), []);

  const play = () => {
    hoveredRef.current = true;
    if (frameRef.current) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let start: number | null = null;
    const tick = (now: number) => {
      start ??= now;
      const elapsed = (now - start) / 1000;
      if (elapsed >= PLAY_SECONDS + HOLD_SECONDS) {
        if (!hoveredRef.current) {
          frameRef.current = 0;
          setProgress(null);
          return;
        }
        start = now;
      }
      setProgress(Math.min(1, ((now - start) / 1000) / PLAY_SECONDS));
      frameRef.current = requestAnimationFrame(tick);
    };
    frameRef.current = requestAnimationFrame(tick);
  };

  const dot = progress === null ? null : point(EASING_FUNCTIONS[easing], progress);
  const path = EASING_PATHS[easing];

  return (
    <div
      className="rounded-lg border border-lp-border bg-white/[0.02] p-3 transition-colors hover:border-lp-border2"
      onPointerEnter={play}
      onPointerLeave={() => {
        hoveredRef.current = false;
      }}
    >
      <svg
        viewBox="0 -30 125 150"
        className="block h-auto w-full max-w-full"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        <defs>
          <clipPath id={clipId}>
            <rect x="-10" y="-40" width={dot ? dot.x + 10 : 0} height="170" />
          </clipPath>
        </defs>
        <path
          d={path}
          fill="none"
          style={{ stroke: color }}
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={dot ? 0.3 : 1}
        />
        {dot && (
          <>
            <path
              d={path}
              fill="none"
              style={{ stroke: color }}
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
              clipPath={`url(#${clipId})`}
            />
            <line
              x1={dot.x}
              x2={dot.x}
              y1={CURVE_Y0}
              y2={dot.y}
              stroke="rgba(255,255,255,0.25)"
              strokeDasharray="2 3"
            />
            <circle
              cx={dot.x}
              cy={dot.y}
              r="5"
              style={{ fill: color }}
              stroke="#09080f"
              strokeWidth="2"
            />
          </>
        )}
      </svg>
      <span className="text-[10.5px] font-bold tracking-[0.04em] text-lp-muted">
        {label}
      </span>
    </div>
  );
}
