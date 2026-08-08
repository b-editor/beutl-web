import type { ReactNode } from "react";
import {
  Box,
  Braces,
  Brush,
  Contrast,
  Shapes,
  Sparkles,
  Spline,
  Undo2,
} from "lucide-react";
import type { Translator } from "@beutl/i18n";
import { cn } from "@beutl/core";
import AnimatedSection from "./animated-section";
import { Eyebrow, Headline, LP_SECTION, LP_WRAP } from "./lp-parts";

const CELLS: {
  key: string;
  icon: ReactNode;
  badgeKey?: string;
  big?: boolean;
}[] = [
  {
    key: "bento3dScene",
    icon: <Box />,
    badgeKey: "bento3dSceneBadge",
    big: true,
  },
  { key: "bentoParticles", icon: <Sparkles /> },
  { key: "bentoShapes", icon: <Shapes /> },
  { key: "bentoColorGrading", icon: <Contrast /> },
  { key: "bentoBrushes", icon: <Brush /> },
  { key: "bentoEasings", icon: <Spline /> },
  { key: "bentoExpressions", icon: <Braces /> },
  { key: "bentoUndo", icon: <Undo2 /> },
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
              <h3 className="mb-1.5 text-[15.5px] font-extrabold">
                {t(`main:${cell.key}`)}
                {cell.badgeKey ? (
                  <span className="ml-1.5 rounded-md border border-lp-coral/40 px-1.5 py-px align-middle text-[10.5px] font-extrabold text-lp-coral">
                    {t(`main:${cell.badgeKey}`)}
                  </span>
                ) : null}
              </h3>
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
