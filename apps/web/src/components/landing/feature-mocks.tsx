import type { Translator } from "@beutl/i18n";
import { cn } from "@beutl/core";

const TIMELINE_RULER = ["0s", "1s", "2s", "3s", "4s"];

const TIMELINE_TRACKS = [
  {
    key: "timelineClipScene",
    left: "2%",
    width: "46%",
    background: "linear-gradient(90deg,#9A8CFF,#6D5CF7)",
  },
  {
    key: "timelineClipText",
    left: "18%",
    width: "40%",
    background: "linear-gradient(90deg,#FF7A6B,#ff9d7a)",
  },
  {
    key: "timelineClipShape",
    left: "30%",
    width: "55%",
    background: "linear-gradient(90deg,#57D6E6,#3aa9d6)",
  },
  {
    key: "timelineClipAudio",
    left: "8%",
    width: "80%",
    background: "linear-gradient(90deg,#C8F45C,#8fd23a)",
  },
] as const;

export function TimelineMock({ t }: { t: Translator }) {
  return (
    <div className="flex flex-col gap-2 text-[11px]">
      <div className="mb-1 flex h-4 border-b border-lp-border text-lp-faint">
        {TIMELINE_RULER.map((label) => (
          <span key={label} className="flex-1 border-l border-lp-border pl-1">
            {label}
          </span>
        ))}
      </div>
      {TIMELINE_TRACKS.map((track) => (
        <div
          key={track.key}
          className="relative h-[30px] rounded-[7px] bg-white/[0.03]"
        >
          <div
            className="absolute top-1 bottom-1 flex items-center overflow-hidden rounded-[5px] px-2 text-[10.5px] font-bold whitespace-nowrap text-[#0c0a18]"
            style={{
              left: track.left,
              width: track.width,
              background: track.background,
            }}
          >
            {t(`main:${track.key}`)}
          </div>
        </div>
      ))}
    </div>
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
      <path
        d="M118 47 C 165 47, 170 105, 214 105"
        fill="none"
        stroke="#57D6E6"
        strokeWidth="2"
        opacity="0.8"
      />
      <path
        d="M118 163 C 165 163, 170 123, 214 123"
        fill="none"
        stroke="#FF7A6B"
        strokeWidth="2"
        opacity="0.8"
      />
      <path
        d="M338 113 L 372 113"
        fill="none"
        stroke="#9A8CFF"
        strokeWidth="2"
        opacity="0.8"
      />
      <g>
        <rect
          x="14"
          y="24"
          width="104"
          height="46"
          rx="9"
          fill="#1B1734"
          stroke="rgba(255,255,255,0.16)"
        />
        <text x="28" y="46" fill="#57D6E6" fontSize="12" fontWeight="700">
          {t("main:nodeShape")}
        </text>
        <text x="28" y="62" fill="#A8A3C6" fontSize="10">
          {t("main:nodeShapeParams")}
        </text>
        <circle cx="118" cy="47" r="4" fill="#57D6E6" />
      </g>
      <g>
        <rect
          x="14"
          y="140"
          width="104"
          height="46"
          rx="9"
          fill="#1B1734"
          stroke="rgba(255,255,255,0.16)"
        />
        <text x="28" y="162" fill="#FF7A6B" fontSize="12" fontWeight="700">
          {t("main:nodeRandom")}
        </text>
        <text x="28" y="178" fill="#A8A3C6" fontSize="10">
          {t("main:nodeRandomParams")}
        </text>
        <circle cx="118" cy="163" r="4" fill="#FF7A6B" />
      </g>
      <g>
        <rect
          x="214"
          y="83"
          width="124"
          height="60"
          rx="9"
          fill="#1B1734"
          stroke="rgba(255,255,255,0.16)"
        />
        <text x="228" y="107" fill="#9A8CFF" fontSize="12" fontWeight="700">
          {t("main:nodeEffect")}
        </text>
        <text x="228" y="125" fill="#A8A3C6" fontSize="10">
          {t("main:nodeEffectParams")}
        </text>
        <circle cx="214" cy="105" r="4" fill="#57D6E6" />
        <circle cx="214" cy="123" r="4" fill="#FF7A6B" />
        <circle cx="338" cy="113" r="4" fill="#9A8CFF" />
      </g>
    </svg>
  );
}

export function ShaderCodeMock() {
  return (
    <>
      <div className="overflow-x-auto rounded-[10px] border border-lp-border bg-[#0b0916] px-4 py-[14px] font-mono text-xs leading-[1.75]">
        <span className="text-lp-faint">{"// GLSL filter effect"}</span>
        <br />
        <span className="text-lp-indigo-bright">half4</span>{" "}
        <span className="text-lp-cyan">main</span>(
        <span className="text-lp-indigo-bright">float2</span> uv){"{"}
        <br />
        {"  "}
        <span className="text-lp-indigo-bright">float</span> w ={" "}
        <span className="text-lp-cyan">wave</span>(uv.y *{" "}
        <span className="text-lp-coral">12.0</span> + iTime);
        <br />
        {"  "}uv.x += w * <span className="text-lp-coral">0.03</span>;
        <br />
        {"  "}
        <span className="text-lp-indigo-bright">return</span>{" "}
        <span className="text-lp-cyan">image</span>.
        <span className="text-lp-cyan">eval</span>(uv);
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
const WAVE_BARS = Array.from({ length: 64 }, (_, i) => {
  const level =
    Math.abs(Math.sin(i * 0.5)) * 0.6 + Math.abs(Math.sin(i * 0.17)) * 0.4;
  return `${12 + level * 56}%`;
});

const SPECTRUM_BARS = Array.from(
  { length: 40 },
  (_, i) => `${20 + Math.abs(Math.sin(i * 0.6)) * 80}%`,
);

export function AudioMock() {
  return (
    <>
      <div className="flex h-[70px] items-center gap-[3px]">
        {WAVE_BARS.map((height, index) => (
          <i
            key={`wave-${index}`}
            className="flex-1 rounded-[2px] bg-[linear-gradient(180deg,#57D6E6,#6D5CF7)] opacity-85"
            style={{ height }}
          />
        ))}
      </div>
      <div className="mt-[14px] flex h-14 items-end gap-1">
        {SPECTRUM_BARS.map((height, index) => (
          <i
            key={`spectrum-${index}`}
            className="flex-1 rounded-t-[3px] bg-[linear-gradient(180deg,#FF7A6B,#6D5CF7)]"
            style={{ height }}
          />
        ))}
      </div>
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

export function GpuMock({ t }: { t: Translator }) {
  return (
    <div className="grid grid-cols-2 gap-3 [&>*]:min-w-0">
      <div className="overflow-hidden rounded-[10px] border border-lp-border">
        <div className="flex justify-between border-b border-lp-border px-2.5 py-[7px] text-[11px] font-bold text-lp-muted">
          <span>{t("main:gpuPreview")}</span>
          <span>0.5×</span>
        </div>
        <div className="aspect-16/10 bg-[radial-gradient(120%_120%_at_30%_20%,#6D5CF7,#0c0a18_70%)]" />
      </div>
      <div className="overflow-hidden rounded-[10px] border border-lp-border">
        <div className="flex justify-between border-b border-lp-border px-2.5 py-[7px] text-[11px] font-bold text-lp-muted">
          <span>{t("main:gpuExport")}</span>
          <span>2.0×</span>
        </div>
        <div className="aspect-16/10 bg-[radial-gradient(120%_120%_at_30%_20%,#FF7A6B,#6D5CF7_45%,#0c0a18_78%)]" />
      </div>
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
