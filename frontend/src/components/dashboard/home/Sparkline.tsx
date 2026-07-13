import * as React from "react";

import { getSparklinePath } from "./spline";

// Tiny theme-aware sparkline (line + faint area), no axes. A flat/empty series renders a flat
// baseline so the card never looks broken.
export function Sparkline({ data, width = 96, height = 38 }: { data: number[]; width?: number; height?: number }) {
  const id = React.useId();
  const hasShape = data.length >= 2 && Math.max(...data) !== Math.min(...data);
  const { line, area } = getSparklinePath(data, width, height);

  if (!hasShape) {
    // Flat baseline for empty/constant series.
    const y = height / 2;
    return (
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="overflow-visible" aria-hidden>
        <line x1={3} y1={y} x2={width - 3} y2={y} stroke="var(--faint)" strokeWidth={2} strokeLinecap="round" />
      </svg>
    );
  }

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="overflow-visible" aria-hidden>
      <defs>
        <linearGradient id={`spark-${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.22} />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#spark-${id})`} stroke="none" />
      <path d={line} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
