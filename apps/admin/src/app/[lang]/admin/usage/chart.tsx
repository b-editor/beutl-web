"use client";

import React, { useState } from "react";
import type { UsagePoint } from "@/lib/desktop-usage";

export function UsageActivityChart({
  points,
  lang,
  label,
}: {
  points: UsagePoint[];
  lang: string;
  label: string;
}) {
  const [active, setActive] = useState<number | null>(null);
  const maximum = Math.max(1, ...points.map((point) => point.count));
  const format = (time: number) =>
    new Intl.DateTimeFormat(lang, {
      timeZone: "UTC",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(time);
  const width = 900;
  const height = 180;
  const barWidth = width / Math.max(1, points.length);
  return (
    <div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={label}
        className="h-48 w-full"
        onMouseLeave={() => setActive(null)}
      >
        <title>{label}</title>
        {points.map((point, index) => {
          const barHeight = (point.count / maximum) * (height - 10);
          return (
            <g key={point.timestampMs} onMouseEnter={() => setActive(index)}>
              <rect
                x={index * barWidth}
                y={0}
                width={barWidth}
                height={height}
                fill="transparent"
              />
              <rect
                x={index * barWidth + 1}
                y={height - barHeight}
                width={Math.max(1, barWidth - 2)}
                height={barHeight}
                rx={2}
                className={
                  active === index ? "fill-primary" : "fill-primary/60"
                }
              />
              <title>
                {format(point.timestampMs)}: {point.count}
              </title>
            </g>
          );
        })}
      </svg>
      <div className="mt-2 flex min-h-5 justify-between gap-3 text-xs text-muted-foreground">
        <span>{points.length > 0 ? format(points[0].timestampMs) : ""}</span>
        <output aria-live="polite">
          {active !== null && points[active]
            ? `${format(points[active].timestampMs)}: ${points[active].count}`
            : `max: ${maximum}`}
        </output>
        <span>
          {points.length > 0
            ? format(points[points.length - 1].timestampMs)
            : ""}
        </span>
      </div>
      <details className="mt-3 text-xs">
        <summary className="cursor-pointer">
          {lang === "ja" ? "時系列データ" : "Time series data"}
        </summary>
        <div className="mt-2 max-h-48 overflow-auto">
          <table className="w-full">
            <tbody>
              {points.map((point) => (
                <tr key={point.timestampMs}>
                  <th scope="row" className="text-left font-normal">
                    {format(point.timestampMs)}
                  </th>
                  <td className="text-right tabular-nums">{point.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
