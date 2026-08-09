import type { ReactNode } from "react";
import Link from "next/link";
import type { Translator } from "@beutl/i18n";
import { cn } from "@beutl/core";
import type { LandingPackage } from "@/lib/store-utils";

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

const TIMELINE_CLIPS = [
  {
    key: "timelineClipScene",
    lane: 0,
    left: "2%",
    width: "46%",
    background:
      "linear-gradient(90deg,var(--color-lp-indigo-bright),var(--color-lp-indigo))",
  },
  {
    key: "timelineClipText",
    lane: 2,
    left: "18%",
    width: "40%",
    background: "linear-gradient(90deg,var(--color-lp-coral),#ff9d7a)",
  },
  {
    key: "timelineClipShape",
    lane: 4,
    left: "30%",
    width: "55%",
    background: "linear-gradient(90deg,var(--color-lp-cyan),#3aa9d6)",
  },
] as const;

const AUDIO_CLIP = {
  key: "timelineClipAudio",
  lane: 6,
  left: "8%",
  width: "80%",
  background: "linear-gradient(90deg,var(--color-lp-lime),#8fd23a)",
} as const;

/** Keyframe editor for the shape clip, drawn on the lane below it and aligned to
 * the clip's own time range. */
const KEYFRAME_CLIP = TIMELINE_CLIPS[2];
const KEYFRAME_LANE = KEYFRAME_CLIP.lane + 1;
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

export function TimelineMock({ t }: { t: Translator }) {
  return (
    <div>
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

        {TIMELINE_CLIPS.map((clip) => (
          <div
            key={clip.key}
            className="absolute flex items-center overflow-hidden px-2 text-[14px] font-bold whitespace-nowrap text-[#0c0a18] rounded-sm"
            style={{
              left: clip.left,
              width: clip.width,
              top: clip.lane * LANE_H + 2,
              height: LANE_H - 4,
              background: clip.background,
            }}
          >
            {t(`main:${clip.key}`)}
          </div>
        ))}

        <div
          className="absolute"
          style={{
            left: KEYFRAME_CLIP.left,
            width: KEYFRAME_CLIP.width,
            top: KEYFRAME_LANE * LANE_H,
            height: LANE_H,
          }}
        >
          <svg
            viewBox="0 0 100 30"
            preserveAspectRatio="none"
            className="absolute inset-0 h-full w-full"
            aria-hidden="true"
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

        <div
          className="absolute flex items-center overflow-hidden rounded-sm"
          style={{
            left: AUDIO_CLIP.left,
            width: AUDIO_CLIP.width,
            top: AUDIO_CLIP.lane * LANE_H + 2,
            height: LANE_H - 4,
            background: AUDIO_CLIP.background,
          }}
        >
          <span className="shrink-0 px-2 text-[14px] font-bold whitespace-nowrap text-[#0c0a18]">
            {t(`main:${AUDIO_CLIP.key}`)}
          </span>
          <div className="h-full flex-1 py-[3px] pr-1.5">
            <svg
              viewBox="0 0 100 30"
              preserveAspectRatio="none"
              className="block h-full w-full"
              aria-hidden="true"
            >
              <path d={AUDIO_WAVE_PATH} fill="rgba(0,0,0,0.55)" />
            </svg>
          </div>
        </div>
      </div>
    </div>
  );
}

const NODE_HEADER_H = 22;
const NODE_BODY_FILL = "#14121F";
const NODE_STROKE = "rgba(255,255,255,0.16)";
/** Wires and the ports they land on share one colour, as in the editor. */
const NODE_WIRE = "#3FB950";

function GraphNode({
  x,
  y,
  width,
  height,
  accent,
  title,
  param,
}: {
  x: number;
  y: number;
  width: number;
  height: number;
  accent: string;
  title: string;
  param: string;
}) {
  const headerMid = y + NODE_HEADER_H / 2;
  const paramY = y + NODE_HEADER_H + (height - NODE_HEADER_H) / 2 + 3.5;

  return (
    <g>
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        rx="6"
        fill={NODE_BODY_FILL}
      />
      <rect
        x={x}
        y={y}
        width={width}
        height={NODE_HEADER_H}
        rx="6"
        fill={accent}
      />
      <path
        d={`M${x + 8} ${headerMid + 1.25} L${x + 10.5} ${headerMid - 1.25} L${x + 13} ${headerMid + 1.25}`}
        fill="none"
        stroke="#fff"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <text
        x={x + 22}
        y={headerMid + 3.4}
        fill="#fff"
        fontSize="9.5"
        fontWeight="700"
      >
        {title}
      </text>
      <text x={x + 10} y={paramY} fill="#A8A3C6" fontSize="9">
        {param}
      </text>
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        rx="6"
        fill="none"
        stroke={NODE_STROKE}
      />
    </g>
  );
}

export function NodeGraphMock({ t }: { t: Translator }) {
  return (
    <svg
      viewBox="0 0 380 210"
      width="100%"
      className="block max-w-full [font-family:inherit]"
      aria-hidden="true"
    >
      <defs>
        <pattern
          id="node-graph-grid"
          width="19"
          height="19"
          patternUnits="userSpaceOnUse"
        >
          <path
            d="M19 0H0V19"
            fill="none"
            stroke="rgba(255,255,255,0.055)"
            strokeWidth="1"
          />
        </pattern>
      </defs>
      <rect width="380" height="210" fill="url(#node-graph-grid)" />

      <path
        d="M126 58 C 168 58, 174 103, 214 103"
        fill="none"
        stroke={NODE_WIRE}
        strokeWidth="2"
      />
      <path
        d="M126 170 C 168 170, 174 121, 214 121"
        fill="none"
        stroke={NODE_WIRE}
        strokeWidth="2"
      />
      <path d="M338 112 L 372 112" fill="none" stroke={NODE_WIRE} strokeWidth="2" />

      <GraphNode
        x={14}
        y={22}
        width={112}
        height={50}
        accent="#2EA043"
        title={t("main:nodeShape")}
        param={t("main:nodeShapeParams")}
      />
      <GraphNode
        x={14}
        y={134}
        width={112}
        height={50}
        accent="#0D9488"
        title={t("main:nodeRandom")}
        param={t("main:nodeRandomParams")}
      />
      <GraphNode
        x={214}
        y={70}
        width={124}
        height={63}
        accent="#0284C7"
        title={t("main:nodeEffect")}
        param={t("main:nodeEffectParams")}
      />

      <circle cx="126" cy="58" r="3.5" fill={NODE_WIRE} />
      <circle cx="126" cy="170" r="3.5" fill={NODE_WIRE} />
      <circle cx="214" cy="103" r="3.5" fill={NODE_WIRE} />
      <circle cx="214" cy="121" r="3.5" fill={NODE_WIRE} />
      <circle cx="338" cy="112" r="3.5" fill={NODE_WIRE} />
    </svg>
  );
}

export function ShaderCodeMock() {
  return (
    <>
      <pre className="overflow-x-auto whitespace-pre rounded-[10px] border border-lp-border bg-[#0b0916] px-4 py-[14px] font-mono text-xs leading-[1.75]">
        <code>
        <span className="text-lp-faint">{"// SKSL filter effect"}</span>
        <br />
        <span className="text-lp-indigo-bright">uniform</span>{" "}
        <span className="text-lp-indigo-bright">shader</span> src;
        <br />
        <span className="text-lp-indigo-bright">uniform</span>{" "}
        <span className="text-lp-indigo-bright">float</span> iTime;
        <br />
        <br />
        <span className="text-lp-indigo-bright">half4</span>{" "}
        <span className="text-lp-cyan">main</span>(
        <span className="text-lp-indigo-bright">float2</span> fragCoord) {"{"}
        <br />
        {"  "}
        <span className="text-lp-indigo-bright">float</span> w ={" "}
        <span className="text-lp-cyan">sin</span>(fragCoord.y *{" "}
        <span className="text-lp-coral">0.05</span> + iTime *{" "}
        <span className="text-lp-coral">2.0</span>);
        <br />
        {"  "}<span className="text-lp-indigo-bright">float2</span> uv ={" "}
        <span className="text-lp-indigo-bright">float2</span>(fragCoord.x + w *{" "}
        <span className="text-lp-coral">6.0</span>, fragCoord.y);
        <br />
        {"  "}
        <span className="text-lp-indigo-bright">return</span>{" "}
        src.<span className="text-lp-cyan">eval</span>(uv);
        <br />
        {"}"}
        </code>
      </pre>
      <div className="mt-3 h-[60px] animate-lp-slide rounded-[10px] bg-[linear-gradient(100deg,#0b0916,var(--color-lp-indigo),var(--color-lp-coral),var(--color-lp-cyan))] bg-[length:300%_100%] motion-reduce:animate-none" />
    </>
  );
}

/**
 * The mock builds these bars in the browser, but the expressions are
 * deterministic, so they are evaluated once on the server instead.
 */
const WAVE_W = 480;
const WAVE_H = 70;
const WAVE_N = 48;
const WAVE_GAP = 3;
const WAVE_BAR_W = (WAVE_W - WAVE_GAP * (WAVE_N - 1)) / WAVE_N;

const WAVE_BARS = Array.from({ length: WAVE_N }, (_, i) => {
  const level =
    Math.abs(Math.sin(i * 0.5)) * 0.6 + Math.abs(Math.sin(i * 0.17)) * 0.4;
  const height = 10 + level * 56;
  return {
    x: i * (WAVE_BAR_W + WAVE_GAP),
    y: (WAVE_H - height) / 2,
    height,
  };
});

const SPEC_W = 480;
const SPEC_H = 56;
const SPEC_N = 40;
const SPEC_GAP = 4;
const SPEC_BAR_W = (SPEC_W - SPEC_GAP * (SPEC_N - 1)) / SPEC_N;

/** A spectrum leans left: loud down at the low frequencies and trailing away
 * to almost nothing at the high end. */
const SPECTRUM_BARS = Array.from({ length: SPEC_N }, (_, i) => {
  const t = i / (SPEC_N - 1);
  const decay = Math.pow(1 - t, 1.5);
  const rise = Math.min(1, 0.35 + t * 3);
  const level = Math.min(1, decay * rise * (0.65 + 0.35 * fract(i * 3.7)) * 1.5);
  const height = Math.max(2, level * SPEC_H);
  return {
    x: i * (SPEC_BAR_W + SPEC_GAP),
    y: SPEC_H - height,
    height,
  };
});

export function AudioMock() {
  return (
    <>
      {/* One gradient per visualiser, in user space, so the ramp belongs to the
          whole group: a short bar samples only the middle of it while a tall one
          reaches the top. Filling each bar on its own restarts the ramp. */}
      <svg
        viewBox={`0 0 ${WAVE_W} ${WAVE_H}`}
        className="block h-auto w-full max-w-full"
        aria-hidden="true"
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
        {WAVE_BARS.map((bar, index) => (
          <rect
            key={`wave-${index}`}
            x={bar.x}
            y={bar.y}
            width={WAVE_BAR_W}
            height={bar.height}
            rx={WAVE_BAR_W / 2}
            fill="url(#lp-audio-wave)"
          />
        ))}
      </svg>
      <svg
        viewBox={`0 0 ${SPEC_W} ${SPEC_H}`}
        className="mt-[14px] block h-auto w-full max-w-full"
        aria-hidden="true"
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
        {SPECTRUM_BARS.map((bar, index) => (
          <rect
            key={`spectrum-${index}`}
            x={bar.x}
            y={bar.y}
            width={SPEC_BAR_W}
            height={bar.height}
            rx={SPEC_BAR_W / 2}
            fill="url(#lp-audio-spectrum)"
          />
        ))}
      </svg>
    </>
  );
}

const TEXT_MOCK_TYPE =
  "text-[clamp(52px,9vw,92px)] font-black tracking-[-0.02em] leading-none";

export function TextMock({ t }: { t: Translator }) {
  const sample = t("main:textSample");
  return (
    <div className="relative flex h-[220px] items-center justify-center">
      <span
        aria-hidden="true"
        className={cn(
          TEXT_MOCK_TYPE,
          "absolute translate-x-[10px] translate-y-[10px] text-transparent [-webkit-text-stroke:1.5px_color-mix(in_srgb,var(--color-lp-indigo-bright)_35%,transparent)]",
        )}
      >
        {sample}
      </span>
      <span
        className={cn(
          TEXT_MOCK_TYPE,
          "bg-[linear-gradient(100deg,var(--color-lp-indigo-bright),var(--color-lp-coral))] bg-clip-text text-transparent",
        )}
      >
        {sample}
      </span>
    </div>
  );
}

/**
 * Both frames show the same frame: a blob lit over a dark ground. The preview
 * samples it per cell as coarse blocks (the reduced-scale preview); the export
 * reproduces the same falloffs as gradients, which is what makes it smooth.
 *
 * Two radial gradients in objectBoundingBox units are exactly the two clamped
 * linear falloffs below: cx/cy is the centre, r is where the ramp reaches zero
 * (1 / falloff), and sRGB stop interpolation is the same lerp. Changing a
 * falloff here without changing the matching r would make the two frames show
 * different pictures, which is the one thing this pair must not do.
 */
const GPU_W = 160;
const GPU_H = 100;
const GPU_DARK = [12, 10, 24];
const GPU_INDIGO = [109, 92, 247];
const GPU_CORAL = [255, 122, 107];
const GPU_BG = { x: 0.32, y: 0.28, falloff: 1.45 };
const GPU_BLOB = { x: 0.66, y: 0.72, falloff: 2.3, peak: 0.85 };

function gpuLerp(a: number[], b: number[], t: number) {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

function gpuRgb(c: number[]) {
  return `rgb(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])})`;
}

function gpuScene(u: number, v: number) {
  const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
  const dBg = Math.hypot(u - GPU_BG.x, v - GPU_BG.y);
  let c = gpuLerp(GPU_DARK, GPU_INDIGO, clamp01(1 - dBg * GPU_BG.falloff));
  const dBlob = Math.hypot(u - GPU_BLOB.x, v - GPU_BLOB.y);
  c = gpuLerp(
    c,
    GPU_CORAL,
    clamp01(1 - dBlob * GPU_BLOB.falloff) * GPU_BLOB.peak,
  );
  return gpuRgb(c);
}

const GPU_PREVIEW_COLS = 11;
const GPU_PREVIEW_ROWS = 7;
const GPU_CELL_W = GPU_W / GPU_PREVIEW_COLS;
const GPU_CELL_H = GPU_H / GPU_PREVIEW_ROWS;
const GPU_PREVIEW_CELLS = Array.from(
  { length: GPU_PREVIEW_COLS * GPU_PREVIEW_ROWS },
  (_, i) => {
    const col = i % GPU_PREVIEW_COLS;
    const row = Math.floor(i / GPU_PREVIEW_COLS);
    return {
      x: col * GPU_CELL_W,
      y: row * GPU_CELL_H,
      fill: gpuScene(
        (col + 0.5) / GPU_PREVIEW_COLS,
        (row + 0.5) / GPU_PREVIEW_ROWS,
      ),
    };
  },
);

function GpuFrame({
  label,
  scale,
  children,
}: {
  label: string;
  scale: string;
  children: ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-[10px] border border-lp-border">
      <div className="flex justify-between border-b border-lp-border px-2.5 py-[7px] text-[11px] font-bold text-lp-muted">
        <span>{label}</span>
        <span>{scale}</span>
      </div>
      <div className="aspect-16/10">
        <svg
          viewBox={`0 0 ${GPU_W} ${GPU_H}`}
          preserveAspectRatio="none"
          className="block h-full w-full"
          aria-hidden="true"
        >
          {children}
        </svg>
      </div>
    </div>
  );
}

export function GpuMock({ t }: { t: Translator }) {
  return (
    <div className="grid grid-cols-2 gap-3 [&>*]:min-w-0">
      <GpuFrame label={t("main:gpuPreview")} scale="0.5×">
        {GPU_PREVIEW_CELLS.map((cell, i) => (
          <rect
            key={i}
            x={cell.x}
            y={cell.y}
            width={GPU_CELL_W + 0.5}
            height={GPU_CELL_H + 0.5}
            fill={cell.fill}
          />
        ))}
      </GpuFrame>
      <GpuFrame label={t("main:gpuExport")} scale="2.0×">
        <defs>
          <radialGradient
            id="lp-gpu-bg"
            cx={GPU_BG.x}
            cy={GPU_BG.y}
            r={1 / GPU_BG.falloff}
          >
            <stop offset="0" stopColor={gpuRgb(GPU_INDIGO)} />
            <stop offset="1" stopColor={gpuRgb(GPU_DARK)} />
          </radialGradient>
          <radialGradient
            id="lp-gpu-blob"
            cx={GPU_BLOB.x}
            cy={GPU_BLOB.y}
            r={1 / GPU_BLOB.falloff}
          >
            <stop
              offset="0"
              stopColor={gpuRgb(GPU_CORAL)}
              stopOpacity={GPU_BLOB.peak}
            />
            <stop offset="1" stopColor={gpuRgb(GPU_CORAL)} stopOpacity="0" />
          </radialGradient>
        </defs>
        <rect width={GPU_W} height={GPU_H} fill="url(#lp-gpu-bg)" />
        <rect width={GPU_W} height={GPU_H} fill="url(#lp-gpu-blob)" />
      </GpuFrame>
    </div>
  );
}

const EXPORT_FORMATS = [".mp4", ".mov", ".mkv", ".webm"];

export function ExportMock({ t }: { t: Translator }) {
  return (
    <>
      <div className="flex flex-wrap gap-2.5">
        {EXPORT_FORMATS.map((format) => (
          <span
            key={format}
            className="rounded-[9px] border border-lp-border2 bg-white/[0.03] px-3.5 py-[9px] font-mono text-[13px] font-bold text-lp-text"
          >
            {format}
          </span>
        ))}
      </div>
      <div className="mt-[18px] h-2 overflow-hidden rounded-full bg-white/[0.08]">
        <i className="block h-full w-[72%] rounded-full bg-[linear-gradient(90deg,var(--color-lp-indigo),var(--color-lp-coral))]" />
      </div>
      <p className="mt-2.5 text-xs text-lp-faint">{t("main:exportStatus")}</p>
    </>
  );
}

function WindowsLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M0 3.449L9.75 2.1v9.451H0m10.949-9.602L24 0v11.4H10.949M0 12.6h9.75v9.451L0 20.699M10.949 12.6H24V24l-12.9-1.801" />
    </svg>
  );
}

function AppleLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z" />
    </svg>
  );
}

function LinuxLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className={className} aria-hidden="true">
      <path d="M8.996 4.497c.104-.076.1-.168.186-.158s.022.102-.098.207c-.12.104-.308.243-.46.323-.291.152-.631.336-.993.336s-.647-.167-.853-.33c-.102-.082-.186-.162-.248-.221-.11-.086-.096-.207-.052-.204.075.01.087.109.134.153.064.06.144.137.241.214.195.154.454.304.778.304s.702-.19.932-.32c.13-.073.297-.204.433-.304M7.34 3.781c.055-.02.123-.031.174-.003.011.006.024.021.02.034-.012.038-.074.032-.11.05-.032.017-.057.052-.093.054-.034 0-.086-.012-.09-.046-.007-.044.058-.072.1-.089m.581-.003c.05-.028.119-.018.173.003.041.017.106.045.1.09-.004.033-.057.046-.09.045-.036-.002-.062-.037-.093-.053-.036-.019-.098-.013-.11-.051-.004-.013.008-.028.02-.034" />
      <path fillRule="evenodd" d="M8.446.019c2.521.003 2.38 2.66 2.364 4.093-.01.939.509 1.574 1.04 2.244.474.56 1.095 1.38 1.45 2.32.29.765.402 1.613.115 2.465a.8.8 0 0 1 .254.152l.001.002c.207.175.271.447.329.698.058.252.112.488.224.615.344.382.494.667.48.922-.015.254-.203.43-.435.57-.465.28-1.164.491-1.586 1.002-.443.527-.99.83-1.505.871a1.25 1.25 0 0 1-1.256-.716v-.001a1 1 0 0 1-.078-.21c-.67.038-1.252-.165-1.718-.128-.687.038-1.116.204-1.506.206-.151.331-.445.547-.808.63-.5.114-1.126 0-1.743-.324-.577-.306-1.31-.278-1.85-.39-.27-.057-.51-.157-.626-.384-.116-.226-.095-.538.07-.988.051-.16.012-.398-.026-.648a2.5 2.5 0 0 1-.037-.369c0-.133.022-.265.087-.386v-.002c.14-.266.368-.377.577-.451s.397-.125.53-.258c.143-.15.27-.374.443-.56q.036-.037.073-.07c-.081-.538.007-1.105.192-1.662.393-1.18 1.223-2.314 1.811-3.014.502-.713.65-1.287.701-2.016.042-.997-.705-3.974 2.112-4.2q.168-.015.321-.013m2.596 10.866-.03.016c-.223.121-.348.337-.427.656-.08.32-.107.733-.13 1.206v.001c-.023.37-.192.824-.31 1.267s-.176.862-.036 1.128v.002c.226.452.608.636 1.051.601s.947-.304 1.36-.795c.474-.576 1.218-.796 1.638-1.05.21-.126.324-.242.333-.4.009-.157-.097-.403-.425-.767-.17-.192-.217-.462-.274-.71-.056-.247-.122-.468-.26-.585l-.001-.001c-.18-.157-.356-.17-.565-.164q-.069.001-.14.005c-.239.275-.805.612-1.197.508-.359-.09-.562-.508-.587-.918m-7.204.03H3.83c-.189.002-.314.09-.44.225-.149.158-.276.382-.445.56v.002h-.002c-.183.184-.414.239-.61.31-.195.069-.353.143-.46.35v.002c-.085.155-.066.378-.029.624.038.245.096.507.018.746v.002l-.001.002c-.157.427-.155.678-.082.822.074.143.235.22.48.272.493.103 1.26.069 1.906.41.583.305 1.168.404 1.598.305.431-.098.712-.369.75-.867v-.002c.029-.292-.195-.673-.485-1.052-.29-.38-.633-.752-.795-1.09v-.002l-.61-1.11c-.21-.286-.43-.462-.68-.5a1 1 0 0 0-.106-.008M9.584 4.85c-.14.2-.386.37-.695.467-.147.048-.302.17-.495.28a1.3 1.3 0 0 1-.74.19.97.97 0 0 1-.582-.227c-.14-.113-.25-.237-.394-.322a3 3 0 0 1-.192-.126c-.063 1.179-.85 2.658-1.226 3.511a5.4 5.4 0 0 0-.43 1.917c-.68-.906-.184-2.066.081-2.568.297-.55.343-.701.27-.649-.266.436-.685 1.13-.848 1.844-.085.372-.1.749.01 1.097.11.349.345.67.766.931.573.351.963.703 1.193 1.015s.302.584.23.777a.4.4 0 0 1-.212.22.7.7 0 0 1-.307.056l.184.235c.094.124.186.249.266.375 1.179.805 2.567.496 3.568-.218.1-.342.197-.664.212-.903.024-.474.05-.896.136-1.245s.244-.634.53-.791a1 1 0 0 1 .138-.061q.005-.045.013-.087c.082-.546.569-.572 1.18-.303.588.266.81.499.71.814h.13c.122-.398-.133-.69-.822-1.025l-.137-.06a2.35 2.35 0 0 0-.012-1.113c-.188-.79-.704-1.49-1.098-1.838-.072-.003-.065.06.081.203.363.333 1.156 1.532.727 2.644a1.2 1.2 0 0 0-.342-.043c-.164-.907-.543-1.66-.735-2.014-.359-.668-.918-2.036-1.158-2.983M7.72 3.503a1 1 0 0 0-.312.053c-.268.093-.447.286-.559.391-.022.021-.05.04-.119.091s-.172.126-.321.238q-.198.151-.13.38c.046.15.192.325.459.476.166.098.28.23.41.334a1 1 0 0 0 .215.133.9.9 0 0 0 .298.066c.282.017.49-.068.673-.173s.34-.233.518-.29c.365-.115.627-.345.709-.564a.37.37 0 0 0-.01-.309c-.048-.096-.148-.187-.318-.257h-.001c-.354-.151-.507-.162-.705-.29-.321-.207-.587-.28-.807-.279m-.89-1.122h-.025a.4.4 0 0 0-.278.135.76.76 0 0 0-.191.334 1.2 1.2 0 0 0-.051.445v.001c.01.162.041.299.102.436.05.116.109.204.183.274l.089-.065.117-.09-.023-.018a.4.4 0 0 1-.11-.161.7.7 0 0 1-.054-.22v-.01a.7.7 0 0 1 .014-.234.4.4 0 0 1 .08-.179q.056-.069.126-.073h.013a.18.18 0 0 1 .123.05c.045.04.08.09.11.162a.7.7 0 0 1 .054.22v.01a.7.7 0 0 1-.002.17 1.1 1.1 0 0 1 .317-.143 1.3 1.3 0 0 0 .002-.194V3.23a1.2 1.2 0 0 0-.102-.437.8.8 0 0 0-.227-.31.4.4 0 0 0-.268-.102m1.95-.155a.63.63 0 0 0-.394.14.9.9 0 0 0-.287.376 1.2 1.2 0 0 0-.1.51v.015q0 .079.01.152c.114.027.278.074.406.138a1 1 0 0 1-.011-.172.8.8 0 0 1 .058-.278.5.5 0 0 1 .139-.2.26.26 0 0 1 .182-.069.26.26 0 0 1 .178.081c.055.054.094.12.124.21.029.086.042.17.04.27l-.002.012a.8.8 0 0 1-.057.277c-.024.059-.089.106-.122.145.046.016.09.03.146.052a5 5 0 0 1 .248.102 1.2 1.2 0 0 0 .244-.763 1.2 1.2 0 0 0-.11-.495.9.9 0 0 0-.294-.37.64.64 0 0 0-.39-.133z" />
    </svg>
  );
}

const OS = [
  { key: "platformWindows", brand: "#41AEF0", Logo: WindowsLogo },
  { key: "platformMacos", brand: "#E3E4E6", Logo: AppleLogo },
  { key: "platformLinux", brand: "#F5C93B", Logo: LinuxLogo },
] as const;

export function PlatformMock({ t }: { t: Translator }) {
  return (
    <div className="flex flex-col items-center gap-6">
      {/* A grid rather than a flex row: the three labels are different lengths
          in every locale, and equal tracks keep the three borders matching. */}
      <div className="grid grid-cols-3 gap-3 md:gap-4">
        {OS.map(({ key, brand, Logo }) => (
          <div
            key={key}
            className="flex flex-col items-center gap-3 rounded-xl border border-lp-border bg-white/[0.02] px-5 py-5"
          >
            <span style={{ color: brand }}>
              <Logo className="h-9 w-9" />
            </span>
            <span className="text-sm font-bold text-lp-muted">
              {t(`main:${key}`)}
            </span>
          </div>
        ))}
      </div>
      <div className="text-center text-[12px] leading-[1.9] text-lp-faint">
        {t("main:platformVerified")}
        <br />
        {t("main:platformVerifiedNote")}
      </div>
    </div>
  );
}

export function PackagesMock({
  t,
  lang,
  packages,
}: {
  t: Translator;
  lang: string;
  packages: LandingPackage[];
}) {
  return (
    <div className="flex flex-col gap-3">
      {packages.map((pkg) => (
        <Link
          key={pkg.id}
          href={`/${lang}/store/${pkg.name}`}
          className="flex items-center gap-[14px] rounded-xl border border-lp-border bg-lp-surface p-4 transition-colors hover:border-lp-border2"
        >
          {pkg.iconFileUrl ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              className="size-[46px] flex-none rounded-[10px] object-cover"
              alt=""
              loading="lazy"
              src={pkg.iconFileUrl}
            />
          ) : (
            <div className="size-[46px] flex-none rounded-[10px] bg-[linear-gradient(135deg,var(--color-lp-indigo),var(--color-lp-coral))]" />
          )}
          <div className="min-w-0">
            <h3 className="text-[15px] font-extrabold">
              {pkg.displayName}
              {pkg.publisherName && (
                <small className="ml-2 text-[11.5px] font-normal text-lp-faint">
                  {pkg.publisherName}
                </small>
              )}
            </h3>
            {pkg.shortDescription && (
              <p className="mt-[3px] text-[12.5px] text-lp-muted">
                {pkg.shortDescription}
              </p>
            )}
          </div>
        </Link>
      ))}

      <div className="flex items-center justify-center gap-[14px] rounded-xl border border-dashed border-lp-border bg-lp-surface p-4 text-center">
        <div className="min-w-0">
          <h3 className="text-[15px] font-extrabold text-lp-indigo-bright">
            {t("main:buildExtensions")}
          </h3>
          <p className="mt-[3px] text-[12.5px] text-lp-muted">
            {t("main:buildExtensionsDescription")}
          </p>
        </div>
      </div>
    </div>
  );
}
