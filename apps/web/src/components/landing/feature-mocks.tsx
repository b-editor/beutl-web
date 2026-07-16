import type { ReactNode } from "react";
import type { Translator } from "@beutl/i18n";
import { cn } from "@beutl/core";

const TIMELINE_RULER = [
  "00:00:00",
  "00:00:01",
  "00:00:02",
  "00:00:03",
  "00:00:04",
];

/** Track lane height. Clips sit on odd lanes so the lane below each one is free
 * for its keyframe editor, mirroring how the editor lays a timeline out. */
const LANE_H = 30;
const LANE_COUNT = 7;

const TIMELINE_CLIPS = [
  {
    key: "timelineClipScene",
    lane: 0,
    left: "2%",
    width: "46%",
    background: "linear-gradient(90deg,#9A8CFF,#6D5CF7)",
  },
  {
    key: "timelineClipText",
    lane: 2,
    left: "18%",
    width: "40%",
    background: "linear-gradient(90deg,#FF7A6B,#ff9d7a)",
  },
  {
    key: "timelineClipShape",
    lane: 4,
    left: "30%",
    width: "55%",
    background: "linear-gradient(90deg,#57D6E6,#3aa9d6)",
  },
] as const;

const AUDIO_CLIP = {
  key: "timelineClipAudio",
  lane: 6,
  left: "8%",
  width: "80%",
  background: "linear-gradient(90deg,#C8F45C,#8fd23a)",
} as const;

/** Keyframe editor for the shape clip, drawn on the lane below it and aligned to
 * the clip's own time range. */
const KEYFRAME_LANE = 5;
const KEYFRAME_CURVE = "M3 24 C 20 24, 32 11, 45 11 C 62 11, 80 7, 97 7";
/** Markers sit centred on the lane rather than riding the curve. */
const KEYFRAME_XS = [3, 45, 97];

/** Deterministic, so the markup the server renders matches the client's. */
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
      <div className="flex h-5 text-[12px] tabular-nums text-lp-faint">
        {TIMELINE_RULER.map((label) => (
          <span key={label} className="flex-1 border-l border-lp-border pl-1.5">
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
            className="absolute flex items-center overflow-hidden px-2 text-[14px] font-bold whitespace-nowrap text-[#0c0a18]"
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
            left: "30%",
            width: "55%",
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
          className="absolute flex items-center overflow-hidden"
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
        rx="4"
        fill={NODE_BODY_FILL}
      />
      <rect
        x={x}
        y={y}
        width={width}
        height={NODE_HEADER_H}
        rx="4"
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
        rx="4"
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
      <div className="overflow-x-auto rounded-[10px] border border-lp-border bg-[#0b0916] px-4 py-[14px] font-mono text-xs leading-[1.75]">
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
      </div>
      <div className="mt-3 h-[60px] animate-lp-slide rounded-[10px] bg-[linear-gradient(100deg,#0b0916,#6D5CF7,#FF7A6B,#57D6E6)] bg-[length:300%_100%] motion-reduce:animate-none" />
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
            <stop offset="0" stopColor="#57D6E6" />
            <stop offset="1" stopColor="#6D5CF7" />
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
            <stop offset="0" stopColor="#FF7A6B" />
            <stop offset="1" stopColor="#6D5CF7" />
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
          "absolute translate-x-[10px] translate-y-[10px] text-transparent [-webkit-text-stroke:1.5px_rgba(154,140,255,0.35)]",
        )}
      >
        {sample}
      </span>
      <span
        className={cn(
          TEXT_MOCK_TYPE,
          "bg-[linear-gradient(100deg,#9A8CFF,#FF7A6B)] bg-clip-text text-transparent",
        )}
      >
        {sample}
      </span>
    </div>
  );
}

/**
 * Both frames show the same frame: a blob lit over a dark ground, sampled from
 * one scene function. The preview draws it as coarse blocks (the reduced-scale
 * preview) while the export renders the same composition smoothly.
 */
const GPU_W = 160;
const GPU_H = 100;
const GPU_DARK = [12, 10, 24];
const GPU_INDIGO = [109, 92, 247];
const GPU_CORAL = [255, 122, 107];

function gpuLerp(a: number[], b: number[], t: number) {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

function gpuScene(u: number, v: number) {
  const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
  const dBg = Math.hypot(u - 0.32, v - 0.28);
  let c = gpuLerp(GPU_DARK, GPU_INDIGO, clamp01(1 - dBg * 1.45));
  const dBlob = Math.hypot(u - 0.66, v - 0.72);
  c = gpuLerp(c, GPU_CORAL, clamp01(1 - dBlob * 2.3) * 0.85);
  return `rgb(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])})`;
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
          <radialGradient id="lp-gpu-bg" cx="0.32" cy="0.28" r="0.95">
            <stop offset="0" stopColor="#6D5CF7" />
            <stop offset="1" stopColor="#0c0a18" />
          </radialGradient>
          <radialGradient id="lp-gpu-blob" cx="0.66" cy="0.72" r="0.5">
            <stop offset="0" stopColor="#FF7A6B" />
            <stop offset="1" stopColor="#FF7A6B" stopOpacity="0" />
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
        <i className="block h-full w-[72%] rounded-full bg-[linear-gradient(90deg,#6D5CF7,#FF7A6B)]" />
      </div>
      <p className="mt-2.5 text-xs text-lp-faint">{t("main:exportStatus")}</p>
    </>
  );
}

export function PlatformMock({ t }: { t: Translator }) {
  return (
    <div className="text-center text-[13px] leading-[2] text-lp-faint">
      <div className="text-[44px]">💻</div>
      {t("main:platformVerified")}
      <br />
      {t("main:platformVerifiedNote")}
    </div>
  );
}

export function PackagesMock({ t }: { t: Translator }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-[14px] rounded-xl border border-lp-border bg-lp-surface p-4">
        <div className="size-[46px] flex-none rounded-[10px] bg-[linear-gradient(135deg,#6D5CF7,#FF7A6B)]" />
        <div className="min-w-0">
          <h4 className="text-[15px] font-extrabold">
            {t("main:ffmpegLocator")}{" "}
            <small className="text-[11.5px] text-lp-faint">
              {t("main:officialPackage")}
            </small>
          </h4>
          <p className="mt-[3px] text-[12.5px] text-lp-muted">
            {t("main:ffmpegLocatorDescription")}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-[14px] rounded-xl border border-lp-border bg-lp-surface p-4">
        <div className="size-[46px] flex-none rounded-[10px] bg-[linear-gradient(135deg,#fff,#090C1D)]" />
        <div className="min-w-0">
          <h4 className="text-[15px] font-extrabold">
            {t("main:sugarShaker")}{" "}
            <small className="text-[11.5px] text-lp-faint">
              {t("main:officialPackage")}
            </small>
          </h4>
          <p className="mt-[3px] text-[12.5px] text-lp-muted">
            {t("main:sugarShakerDescription")}
          </p>
        </div>
      </div>

      <div className="flex items-center justify-center gap-[14px] rounded-xl border border-dashed border-lp-border bg-lp-surface p-4 text-center">
        <div className="min-w-0">
          <h4 className="text-[15px] font-extrabold text-lp-indigo-bright">
            {t("main:buildExtensions")}
          </h4>
          <p className="mt-[3px] text-[12.5px] text-lp-muted">
            {t("main:buildExtensionsDescription")}
          </p>
        </div>
      </div>
    </div>
  );
}
