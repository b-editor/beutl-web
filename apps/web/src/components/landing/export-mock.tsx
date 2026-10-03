"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@beutl/core";
import { useAmbientMotion } from "./use-ambient-motion";

const EXPORT_FORMATS = [".mp4", ".mov", ".mkv", ".webm"];

const EXPORT_SECONDS = 4.5;
/** The export starts once this much of the card is on screen, so the reader
 * sees it from the beginning rather than catching the tail end. */
const START_THRESHOLD = 0.6;

/**
 * Plays one export from 0% to 100% the first time the card comes into view,
 * then stays finished. The bar's width is written straight to the element
 * every frame; React only re-renders when the whole-number percentage changes.
 */
export default function ExportMock({ statusLabel }: { statusLabel: string }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLElement>(null);
  const [percent, setPercent] = useState(0);

  // Without motion the export is shown already finished rather than stuck at 0%.
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setPercent(100);
      if (barRef.current) barRef.current.style.width = "100%";
    }
  }, []);

  useAmbientMotion(
    rootRef,
    (time) => {
      const progress = Math.min(1, time / EXPORT_SECONDS);
      if (barRef.current) {
        barRef.current.style.width = `${(progress * 100).toFixed(2)}%`;
      }
      setPercent(Math.floor(progress * 100));
      return progress < 1;
    },
    START_THRESHOLD,
  );

  return (
    <div ref={rootRef}>
      <div className="flex flex-wrap gap-2.5" aria-hidden="true">
        {EXPORT_FORMATS.map((name, index) => (
          <span
            key={name}
            className={cn(
              "rounded-md border border-lp-border2 bg-white/[0.03] px-3.5 py-[9px] font-mono text-[13px] font-bold text-lp-text",
              index === 0 && "border-lp-indigo-bright/60 bg-lp-indigo/[0.18]",
            )}
          >
            {name}
          </span>
        ))}
      </div>
      <div className="mt-[18px] h-2 overflow-hidden rounded-full bg-white/[0.08]">
        <i
          ref={barRef}
          className="block h-full rounded-full bg-[linear-gradient(90deg,var(--color-lp-indigo),var(--color-lp-coral))]"
          style={{ width: "0%" }}
        />
      </div>
      <p className="mt-2.5 text-xs text-lp-faint tabular-nums">
        {statusLabel} {percent}%
      </p>
    </div>
  );
}
