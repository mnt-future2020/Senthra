"use client";
import React, { useRef, useState, useEffect } from 'react';
import { StatItem, ChannelItem, Transaction, RevenueData } from '@/types/dashboard';
import { TrendingUp, TrendingDown, ArrowUpRight, Search, Plus, RefreshCw, SlidersHorizontal, Trash2, Eye } from 'lucide-react';
import { REVENUE_DATA, ACTIVITY_DATA } from '@/data/dashboard';

interface OverviewTabProps {
  stats: StatItem[];
  channels: ChannelItem[];
  transactions: Transaction[];
  revRange: number;
  setRevRange: (range: number) => void;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  onSelectTransaction: (txn: Transaction) => void;
  onAddTransactionTrigger: () => void;
  onDeleteTransaction: (id: string) => void;
  onUpdateStatus: (id: string, status: Transaction['status']) => void;
}

export default function OverviewTab({
  stats,
  channels,
  transactions,
  revRange,
  setRevRange,
  searchQuery,
  setSearchQuery,
  onSelectTransaction,
  onAddTransactionTrigger,
  onDeleteTransaction,
}: OverviewTabProps) {
  
  // States for charts interactivity
  const revChartRef = useRef<HTMLDivElement>(null);
  const [revChartWidth, setRevChartWidth] = useState(600);
  const activityChartRef = useRef<HTMLDivElement>(null);
  const [activityChartWidth, setActivityChartWidth] = useState(300);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number } | null>(null);

  // States for Table filtering inside Overview Tab
  const [tableFilterStatus, setTableFilterStatus] = useState<string>('all');

  // Trigger resize observer on the chart container
  useEffect(() => {
    if (!revChartRef.current) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setRevChartWidth(entry.contentRect.width);
      }
    });
    observer.observe(revChartRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!activityChartRef.current) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setActivityChartWidth(entry.contentRect.width);
      }
    });
    observer.observe(activityChartRef.current);
    return () => observer.disconnect();
  }, []);

  // Filter transactions based on overview table criteria
  const filteredTxn = transactions.filter(t => {
    // text query matches Name, Email, ID, Method
    const matchText = 
      t.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      t.email.toLowerCase().includes(searchQuery.toLowerCase()) ||
      t.id.toLowerCase().includes(searchQuery.toLowerCase()) ||
      t.method.toLowerCase().includes(searchQuery.toLowerCase());
    
    // status filter
    const matchStatus = tableFilterStatus === 'all' || t.status === tableFilterStatus;

    return matchText && matchStatus;
  });

  // Spline Math helper
  const computeSpline = (pts: [number, number][]) => {
    if (pts.length < 2) return '';
    let d = `M ${pts[0][0]} ${pts[0][1]}`;
    for (let i = 0; i < pts.length - 1; i++) {
        const p1 = pts[i];
        const p2 = pts[i + 1];
        const cp1x = p1[0] + (p2[0] - p1[0]) / 3;
        const cp1y = p1[1];
        const cp2x = p1[0] + 2 * (p2[0] - p1[0]) / 3;
        const cp2y = p2[1];
        d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2[0]} ${p2[1]}`;
    }
    return d;
  };

  // Compute stats card sparklines paths
  const getSparklinePath = (spark: number[], w: number = 96, h: number = 38) => {
    const min = Math.min(...spark);
    const max = Math.max(...spark);
    const pad = 3;
    const pts = spark.map((v, i) => {
      const x = pad + i * (w - pad * 2) / (spark.length - 1);
      const y = h - pad - ((v - min) / (max - min || 1)) * (h - pad * 2);
      return [x, y] as [number, number];
    });
    return {
      line: computeSpline(pts),
      area: pts.length ? `${computeSpline(pts)} L ${pts[pts.length - 1][0]} ${h} L ${pts[0][0]} ${h} Z` : ''
    };
  };

  // Core Revenue Area Chart Parameters
  const revData: RevenueData = REVENUE_DATA[revRange as keyof typeof REVENUE_DATA] || REVENUE_DATA[12];
  const padL = 44;
  const padR = 12;
  const padT = 18;
  const padB = 28;
  const revChartHeight = 260;
  
  const allMax = Math.max(...revData.cur, ...revData.prev);
  const yMax = Math.ceil(allMax / 50) * 50;

  const getX = (index: number) => {
    return padL + index * (revChartWidth - padL - padR) / (revData.labels.length - 1);
  };
  const getY = (val: number) => {
    return padT + (1 - val / yMax) * (revChartHeight - padT - padB);
  };

  // Bezier data path for current revenue line
  const curPoints = revData.cur.map((v, i) => [getX(i), getY(v)] as [number, number]);
  const curPath = computeSpline(curPoints);
  
  // Bezier path for previous period
  const prevPoints = revData.prev.map((v, i) => [getX(i), getY(v)] as [number, number]);
  const prevPath = computeSpline(prevPoints);

  // Handle revenue chart hover alignment
  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = (e.clientX - rect.left) * (revChartWidth / rect.width);
    
    // Find index of nearest X coordinate
    const step = (revChartWidth - padL - padR) / (revData.labels.length - 1);
    let index = Math.round((mx - padL) / step);
    index = Math.max(0, Math.min(revData.labels.length - 1, index));

    const px = getX(index);
    const py = getY(revData.cur[index]);
    
    setHoverIndex(index);
    setHoverPos({ x: px, y: py });
  };

  const handleMouseLeave = () => {
    setHoverIndex(null);
    setHoverPos(null);
  };

  // Weekly signups statistics (BAR CHART)
  const barHeight = 240;
  const padX = 4;
  const barPadT = 12;
  const barPadB = 26;
  const activityMax = Math.max(...ACTIVITY_DATA.vals);
  const activityYMax = Math.ceil(activityMax / 100) * 100;
  const slotWidth = Math.max(0, (activityChartWidth - padX * 2) / ACTIVITY_DATA.vals.length);
  const singleBarWidth = Math.max(0, Math.min(32, slotWidth * 0.45));

  const getStatusBadgeClass = (status: Transaction['status']) => {
    switch (status) {
      case 'paid':
        return 'bg-emerald-500/10 text-[var(--pos)] border border-emerald-500/10';
      case 'pending':
        return 'bg-amber-500/10 text-[var(--warn)] border border-amber-500/10';
      case 'failed':
        return 'bg-red-500/10 text-[var(--neg)] border border-red-500/10';
      case 'refund':
        return 'bg-gray-500/10 text-[var(--muted)] border border-gray-500/10';
    }
  };

  return (
    <div className="space-y-6 tweak-transition">
      
      {/* 1. Quick Stats Blocks */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {stats.map((s) => {
          const sparkPaths = getSparklinePath(s.spark);
          const colorClass = s.up ? 'text-[var(--pos)] bg-[rgba(31,174,132,0.1)]' : 'text-[var(--neg)] bg-[rgba(239,111,94,0.1)]';
          
          return (
            <section 
              key={s.key} 
              className="card bg-[var(--surface)] border border-[var(--border)] p-5 shadow-xs tweak-transition hover:border-[var(--accent)] hover:shadow-md relative overflow-hidden group"
              style={{ borderRadius: 'var(--radius)' }}
            >
              <div className="flex items-center justify-between">
                {/* Icon wrapper */}
                <div 
                  className="w-10 h-10 flex items-center justify-center rounded-xl tweak-transition group-hover:scale-105"
                  style={{ backgroundColor: s.key === 'rev' ? 'var(--accent-12)' : `${s.tint}20`, color: s.key === 'rev' ? 'var(--accent)' : s.tint }}
                >
                  <svg className="w-5 h-5 stroke-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d={s.ico} />
                  </svg>
                </div>

                {/* Sparkling SVG vector drawing */}
                <svg className="w-24 h-10 select-none">
                  <defs>
                    <linearGradient id={`gradient-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={s.up ? 'var(--pos)' : 'var(--neg)'} stopOpacity={0.25} />
                      <stop offset="100%" stopColor={s.up ? 'var(--pos)' : 'var(--neg)'} stopOpacity={0.0} />
                    </linearGradient>
                  </defs>
                  <path 
                    d={sparkPaths.area} 
                    fill={`url(#gradient-${s.key})`} 
                  />
                  <path 
                    d={sparkPaths.line} 
                    fill="none" 
                    stroke={s.up ? 'var(--pos)' : 'var(--neg)'} 
                    strokeWidth={2} 
                    strokeLinecap="round" 
                    className="accent-glow"
                  />
                </svg>
              </div>

              {/* Textual stats */}
              <div className="mt-4">
                <span className="text-xs font-bold text-[var(--muted)]">{s.label}</span>
                <h3 className="text-2xl font-extrabold tracking-tight text-[var(--ink)] num mt-1 select-all">{s.value}</h3>
              </div>

              <div className="flex items-center gap-1.5 mt-3 pt-3 border-t border-[var(--border-2)]">
                <span className={`inline-flex items-center gap-0.5 px-2 py-0.5 text-xs font-bold rounded-full ${colorClass}`}>
                  {s.up ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                  {s.delta > 0 ? '+' : ''}{s.delta}%
                </span>
                <span className="text-[11px] text-[var(--faint)] font-medium capitalize">{s.since}</span>
              </div>
            </section>
          );
        })}
      </div>

      {/* 2. Advanced Spline Line + Channels Area */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        
        {/* Core Revenue chart */}
        <div 
          ref={revChartRef}
          className="card lg:col-span-2 bg-[var(--surface)] border border-[var(--border)] p-5 shadow-xs tweak-transition"
          style={{ borderRadius: 'var(--radius)' }}
        >
          <div className="flex flex-col sm:flex-row justify-between sm:items-center gap-4 mb-6">
            <div>
              <h3 className="text-base font-extrabold tracking-tight text-[var(--ink)]">Revenue Overview</h3>
              <p className="text-xs text-[var(--muted)] mt-0.5">Gross revenue and comparative trends</p>
            </div>

            <div className="flex items-center gap-3">
              <div className="flex items-center gap-3 text-xs font-semibold text-[var(--muted)] hidden md:flex mr-2">
                <span className="flex items-center gap-1"><i className="w-2 h-2 rounded-full bg-[var(--accent)]"></i> This period</span>
                <span className="flex items-center gap-1"><i className="w-2.5 h-0.5 border-t border-dashed border-[var(--muted)]"></i> Previous</span>
              </div>

              {/* Duration filter triggers */}
              <div className="inline-flex items-center bg-[var(--surface-2)] border border-[var(--border)] rounded-xl p-1 gap-1">
                <button 
                  onClick={() => setRevRange(3)}
                  className={`px-3 py-1 text-xs font-bold rounded-lg cursor-pointer ${revRange === 3 ? 'bg-[var(--surface)] text-[var(--ink)] shadow-xs' : 'text-[var(--muted)] hover:text-[var(--ink)]'}`}
                >
                  3M
                </button>
                <button 
                  onClick={() => setRevRange(6)}
                  className={`px-3 py-1 text-xs font-bold rounded-lg cursor-pointer ${revRange === 6 ? 'bg-[var(--surface)] text-[var(--ink)] shadow-xs' : 'text-[var(--muted)] hover:text-[var(--ink)]'}`}
                >
                  6M
                </button>
                <button 
                  onClick={() => setRevRange(12)}
                  className={`px-3 py-1 text-xs font-bold rounded-lg cursor-pointer ${revRange === 12 ? 'bg-[var(--surface)] text-[var(--ink)] shadow-xs' : 'text-[var(--muted)] hover:text-[var(--ink)]'}`}
                >
                  12M
                </button>
              </div>
            </div>
          </div>

          {/* Interactive Revenue Chart Viewport */}
          <div className="relative pt-2" style={{ height: `${revChartHeight}px` }}>
            <svg 
              className="absolute inset-0 select-none cursor-pointer" 
              width="100%" 
              height={revChartHeight}
              onMouseMove={handleMouseMove}
              onMouseLeave={handleMouseLeave}
            >
              <defs>
                <linearGradient id="revenue-accent-grad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.24} />
                  <stop offset="100%" stopColor="var(--accent)" stopOpacity={0.0} />
                </linearGradient>
              </defs>

              {/* GRID VERTICAL MEASURES */}
              {[0, 1, 2, 3, 4].map((g) => {
                const yy = padT + (g * (revChartHeight - padT - padB)) / 4;
                const valueLine = Math.round(yMax - (g * yMax) / 4);
                return (
                  <g key={`rev-grid-${g}`}>
                    <line x1={padL} y1={yy} x2={revChartWidth - padR} y2={yy} stroke="var(--border)" strokeWidth={1} strokeDasharray="3 3By" />
                    <text x={padL - 10} y={yy + 4} textAnchor="end" fontSize={10} fill="var(--faint)" fontWeight="600" className="num font-sans">
                      ${valueLine}k
                    </text>
                  </g>
                );
              })}

              {/* HORIZONTAL DATE LABELS */}
              {revData.labels.map((l, i) => (
                <text key={`lbl-${i}`} x={getX(i)} y={revChartHeight - 8} textAnchor="middle" fontSize={10} fill="var(--faint)" fontWeight="700">
                  {l}
                </text>
              ))}

              {/* Dash Path comparison */}
              <path d={prevPath} fill="none" stroke="var(--faint)" strokeWidth={2} strokeDasharray="4 4" opacity={0.65} strokeLinecap="round" />

              {/* Custom Spline Glow */}
              <path d={`${curPath} L ${getX(revData.labels.length - 1)} ${getY(0)} L ${getX(0)} ${getY(0)} Z`} fill="url(#revenue-accent-grad)" />
              <path d={curPath} fill="none" stroke="var(--accent)" strokeWidth={2.8} strokeLinecap="round" strokeLinejoin="round" />

              {/* VERTICAL RULER MOUSE FOLLOW */}
              {hoverPos && (
                <>
                  <line 
                    x1={hoverPos.x} 
                    y1={padT} 
                    x2={hoverPos.x} 
                    y2={revChartHeight - padB} 
                    stroke="var(--accent)" 
                    strokeWidth={1.5} 
                    opacity={0.35} 
                  />
                  <circle 
                    cx={hoverPos.x} 
                    cy={hoverPos.y} 
                    r={6} 
                    fill="var(--surface)" 
                    stroke="var(--accent)" 
                    strokeWidth={3} 
                    className="shadow-sm" 
                  />
                </>
              )}
            </svg>

            {/* Float dynamic HTML tooltip */}
            {hoverIndex !== null && hoverPos && (
              <div 
                className="absolute z-10 p-2 text-xs bg-gray-900 text-white dark:bg-white dark:text-gray-900 rounded-lg shadow-xl pointer-events-none tweak-transition num font-bold border border-white/10"
                style={{
                  left: `${(hoverPos.x / revChartWidth) * 100}%`,
                  top: `${hoverPos.y - 42}px`,
                  transform: 'translateX(-50%)',
                }}
              >
                <span>{revData.labels[hoverIndex]} : </span>
                <span className="text-[var(--accent)] font-extrabold">${revData.cur[hoverIndex]}k</span>
                <span className="text-gray-400 dark:text-gray-500 font-semibold text-[10px] block border-t border-gray-700 dark:border-gray-200 mt-1 pt-0.5">
                  Prev period: ${revData.prev[hoverIndex]}k
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Channels traffic sources */}
        <div 
          className="card bg-[var(--surface)] border border-[var(--border)] p-5 shadow-xs flex flex-col justify-between"
          style={{ borderRadius: 'var(--radius)' }}
        >
          <div>
            <h3 className="text-base font-extrabold tracking-tight text-[var(--ink)]">Traffic by Source</h3>
            <p className="text-xs text-[var(--muted)] mt-0.5">Lead generations this term</p>
          </div>

          <div className="space-y-4 py-4">
            {channels.map((chan) => (
              <div key={chan.name} className="space-y-1.5 group cursor-pointer">
                <div className="flex justify-between items-center text-sm">
                  <span className="font-bold text-[var(--ink)] group-hover:text-[var(--accent)] transition-colors">{chan.name}</span>
                  <span className="text-xs font-semibold text-[var(--muted)] h-5 px-2 bg-[var(--surface-2)] border border-[var(--border)] rounded flex items-center gap-1">
                    <span className="num font-bold">{chan.n}</span>
                    <span className="text-[10px] text-[var(--faint)]">({chan.v}%)</span>
                  </span>
                </div>
                <div className="w-full bg-[var(--surface-2)] h-2 rounded-full overflow-hidden border border-[var(--border-2)]">
                  <div 
                    className="h-full rounded-full transition-all duration-1000 group-hover:opacity-85"
                    style={{ 
                      width: `${chan.v}%`, 
                      backgroundColor: chan.c === 'var(--accent)' ? 'var(--accent)' : chan.c 
                    }}
                  />
                </div>
              </div>
            ))}
          </div>

          <div className="pt-3 border-t border-[var(--border)] flex justify-between items-center">
            <span className="text-xs text-[var(--faint)] font-bold">Total Referrals: 100%</span>
            <span className="text-xs text-[var(--accent)] font-extrabold flex items-center gap-1 cursor-pointer hover:opacity-80">
              Audits <ArrowUpRight className="w-3.5 h-3.5" />
            </span>
          </div>
        </div>

      </div>

      {/* 3. Daily activity bar + Recent payments */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        
        {/* Weekly activities */}
        <div 
          className="card col-span-1 bg-[var(--surface)] border border-[var(--border)] p-5 shadow-xs"
          style={{ borderRadius: 'var(--radius)' }}
        >
          <div className="mb-4">
            <h3 className="text-base font-extrabold tracking-tight text-[var(--ink)]">Weekly Activity</h3>
            <p className="text-xs text-[var(--muted)] mt-0.5">New integrations per business week</p>
          </div>

          <div ref={activityChartRef} className="relative pt-4 flex justify-center" style={{ height: `${barHeight}px` }}>
            <svg className="w-full" height={barHeight}>
              <defs>
                <linearGradient id="bar-blue-gradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--accent)" />
                  <stop offset="100%" stopColor="var(--accent)" stopOpacity={0.5} />
                </linearGradient>
              </defs>

              {ACTIVITY_DATA.vals.map((v, i) => {
                const x = padX + slotWidth * i + slotWidth / 2 - singleBarWidth / 2;
                const percentHeight = v / activityYMax;
                const fullBarH = barHeight - barPadT - barPadB;
                const actualBarH = percentHeight * fullBarH;
                const y = barHeight - barPadB - actualBarH;
                
                return (
                  <g key={`bar-${i}`} className="group/bar cursor-pointer">
                    {/* Background track indicator column */}
                    <rect 
                      x={x} 
                      y={barPadT} 
                      width={singleBarWidth} 
                      height={fullBarH} 
                      rx={6} 
                      fill="var(--surface-2)" 
                      className="transition-colors group-hover/bar:fill-[var(--border-2)]"
                    />
                    
                    {/* Actual Filled Value core */}
                    <rect 
                      x={x} 
                      y={y} 
                      width={singleBarWidth} 
                      height={actualBarH} 
                      rx={6} 
                      fill="url(#bar-blue-gradient)" 
                      className="transition-all tweak-transition accent-glow"
                    />

                    {/* Numeric Value display tooltip */}
                    <text 
                      x={x + singleBarWidth / 2} 
                      y={y - 6} 
                      textAnchor="middle" 
                      fontSize={9} 
                      fontWeight="bold" 
                      fill="var(--accent)" 
                      className="opacity-0 group-hover/bar:opacity-100 transition-opacity num"
                    >
                      {v}
                    </text>

                    {/* Day string name indicator */}
                    <text 
                      x={x + singleBarWidth / 2} 
                      y={barHeight - 8} 
                      textAnchor="middle" 
                      fontSize={10} 
                      fill="var(--faint)" 
                      fontWeight="700"
                    >
                      {ACTIVITY_DATA.labels[i]}
                    </text>
                  </g>
                );
              })}
            </svg>
          </div>
        </div>

        {/* Recent Transactions snippet block */}
        <div 
          className="card lg:col-span-2 bg-[var(--surface)] border border-[var(--border)] p-5 shadow-xs flex flex-col justify-between"
          style={{ borderRadius: 'var(--radius)' }}
        >
          {/* Header parameters */}
          <div>
            <div className="flex justify-between items-start gap-4">
              <div>
                <h3 className="text-base font-extrabold tracking-tight text-[var(--ink)]">Recent Statements</h3>
                <p className="text-xs text-[var(--muted)] mt-0.5">Audit latest payments and details</p>
              </div>

              {/* CTA generator and details */}
              <div className="flex gap-2">
                <button 
                  onClick={onAddTransactionTrigger}
                  className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-bold text-white bg-[var(--pos)] hover:opacity-90 rounded-xl transition-all cursor-pointer shadow-xs"
                >
                  <Plus className="w-3.5 h-3.5" />
                  New Entry
                </button>
              </div>
            </div>

            {/* Quick table controls filter */}
            <div className="flex flex-col sm:flex-row items-center gap-3 mt-4 pb-3 border-b border-[var(--border-2)]">
              
              {/* Status selectors */}
              <div className="flex flex-wrap gap-1.5 w-full sm:w-auto">
                {['all', 'paid', 'pending', 'failed', 'refund'].map((st) => (
                  <button 
                    key={st}
                    onClick={() => setTableFilterStatus(st)}
                    className={`px-2.5 py-1 text-[10px] font-extrabold rounded-lg uppercase tracking-wider transition-all cursor-pointer ${
                      tableFilterStatus === st 
                        ? 'bg-[var(--accent)] text-white' 
                        : 'bg-[var(--surface-2)] text-[var(--muted)] hover:text-[var(--ink)] border border-[var(--border-2)]'
                    }`}
                  >
                    {st === 'all' ? 'show all' : st}
                  </button>
                ))}
              </div>

              {/* Query search input box */}
              <div className="relative w-full sm:w-64 sm:ml-auto">
                <Search className="absolute left-2.5 top-2.5 w-3.5 h-3.5 text-[var(--faint)]" />
                <input 
                  type="text"
                  placeholder="Filter name, mail or method..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full bg-[var(--surface-2)] text-[var(--ink)] text-xs pl-8 pr-3 py-2 rounded-lg border border-[var(--border)] outline-none focus:border-[var(--accent)] transition-all"
                />
              </div>
            </div>
          </div>

          {/* List transactions */}
          <div className="overflow-x-auto my-3 min-h-[220px]">
            {filteredTxn.length === 0 ? (
              <div className="flex flex-col items-center justify-center p-8 text-center">
                <SlidersHorizontal className="w-8 h-8 text-[var(--faint)] animate-bounce mb-2" />
                <p className="text-sm font-bold text-[var(--muted)]">No transactions matching filter criteria</p>
                <button 
                  onClick={() => {
                    setTableFilterStatus('all');
                    setSearchQuery('');
                  }}
                  className="text-xs text-[var(--accent)] font-extrabold mt-1 hover:underline"
                >
                  Clear filters
                </button>
              </div>
            ) : (
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-[var(--border-2)]">
                    <th className="py-2.5 text-[10px] font-extrabold text-[var(--faint)] uppercase tracking-wider">Customer</th>
                    <th className="py-2.5 text-[10px] font-extrabold text-[var(--faint)] uppercase tracking-wider hidden md:table-cell">Date</th>
                    <th className="py-2.5 text-[10px] font-extrabold text-[var(--faint)] uppercase tracking-wider hidden sm:table-cell">Method</th>
                    <th className="py-2.5 text-[10px] font-extrabold text-[var(--faint)] uppercase tracking-wider">Status</th>
                    <th className="py-2.5 text-[10px] font-extrabold text-[var(--faint)] uppercase tracking-wider text-right">Amount</th>
                    <th className="py-2.5 text-[10px] font-extrabold text-[var(--faint)] uppercase tracking-wider text-right"></th>
                  </tr>
                </thead>
                <tbody>
                  {filteredTxn.slice(0, 5).map((t) => {
                    const initials = t.name.split(' ').map(part => part[0]).join('').substring(0, 2);
                    return (
                      <tr key={t.id} className="border-b border-[var(--border-2)] hover:bg-[var(--surface-2)] transition-colors group">
                        <td className="py-3">
                          <div className="flex items-center gap-2.5">
                            <div 
                              className="w-8 h-8 rounded-full flex items-center justify-center text-white text-[11px] font-bold"
                              style={{ backgroundColor: t.av }}
                            >
                              {initials}
                            </div>
                            <div className="leading-tight">
                              <span className="text-xs font-bold block text-[var(--ink)] group-hover:text-[var(--accent)] transition-colors">{t.name}</span>
                              <span className="text-[10px] text-[var(--faint)] font-mono">{t.email}</span>
                            </div>
                          </div>
                        </td>
                        <td className="py-3 text-xs text-[var(--muted)] hidden md:table-cell">{t.date}</td>
                        <td className="py-3 text-xs font-mono text-[var(--muted)] hidden sm:table-cell">{t.method}</td>
                        <td className="py-3">
                          <span className={`inline-flex items-center px-2 py-0.5 text-[10px] font-extrabold rounded-full ${getStatusBadgeClass(t.status)}`}>
                            <i className="w-1.5 h-1.5 rounded-full bg-current mr-1"></i>
                            <span className="capitalize">{t.status}</span>
                          </span>
                        </td>
                        <td className="py-3 text-xs font-bold text-right text-[var(--ink)] num">{t.amt}</td>
                        <td className="py-3 text-right">
                          <div className="flex justify-end gap-1.5 opacity-60 group-hover:opacity-100 transition-opacity">
                            <button 
                              onClick={() => onSelectTransaction(t)}
                              className="p-1 text-[var(--muted)] hover:text-[var(--accent)] border border-[var(--border)] rounded hover:bg-[var(--surface)] transition-all cursor-pointer"
                              title="Inspect statement"
                            >
                              <Eye className="w-3.5 h-3.5" />
                            </button>
                            <button 
                              onClick={() => onDeleteTransaction(t.id)}
                              className="p-1 text-[var(--muted)] hover:text-[var(--neg)] border border-[var(--border)] rounded hover:bg-[var(--surface)] transition-all cursor-pointer"
                              title="Delete statement"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          <div className="pt-3 border-t border-[var(--border-2)] flex justify-between items-center text-xs text-[var(--faint)]">
            <span>Showing top {Math.min(5, filteredTxn.length)} of {filteredTxn.length} operations</span>
            <span className="font-extrabold text-[var(--accent)] cursor-pointer hover:underline flex items-center gap-0.5">
              Refreshed live <RefreshCw className="w-3 h-3 animate-spin" />
            </span>
          </div>
        </div>

      </div>

    </div>
  );
}
