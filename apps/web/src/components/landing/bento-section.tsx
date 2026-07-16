import type { ReactNode } from "react";
import type { Translator } from "@beutl/i18n";
import { cn } from "@beutl/core";
import AnimatedSection from "./animated-section";
import { Eyebrow, Headline, LP_SECTION, LP_WRAP } from "./lp-parts";

function SceneIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 2l9 5v10l-9 5-9-5V7z" />
      <path d="M12 22V12M3 7l9 5 9-5" />
    </svg>
  );
}

function ParticlesIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <circle cx="5" cy="6" r="2" />
      <circle cx="12" cy="12" r="2" />
      <circle cx="19" cy="7" r="2" />
      <circle cx="8" cy="18" r="2" />
      <circle cx="17" cy="17" r="2" />
    </svg>
  );
}

function ShapesIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 12h4l3-8 4 16 3-8h4" />
    </svg>
  );
}

function ColorGradingIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3a9 9 0 000 18" />
    </svg>
  );
}

function BrushIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <path d="M3 9h18" />
    </svg>
  );
}

function EasingIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M4 20V4M4 12c6 0 8-8 16-8" />
    </svg>
  );
}

function ExpressionIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M4 7V4h16v3M9 20h6M12 4v16" />
    </svg>
  );
}

function UndoIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 7v6a9 9 0 0018 0V7" />
      <path d="M3 7l9-4 9 4-9 4z" />
    </svg>
  );
}

const CELLS: {
  key: string;
  icon: ReactNode;
  badgeKey?: string;
  big?: boolean;
}[] = [
  {
    key: "bento3dScene",
    icon: <SceneIcon />,
    badgeKey: "bento3dSceneBadge",
    big: true,
  },
  { key: "bentoParticles", icon: <ParticlesIcon /> },
  { key: "bentoShapes", icon: <ShapesIcon /> },
  { key: "bentoColorGrading", icon: <ColorGradingIcon /> },
  { key: "bentoBrushes", icon: <BrushIcon /> },
  { key: "bentoEasings", icon: <EasingIcon /> },
  { key: "bentoExpressions", icon: <ExpressionIcon /> },
  { key: "bentoUndo", icon: <UndoIcon /> },
];

export default function BentoSection({ t }: { t: Translator }) {
  return (
    <section className={LP_SECTION}>
      <AnimatedSection className={LP_WRAP}>
        <div className="mb-10 text-center">
          <Eyebrow className="justify-center">{t("main:bentoEyebrow")}</Eyebrow>
          <Headline
            text={t("main:bentoHeadline")}
            className="mx-auto max-w-[24ch]"
          />
        </div>

        <div className="grid grid-cols-2 gap-4 min-[780px]:grid-cols-4 [&>*]:min-w-0">
          {CELLS.map((cell) => (
            <div
              key={cell.key}
              className={cn(
                "rounded-[14px] border border-lp-border bg-gradient-to-b from-lp-surface to-lp-bg2 p-5",
                cell.big && "col-span-2",
              )}
            >
              <div className="mb-3 grid size-[34px] place-items-center rounded-[9px] bg-lp-indigo/[0.14] text-lp-indigo-bright [&>svg]:size-[18px]">
                {cell.icon}
              </div>
              <h4 className="mb-1.5 text-[15.5px] font-extrabold">
                {t(`main:${cell.key}`)}
                {cell.badgeKey ? (
                  <em className="ml-1.5 rounded-md border border-lp-coral/40 px-1.5 py-px align-middle text-[10.5px] font-extrabold text-lp-coral not-italic">
                    {t(`main:${cell.badgeKey}`)}
                  </em>
                ) : null}
              </h4>
              <p className="text-[13px] text-lp-muted [overflow-wrap:anywhere]">
                {t(`main:${cell.key}Text`)}
              </p>
            </div>
          ))}
        </div>
      </AnimatedSection>
    </section>
  );
}
