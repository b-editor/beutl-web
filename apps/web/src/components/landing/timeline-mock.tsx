"use client";

import { type PointerEvent, useRef, useState } from "react";
import { cn } from "@beutl/core";

const TIMELINE_RULER = [
  "00:00:00",
  "00:00:01",
  "00:00:02",
  "00:00:03",
  "00:00:04",
];

/** How much of the ruler survives below 440px. See TimelineMock. */
const MOBILE_RULER_TICKS = 3;

/** Track lane height. Clips sit on even lanes so the odd lane below each one is
 * free for its keyframe editor, mirroring how the editor lays a timeline out. */
const LANE_H = 30;
const LANE_COUNT = 7;

export type TimelineClipKey = "scene" | "text" | "shape" | "audio";

/** Positions and widths are percentages of the track. */
const TIMELINE_CLIPS: {
  key: TimelineClipKey;
  lane: number;
  left: number;
  width: number;
  background: string;
}[] = [
  {
    key: "scene",
    lane: 0,
    left: 2,
    width: 46,
    background:
      "linear-gradient(90deg,var(--color-lp-indigo-bright),var(--color-lp-indigo))",
  },
  {
    key: "text",
    lane: 2,
    left: 18,
    width: 40,
    background: "linear-gradient(90deg,var(--color-lp-coral),#ff9d7a)",
  },
  {
    key: "shape",
    lane: 4,
    left: 30,
    width: 55,
    background: "linear-gradient(90deg,var(--color-lp-cyan),#3aa9d6)",
  },
  {
    key: "audio",
    lane: 6,
    left: 8,
    width: 80,
    background: "linear-gradient(90deg,var(--color-lp-lime),#8fd23a)",
  },
];

const INITIAL_LEFTS = Object.fromEntries(
  TIMELINE_CLIPS.map((clip) => [clip.key, clip.left]),
) as Record<TimelineClipKey, number>;

/** Keyframe editor for the shape clip, drawn on the lane below it. It belongs to
 * the clip, so it follows the clip when the clip is dragged. */
const KEYFRAME_CLIP_KEY: TimelineClipKey = "shape";
const KEYFRAME_CURVE = "M3 24 C 20 24, 32 11, 45 11 C 62 11, 80 7, 97 7";
/** Markers sit centred on the lane rather than riding the curve. */
const KEYFRAME_XS = [3, 45, 97];

/** A hash rather than Math.random, so the paths below can be built once at
 * module load instead of per render. */
function fract(i: number) {
  const n = Math.sin(i * 12.9898) * 43758.5453;
  return n - Math.floor(n);
}

/** The waveform is one filled path mirrored about the centre line, the way an
 * audio editor draws it. Discrete bars read as a chart no matter how thin. */
const WAVE_SAMPLES = 240;
const WAVE_MID = 15;

const AUDIO_WAVE_PATH = (() => {
  const top: string[] = [];
  const bottom: string[] = [];

  for (let i = 0; i < WAVE_SAMPLES; i++) {
    const t = i / (WAVE_SAMPLES - 1);
    const envelope =
      0.32 +
      0.4 * Math.abs(Math.sin(t * Math.PI * 2.6)) +
      0.22 * Math.abs(Math.sin(t * Math.PI * 9.3 + 0.8));
    const amplitude =
      Math.min(1, Math.max(0.06, envelope * (0.45 + 0.55 * fract(i)))) *
      WAVE_MID;
    const x = (t * 100).toFixed(2);
    top.push(`${x},${(WAVE_MID - amplitude).toFixed(2)}`);
    bottom.push(`${x},${(WAVE_MID + amplitude).toFixed(2)}`);
  }

  return `M${top.join("L")}L${bottom.reverse().join("L")}Z`;
})();

const CLIP_LABEL_CLASS =
  "shrink-0 px-2 text-[14px] font-bold whitespace-nowrap text-[#0c0a18]";

type Drag = {
  key: TimelineClipKey;
  pointerId: number;
  startX: number;
  startLeft: number;
  trackWidth: number;
  maxLeft: number;
};

/**
 * Clips move horizontally only. Lanes are fixed because the odd lanes belong to
 * keyframe editors, and a clip dropped onto one would read as a bug. The track
 * keeps vertical panning (touch-action: pan-y) so a phone can still scroll the
 * page past the mock.
 */
export default function TimelineMock({
  clipLabels,
}: {
  clipLabels: Record<TimelineClipKey, string>;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const [lefts, setLefts] = useState(INITIAL_LEFTS);
  const [dragging, setDragging] = useState<TimelineClipKey | null>(null);

  const onPointerDown = (
    event: PointerEvent<HTMLDivElement>,
    key: TimelineClipKey,
    width: number,
  ) => {
    if (event.button !== 0 || !trackRef.current) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      key,
      pointerId: event.pointerId,
      startX: event.clientX,
      startLeft: lefts[key],
      trackWidth: trackRef.current.getBoundingClientRect().width,
      maxLeft: 100 - width,
    };
    setDragging(key);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const delta = ((event.clientX - drag.startX) / drag.trackWidth) * 100;
    const left = Math.min(drag.maxLeft, Math.max(0, drag.startLeft + delta));
    setLefts((current) => ({ ...current, [drag.key]: left }));
  };

  const onPointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(null);
  };

  const clipProps = (key: TimelineClipKey, lane: number, width: number) => ({
    onPointerDown: (event: PointerEvent<HTMLDivElement>) =>
      onPointerDown(event, key, width),
    onPointerMove,
    onPointerUp: onPointerEnd,
    onPointerCancel: onPointerEnd,
    className: cn(
      "absolute flex cursor-grab touch-pan-y items-center overflow-hidden rounded-sm select-none",
      "transition-shadow",
      dragging === key &&
        "z-10 cursor-grabbing shadow-[0_0_0_2px_#fff,0_6px_18px_rgba(0,0,0,0.45)]",
    ),
    style: {
      left: `${lefts[key]}%`,
      width: `${width}%`,
      top: lane * LANE_H + 2,
      height: LANE_H - 4,
    },
  });

  const keyframeClip = TIMELINE_CLIPS.find(
    (clip) => clip.key === KEYFRAME_CLIP_KEY,
  )!;

  return (
    <div aria-hidden="true">
      {/* A timestamp has no break opportunity, so five seconds of ruler do not
          fit a phone-width panel at a legible size. Below 440px the ruler shows
          three seconds instead, which gives each one half again as much width.
          min-w-0 keeps any remaining overflow inside its own cell rather than
          pushing the row wide enough for the panel to clip the last label. */}
      <div className="flex h-5 text-[12px] tabular-nums text-lp-faint">
        {TIMELINE_RULER.map((label, index) => (
          <span
            key={label}
            className={cn(
              "min-w-0 flex-1 overflow-hidden border-l border-lp-border pl-1.5",
              index >= MOBILE_RULER_TICKS && "hidden min-[440px]:block",
            )}
          >
            {label}
          </span>
        ))}
      </div>

      <div
        ref={trackRef}
        className="relative border-t border-lp-border"
        style={{ height: LANE_COUNT * LANE_H }}
      >
        {Array.from({ length: LANE_COUNT }, (_, lane) => (
          <div
            key={lane}
            className="absolute right-0 left-0 border-b border-white/[0.07]"
            style={{ top: lane * LANE_H, height: LANE_H }}
          />
        ))}

        <div
          className="pointer-events-none absolute"
          style={{
            left: `${lefts[KEYFRAME_CLIP_KEY]}%`,
            width: `${keyframeClip.width}%`,
            top: (keyframeClip.lane + 1) * LANE_H,
            height: LANE_H,
          }}
        >
          <svg
            viewBox="0 0 100 30"
            preserveAspectRatio="none"
            className="absolute inset-0 h-full w-full"
          >
            <path
              d={KEYFRAME_CURVE}
              fill="none"
              stroke="#E8E6F5"
              strokeWidth="1.5"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          {KEYFRAME_XS.map((x) => (
            <span
              key={x}
              className="absolute h-[9px] w-[9px] rotate-45 bg-[#F5D14E]"
              style={{
                left: `${x}%`,
                top: LANE_H / 2,
                marginLeft: -4.5,
                marginTop: -4.5,
              }}
            />
          ))}
        </div>

        {TIMELINE_CLIPS.map((clip) => {
          const props = clipProps(clip.key, clip.lane, clip.width);
          return (
            <div
              key={clip.key}
              {...props}
              style={{ ...props.style, background: clip.background }}
            >
              <span className={CLIP_LABEL_CLASS}>{clipLabels[clip.key]}</span>
              {clip.key === "audio" && (
                <div className="h-full flex-1 py-[3px] pr-1.5">
                  <svg
                    viewBox="0 0 100 30"
                    preserveAspectRatio="none"
                    className="block h-full w-full"
                  >
                    <path d={AUDIO_WAVE_PATH} fill="rgba(0,0,0,0.55)" />
                  </svg>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
