import type { ReactNode } from "react";
import Link from "next/link";
import type { Translator } from "@beutl/i18n";
import { cn } from "@beutl/core";
import type { LandingPackage } from "@/lib/store-utils";
import { contentImageSources } from "@/lib/content-image";
import InteractiveExportMock from "./export-mock";
import InteractiveNodeGraphMock from "./node-graph-mock";
import InteractiveTimelineMock from "./timeline-mock";
import { PLATFORMS } from "./platform-logos";

export { default as AudioMock } from "./audio-mock";

export function TimelineMock({ t }: { t: Translator }) {
  return (
    <InteractiveTimelineMock
      clipLabels={{
        scene: t("main:timelineClipScene"),
        text: t("main:timelineClipText"),
        shape: t("main:timelineClipShape"),
        audio: t("main:timelineClipAudio"),
      }}
    />
  );
}

export function NodeGraphMock({ t }: { t: Translator }) {
  return (
    <InteractiveNodeGraphMock
      titles={{
        shape: t("main:nodeShape"),
        random: t("main:nodeRandom"),
        effect: t("main:nodeEffect"),
      }}
      params={{
        shape: t("main:nodeShapeParams"),
        random: t("main:nodeRandomParams"),
        effect: t("main:nodeEffectParams"),
      }}
    />
  );
}

export function ShaderCodeMock() {
  return (
    <>
      <pre className="overflow-x-auto whitespace-pre rounded-lg border border-lp-border bg-[#0b0916] px-4 py-[14px] font-mono text-xs leading-[1.75]">
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
      <div className="mt-3 h-[60px] animate-lp-slide rounded-lg bg-[linear-gradient(100deg,#0b0916,var(--color-lp-indigo),var(--color-lp-coral),var(--color-lp-cyan))] bg-[length:300%_100%] motion-reduce:animate-none" />
    </>
  );
}

const TEXT_MOCK_TYPE =
  "text-[clamp(52px,9vw,92px)] font-black tracking-[-0.02em] leading-none";

const TEXT_MOCK_CHAR =
  "inline-block whitespace-pre animate-lp-char motion-reduce:animate-none";

/**
 * Each character enters, holds and leaves on its own delay, so the word ripples
 * in and out. The outlined echo behind it runs the same animation a beat later.
 *
 * Every character carries the whole word's gradient, sized to the word and
 * shifted to its own slot, so the ramp stays continuous across the separately
 * transformed spans. Slots are equal-width, which is close enough for a sweep
 * between two neighbouring hues.
 */
const TEXT_CHAR_STAGGER_S = 0.07;
const TEXT_ECHO_DELAY_S = 0.12;

export function TextMock({ t }: { t: Translator }) {
  const sample = t("main:textSample");
  const chars = Array.from(sample);
  const last = Math.max(1, chars.length - 1);

  return (
    <div className="relative flex h-[220px] items-center justify-center">
      <span className="sr-only">{sample}</span>
      <span
        aria-hidden="true"
        className={cn(
          TEXT_MOCK_TYPE,
          "absolute translate-x-[10px] translate-y-[10px] text-transparent [-webkit-text-stroke:1.5px_color-mix(in_srgb,var(--color-lp-indigo-bright)_35%,transparent)]",
        )}
      >
        {chars.map((char, index) => (
          <span
            key={index}
            className={TEXT_MOCK_CHAR}
            style={{
              animationDelay: `${index * TEXT_CHAR_STAGGER_S + TEXT_ECHO_DELAY_S}s`,
            }}
          >
            {char}
          </span>
        ))}
      </span>
      <span aria-hidden="true" className={TEXT_MOCK_TYPE}>
        {chars.map((char, index) => (
          <span
            key={index}
            className={cn(
              TEXT_MOCK_CHAR,
              "bg-[linear-gradient(100deg,var(--color-lp-indigo-bright),var(--color-lp-coral))] bg-clip-text text-transparent",
            )}
            style={{
              animationDelay: `${index * TEXT_CHAR_STAGGER_S}s`,
              backgroundSize: `${chars.length * 100}% 100%`,
              backgroundPosition: `${(index / last) * 100}% 0`,
            }}
          >
            {char}
          </span>
        ))}
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
    <div className="overflow-hidden rounded-lg border border-lp-border">
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

export function ExportMock({ t }: { t: Translator }) {
  return <InteractiveExportMock statusLabel={t("main:exportStatus")} />;
}

export function PlatformMock({ t }: { t: Translator }) {
  return (
    <div className="flex flex-col items-center gap-6">
      <div className="grid w-full grid-cols-3 gap-2 sm:gap-3 md:gap-4">
        {PLATFORMS.map(({ os, nameKey, brand, Logo }) => (
          <div
            key={os}
            className="flex min-w-0 flex-col items-center gap-3 rounded-lg border border-lp-border bg-white/[0.02] px-2 py-5 sm:px-5"
          >
            <span style={{ color: brand }}>
              <Logo className="h-9 w-9" />
            </span>
            <span className="text-xs font-bold text-lp-muted sm:text-sm">
              {t(`main:${nameKey}`)}
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
          className="flex items-center gap-[14px] rounded-lg border border-lp-border bg-lp-surface p-4 transition-colors hover:border-lp-border2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {pkg.iconFileUrl ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              className="size-[46px] flex-none rounded-md object-cover"
              alt=""
              loading="lazy"
              {...contentImageSources(pkg.iconFileUrl, "icon")}
              width={46}
              height={46}
              decoding="async"
            />
          ) : (
            <div className="size-[46px] flex-none rounded-md bg-[linear-gradient(135deg,var(--color-lp-indigo),var(--color-lp-coral))]" />
          )}
          <div className="min-w-0">
            <h3 className="text-[15px] font-extrabold [overflow-wrap:anywhere]">
              {pkg.displayName}
              {pkg.publisherName && (
                <small className="ml-2 text-[11.5px] font-normal text-lp-faint">
                  {pkg.publisherName}
                </small>
              )}
            </h3>
            {pkg.shortDescription && (
              <p className="mt-[3px] text-[12.5px] text-lp-muted [overflow-wrap:anywhere]">
                {pkg.shortDescription}
              </p>
            )}
          </div>
        </Link>
      ))}

      <div className="flex items-center justify-center gap-[14px] rounded-lg border border-dashed border-lp-border bg-lp-surface p-4 text-center">
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
