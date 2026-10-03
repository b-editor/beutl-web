"use client";

import { useRef } from "react";
import { useAmbientMotion } from "./use-ambient-motion";

/** A hash rather than Math.random, so a given bar and moment always produce the
 * same level and the server-rendered frame is stable. */
function fract(i: number) {
  const n = Math.sin(i * 12.9898) * 43758.5453;
  return n - Math.floor(n);
}

/** Value noise: the hash above, eased between integer lattice points, so levels
 * drift instead of flickering from frame to frame. */
function smoothNoise(p: number) {
  const i = Math.floor(p);
  const f = p - i;
  const s = f * f * (3 - 2 * f);
  return fract(i) * (1 - s) + fract(i + 1) * s;
}

const WAVE_W = 480;
const WAVE_H = 70;
const WAVE_N = 48;
const WAVE_GAP = 3;
const WAVE_BAR_W = (WAVE_W - WAVE_GAP * (WAVE_N - 1)) / WAVE_N;
/** How many bars of signal scroll past per second. */
const WAVE_SPEED = 9;

/** `p` is a position along the signal, so scrolling is just advancing it. */
function waveLevel(p: number) {
  const envelope =
    Math.abs(Math.sin(p * 0.5)) * 0.6 + Math.abs(Math.sin(p * 0.17)) * 0.4;
  return envelope * (0.55 + 0.45 * smoothNoise(p * 0.7 + 11));
}

function waveHeight(level: number) {
  return 10 + level * 56;
}

const SPEC_W = 480;
const SPEC_H = 56;
const SPEC_N = 40;
const SPEC_GAP = 4;
const SPEC_BAR_W = (SPEC_W - SPEC_GAP * (SPEC_N - 1)) / SPEC_N;
/** Bars jump up at once but fall at this rate (fraction of full height per
 * second), the way a real analyser's ballistics read. */
const SPEC_FALL = 1.6;
const BEATS_PER_SECOND = 2;

/** A spectrum leans left: loud down at the low frequencies and trailing away
 * to almost nothing at the high end. */
function spectrumShape(i: number) {
  const t = i / (SPEC_N - 1);
  const decay = Math.pow(1 - t, 1.5);
  const rise = Math.min(1, 0.35 + t * 3);
  return decay * rise * 1.5;
}

function spectrumLevel(i: number, time: number) {
  const t = i / (SPEC_N - 1);
  // A kick on every beat, felt mostly in the low end.
  const phase = (time * BEATS_PER_SECOND) % 1;
  const kick = Math.pow(1 - phase, 3) * (1 - t) * 0.45;
  const jitter = 0.5 + 0.5 * smoothNoise(i * 0.9 + time * 5);
  return Math.min(1, spectrumShape(i) * (jitter + kick));
}

function spectrumHeight(level: number) {
  return Math.max(2, level * SPEC_H);
}

/** The hash amplifies the last bits of Math.sin, which differ between the
 * server and the browser, so the first frame is rounded before it is rendered
 * or hydration would see different attributes. */
const round2 = (value: number) => Math.round(value * 100) / 100;

const INITIAL_WAVE = Array.from({ length: WAVE_N }, (_, i) =>
  round2(waveHeight(waveLevel(i))),
);
const INITIAL_SPECTRUM = Array.from({ length: SPEC_N }, (_, i) =>
  round2(spectrumHeight(spectrumLevel(i, 0))),
);
const INITIAL_SPECTRUM_LEVELS = INITIAL_SPECTRUM.map(
  (height) => height / SPEC_H,
);

/**
 * Both visualisers are always playing. Bars are moved by writing attributes on
 * the rects directly: eighty-eight bars re-rendered through React every frame
 * would cost far more than the drawing does.
 */
export default function AudioMock() {
  const rootRef = useRef<HTMLDivElement>(null);
  const waveRefs = useRef<(SVGRectElement | null)[]>([]);
  const specRefs = useRef<(SVGRectElement | null)[]>([]);
  const specLevels = useRef([...INITIAL_SPECTRUM_LEVELS]);

  useAmbientMotion(rootRef, (time, delta) => {
    const offset = time * WAVE_SPEED;
    waveRefs.current.forEach((rect, i) => {
      if (!rect) return;
      const height = waveHeight(waveLevel(i + offset));
      rect.setAttribute("y", ((WAVE_H - height) / 2).toFixed(2));
      rect.setAttribute("height", height.toFixed(2));
    });

    specRefs.current.forEach((rect, i) => {
      if (!rect) return;
      const target = spectrumLevel(i, time);
      const level = Math.max(target, specLevels.current[i] - SPEC_FALL * delta);
      specLevels.current[i] = level;
      const height = spectrumHeight(level);
      rect.setAttribute("y", (SPEC_H - height).toFixed(2));
      rect.setAttribute("height", height.toFixed(2));
    });
  });

  return (
    <div ref={rootRef} aria-hidden="true">
      {/* One gradient per visualiser, in user space, so the ramp belongs to the
          whole group: a short bar samples only the middle of it while a tall one
          reaches the top. Filling each bar on its own restarts the ramp. */}
      <svg
        viewBox={`0 0 ${WAVE_W} ${WAVE_H}`}
        className="block h-auto w-full max-w-full"
      >
        <defs>
          <linearGradient
            id="lp-audio-wave"
            gradientUnits="userSpaceOnUse"
            x1="0"
            y1="0"
            x2="0"
            y2={WAVE_H}
          >
            <stop offset="0" style={{ stopColor: "var(--color-lp-cyan)" }} />
            <stop offset="1" style={{ stopColor: "var(--color-lp-indigo)" }} />
          </linearGradient>
        </defs>
        {INITIAL_WAVE.map((height, index) => (
          <rect
            key={`wave-${index}`}
            ref={(rect) => {
              waveRefs.current[index] = rect;
            }}
            x={index * (WAVE_BAR_W + WAVE_GAP)}
            y={round2((WAVE_H - height) / 2)}
            width={WAVE_BAR_W}
            height={height}
            rx={WAVE_BAR_W / 2}
            fill="url(#lp-audio-wave)"
          />
        ))}
      </svg>
      <svg
        viewBox={`0 0 ${SPEC_W} ${SPEC_H}`}
        className="mt-[14px] block h-auto w-full max-w-full"
      >
        <defs>
          <linearGradient
            id="lp-audio-spectrum"
            gradientUnits="userSpaceOnUse"
            x1="0"
            y1="0"
            x2="0"
            y2={SPEC_H}
          >
            <stop offset="0" style={{ stopColor: "var(--color-lp-coral)" }} />
            <stop offset="1" style={{ stopColor: "var(--color-lp-indigo)" }} />
          </linearGradient>
        </defs>
        {INITIAL_SPECTRUM.map((height, index) => (
          <rect
            key={`spectrum-${index}`}
            ref={(rect) => {
              specRefs.current[index] = rect;
            }}
            x={index * (SPEC_BAR_W + SPEC_GAP)}
            y={round2(SPEC_H - height)}
            width={SPEC_BAR_W}
            height={height}
            rx={SPEC_BAR_W / 2}
            fill="url(#lp-audio-spectrum)"
          />
        ))}
      </svg>
    </div>
  );
}
