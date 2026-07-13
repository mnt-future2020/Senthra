"use client";

import * as React from "react";

import { formatMoney } from "@/components/dashboard/purchase-orders/poStatus";
import type { SpendPoint, SpendPeriod } from "@/services/dashboard.service";
import { computeSpline } from "./spline";

// Issued-spend area chart with a period selector (12 months / 90 days / 30 days — bucketed
// monthly / weekly / daily by the server). Hand-rolled theme-aware SVG with Y-axis value labels,
// a hover crosshair + tooltip, width driven by a ResizeObserver. Read-only.

const PERIODS: Array<{ key: SpendPeriod; label: string }> = [
  { key: "12m", label: "12m" },
  { key: "90d", label: "90d" },
  { key: "30d", label: "30d" },
];

// Compact £ for axis labels — "£1.7k" / "£2.3m" reads at a glance where full values wouldn't fit.
function compactMoney(pence: number): string {
  const pounds = pence / 100;
  if (pounds >= 1_000_000) return `£${(pounds / 1_000_000).toFixed(1)}m`;
  if (pounds >= 1_000) return `£${(pounds / 1_000).toFixed(1)}k`;
  return `£${Math.round(pounds)}`;
}

// Bucket-key label: "YYYY-MM" → "Aug"; "YYYY-MM-DD" (week/day buckets) → "4 Jul".
function periodLabel(key: string): string {
  if (key.length === 7) {
    const [yy, mm] = key.split("-").map(Number);
    return new Date(Date.UTC(yy, (mm ?? 1) - 1, 1)).toLocaleDateString("en-GB", { month: "short" });
  }
  const d = new Date(`${key}T00:00:00Z`);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

export function SpendTrendChart({
  data,
  period,
  onPeriodChange,
  loading,
}: {
  data: SpendPoint[];
  period: SpendPeriod;
  onPeriodChange: (p: SpendPeriod) => void;
  loading?: boolean;
}) {
  const wrapRef = React.useRef<HTMLDivElement>(null);
  const [width, setWidth] = React.useState(640);
  const [hover, setHover] = React.useState<number | null>(null);
  const height = 220;
  const padL = 46; // room for the Y-axis value labels
  const padR = 12;
  const padT = 16;
  const padB = 28;

  React.useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const obs = new ResizeObserver((entries) => {
      for (const e of entries) setWidth(Math.max(320, e.contentRect.width));
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // Reset the crosshair when the series changes shape (period switch). Adjusting state during
  // render (not via an effect) is the React-recommended pattern and avoids a cascading re-render.
  const seriesKey = `${period}:${data.length}`;
  const [prevSeriesKey, setPrevSeriesKey] = React.useState(seriesKey);
  if (prevSeriesKey !== seriesKey) {
    setPrevSeriesKey(seriesKey);
    setHover(null);
  }

  const values = data.map((d) => d.totalPence);
  const maxV = Math.max(1, ...values);
  const innerW = width - padL - padR;
  const innerH = height - padT - padB;
  const x = (i: number) => padL + (data.length <= 1 ? innerW / 2 : (i * innerW) / (data.length - 1));
  const y = (v: number) => padT + innerH - (v / maxV) * innerH;

  const pts = data.map((d, i) => [x(i), y(d.totalPence)] as [number, number]);
  const line = computeSpline(pts);
  const area = pts.length ? `${line} L ${pts[pts.length - 1][0]} ${padT + innerH} L ${pts[0][0]} ${padT + innerH} Z` : "";

  // X labels thin out as buckets multiply (12 → every 2nd, 13 → every 2nd, 30 → every 5th).
  const labelEvery = data.length > 20 ? 5 : 2;

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (data.length === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * width;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < data.length; i++) {
      const d = Math.abs(px - x(i));
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    setHover(best);
  };

  const totalPence = values.reduce((a, b) => a + b, 0);
  const periodDesc = period === "12m" ? "last 12 months" : period === "90d" ? "last 90 days" : "last 30 days";

  return (
    <div
      ref={wrapRef}
      className="bg-[var(--surface)] border border-[var(--border)] p-5 shadow-xs"
      style={{ borderRadius: "var(--radius)" }}
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <h3 className="text-sm font-bold text-[var(--ink)]">Spend Trend</h3>
          <span className="text-xs text-[var(--muted)]">
            {formatMoney(totalPence / 100)} issued · {periodDesc}
          </span>
        </div>
        <div className="inline-flex items-center rounded-full border border-[var(--border)] bg-[var(--surface-2)] p-0.5" role="tablist" aria-label="Spend period">
          {PERIODS.map((p) => (
            <button
              key={p.key}
              type="button"
              role="tab"
              aria-selected={period === p.key}
              onClick={() => onPeriodChange(p.key)}
              className={`rounded-full px-2.5 py-1 text-[11px] font-bold transition-all ${
                period === p.key ? "bg-[var(--accent)] text-white" : "text-[var(--muted)] hover:text-[var(--ink)]"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
      <div className={`relative transition-opacity ${loading ? "opacity-60" : ""}`}>
        <svg
          width="100%"
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          onMouseMove={onMove}
          onMouseLeave={() => setHover(null)}
          className="block"
          role="img"
          aria-label={`Issued purchase-order spend, ${periodDesc}: ${formatMoney(totalPence / 100)} total`}
        >
          <defs>
            <linearGradient id="spend-grad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.24} />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity={0} />
            </linearGradient>
          </defs>
          {[0, 0.25, 0.5, 0.75, 1].map((f) => (
            <React.Fragment key={f}>
              <line
                x1={padL}
                y1={padT + innerH - f * innerH}
                x2={width - padR}
                y2={padT + innerH - f * innerH}
                stroke="var(--border)"
                strokeWidth={1}
                strokeDasharray={f === 0 ? undefined : "3 3"}
              />
              <text
                x={padL - 6}
                y={padT + innerH - f * innerH + 3}
                textAnchor="end"
                className="fill-[var(--faint)]"
                style={{ fontSize: 9 }}
              >
                {compactMoney(f * maxV)}
              </text>
            </React.Fragment>
          ))}
          {area ? <path d={area} fill="url(#spend-grad)" stroke="none" /> : null}
          {line ? (
            <path d={line} fill="none" stroke="var(--accent)" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" />
          ) : null}
          {hover != null && data[hover] ? (
            <>
              <line x1={x(hover)} y1={padT} x2={x(hover)} y2={padT + innerH} stroke="var(--accent)" strokeWidth={1} strokeDasharray="3 3" />
              <circle cx={x(hover)} cy={y(data[hover].totalPence)} r={4} fill="var(--accent)" stroke="var(--surface)" strokeWidth={2} />
            </>
          ) : null}
          {data.map((d, i) => (
            <text key={d.period} x={x(i)} y={height - 8} textAnchor="middle" className="fill-[var(--faint)]" style={{ fontSize: 10 }}>
              {i % labelEvery === 0 ? periodLabel(d.period) : ""}
            </text>
          ))}
        </svg>
        {hover != null && data[hover] ? (
          <div
            className="pointer-events-none absolute -translate-x-1/2 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs shadow-md"
            style={{ left: `${(x(hover) / width) * 100}%`, top: 4 }}
          >
            <div className="font-semibold text-[var(--ink)]">{formatMoney(data[hover].totalPence / 100)}</div>
            <div className="text-[var(--muted)]">{periodLabel(data[hover].period)}</div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
