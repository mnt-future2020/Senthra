// Hand-rolled monotone-ish spline path helpers, ported from reference/tabs/OverviewTab.tsx.
// Pure geometry — no React, no theme. Used by the sparkline and the spend-trend area chart.

/** Smooth cubic-bezier path through the given points. */
export function computeSpline(pts: [number, number][]): string {
  if (pts.length < 2) return "";
  let d = `M ${pts[0][0]} ${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const cp1x = p1[0] + (p2[0] - p1[0]) / 3;
    const cp1y = p1[1];
    const cp2x = p1[0] + (2 * (p2[0] - p1[0])) / 3;
    const cp2y = p2[1];
    d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2[0]} ${p2[1]}`;
  }
  return d;
}

/** Sparkline line + filled-area paths for a small series. */
export function getSparklinePath(spark: number[], w = 96, h = 38): { line: string; area: string } {
  if (spark.length < 2) return { line: "", area: "" };
  const min = Math.min(...spark);
  const max = Math.max(...spark);
  const pad = 3;
  const pts = spark.map((v, i) => {
    const x = pad + (i * (w - pad * 2)) / (spark.length - 1);
    const y = h - pad - ((v - min) / (max - min || 1)) * (h - pad * 2);
    return [x, y] as [number, number];
  });
  return {
    line: computeSpline(pts),
    area: pts.length ? `${computeSpline(pts)} L ${pts[pts.length - 1][0]} ${h} L ${pts[0][0]} ${h} Z` : "",
  };
}
