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
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 18 C 8 6, 16 6, 20 18" />
      <rect x="2.5" y="16.5" width="3" height="3" />
      <rect x="18.5" y="16.5" width="3" height="3" />
      <circle cx="12" cy="9" r="1.4" fill="currentColor" stroke="none" />
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
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9.06 11.9l8.07-8.06a2.85 2.85 0 1 1 4.03 4.03l-8.06 8.08" />
      <path d="M7.07 14.94c-1.66 0-3 1.35-3 3.02 0 1.33-2.5 1.52-2 2.02 1.08 1.1 2.49 2.02 4 2.02 2.2 0 4-1.8 4-4.04a3.01 3.01 0 0 0-3-3.02z" />
    </svg>
  );
}

function EasingIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5 19 C 5 9, 19 15, 19 5" />
      <circle cx="5" cy="19" r="1.7" fill="currentColor" stroke="none" />
      <circle cx="19" cy="5" r="1.7" fill="currentColor" stroke="none" />
    </svg>
  );
}

function ExpressionIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M8 21s-4-3-4-9 4-9 4-9" />
      <path d="M16 3s4 3 4 9-4 9-4 9" />
      <path d="M15 9l-6 6M9 9l6 6" />
    </svg>
  );
}

function UndoIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H10" />
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
