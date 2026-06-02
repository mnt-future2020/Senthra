"use client";
import React, { useState } from 'react';
import { Cpu, Users, BarChart3, Info, Sparkles } from 'lucide-react';

export default function AnalyticsTab() {
  const [forecastActive, setForecastActive] = useState(false);
  const [forecastVal, setForecastVal] = useState<string>('');
  
  // Custom interactive funnels data
  const funnelSteps = [
    { name: 'Website Visits', value: '48,500', percent: '100%', fill: 'var(--accent)' },
    { name: 'Trial Core Signup', value: '18,472', percent: '38%', fill: 'rgba(91,141,239,0.9)' },
    { name: 'Completed Setup', value: '11.890', percent: '24.5%', fill: 'rgba(43,179,154,0.9)' },
    { name: 'Active Billing Seats', value: '2,948', percent: '6.1%', fill: 'rgba(233,162,59,0.9)' },
  ];

  const handlePredict = () => {
    setForecastActive(true);
    setForecastVal('accumulating prediction factors...');
    setTimeout(() => {
      setForecastVal('$312,450 projected Gross Revenue for upcoming term (↑ 9.8% expansion anticipated based on Direct channels surge).');
    }, 1200);
  };

  return (
    <div className="space-y-6 tweak-transition">
      
      {/* Analytics introductory card */}
      <div 
        className="card bg-[var(--surface)] border border-[var(--border)] p-6 shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-4"
        style={{ borderRadius: 'var(--radius)' }}
      >
        <div className="space-y-1">
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 bg-[var(--accent-12)] text-[var(--accent)] font-extrabold text-[10px] rounded-full uppercase tracking-wider">
            <Cpu className="w-3 h-3" /> Predictive Modeling
          </span>
          <h2 className="text-xl font-extrabold tracking-tight text-[var(--ink)]">Performance & Funnel Analytics</h2>
          <p className="text-xs text-[var(--muted)]">Explore detailed user flow, trial acquisitions, and dynamic projections.</p>
        </div>

        <button 
          onClick={handlePredict}
          className="inline-flex items-center gap-1.5 px-4 py-2.5 bg-[var(--accent)] text-white hover:opacity-90 font-extrabold text-xs rounded-xl transition-all shadow-xs cursor-pointer"
        >
          <Sparkles className="w-4 h-4" />
          Predict Next Month
        </button>
      </div>

      {/* Forecasting prediction display banner */}
      {forecastActive && (
        <div className="p-4 bg-amber-500/10 border border-amber-500/20 text-[var(--warn)] rounded-xl text-xs font-bold flex items-center gap-3 animate-pulse">
          <Info className="w-4 h-4 flex-none" />
          <span>{forecastVal || 'Analyzing sales trajectories...'}</span>
        </div>
      )}

      {/* Grid containing Funnel Flow and Category breakups */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        
        {/* Funnel chart card */}
        <section 
          className="card bg-[var(--surface)] border border-[var(--border)] p-5 shadow-xs flex flex-col justify-between"
          style={{ borderRadius: 'var(--radius)' }}
        >
          <div>
            <h3 className="text-base font-extrabold tracking-tight text-[var(--ink)]">Acquisitions Conversion Funnel</h3>
            <p className="text-xs text-[var(--muted)] mt-0.5">Journey dropoffs from visitation to direct payments</p>
          </div>

          <div className="space-y-3.5 my-6">
            {funnelSteps.map((step, index) => {
              // Custom widths modeling funnel
              const widthMap = ['100%', '82%', '64%', '46%'];
              return (
                <div key={step.name} className="flex items-center gap-4">
                  <span className="w-24 text-[11px] font-bold text-[var(--muted)] truncate">{step.name}</span>
                  <div className="flex-1">
                    <div 
                      className="h-9 rounded-lg flex items-center justify-between px-3 text-white text-xs font-extrabold transition-all duration-1000 tweak-transition"
                      style={{ 
                        width: widthMap[index], 
                        backgroundColor: step.fill === 'var(--accent)' ? 'var(--accent)' : step.fill,
                        boxShadow: step.fill === 'var(--accent)' ? '0 4px 12px rbg(123 110 240 / 0.15)' : 'none'
                      }}
                    >
                      <span className="truncate">{step.value}</span>
                      <span className="px-1.5 py-0.5 bg-black/20 rounded font-mono text-[9px]">{step.percent}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="pt-3 border-t border-[var(--border)] text-xs text-[var(--faint)] text-center font-bold">
            Average conversion from visitors to active seats is <span className="text-[var(--pos)]">6.1%</span>
          </div>
        </section>

        {/* Categories Breakdown */}
        <section 
          className="card bg-[var(--surface)] border border-[var(--border)] p-5 shadow-xs flex flex-col justify-between"
          style={{ borderRadius: 'var(--radius)' }}
        >
          <div>
            <h3 className="text-base font-extrabold tracking-tight text-[var(--ink)]">SaaS Allocations by Segment</h3>
            <p className="text-xs text-[var(--muted)] mt-0.5">Distribution of premium server modules</p>
          </div>

          {/* Simple Vector Pie/Ring representation */}
          <div className="flex flex-col sm:flex-row items-center justify-around gap-6 my-6">
            
            {/* Custom SVG Ring diagram */}
            <div className="relative w-36 h-36">
              <svg viewBox="0 0 36 36" className="w-full h-full transform -rotate-90">
                {/* Gray placeholder bg path */}
                <circle cx="18" cy="18" r="15.915" fill="none" stroke="var(--surface-2)" strokeWidth="4" />
                
                {/* Slice 1: Hardware 45% */}
                <circle cx="18" cy="18" r="15.915" fill="none" stroke="var(--accent)" strokeWidth="4.2" strokeDasharray="45 100" strokeDashoffset="0" />
                
                {/* Slice 2: Software SaaS 35% */}
                <circle cx="18" cy="18" r="15.915" fill="none" stroke="#2bb39a" strokeWidth="4.2" strokeDasharray="35 100" strokeDashoffset="-45" />

                {/* Slice 3: Support SLA 20% */}
                <circle cx="18" cy="18" r="15.915" fill="none" stroke="#e9a23b" strokeWidth="4.2" strokeDasharray="20 100" strokeDashoffset="-80" />
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
                <span className="text-xs font-bold text-[var(--faint)] uppercase tracking-widest">Growth</span>
                <span className="text-xl font-extrabold text-[var(--ink)] num">93%</span>
              </div>
            </div>

            {/* Custom Legends list details */}
            <div className="space-y-3.5 w-full sm:w-auto">
              <div className="flex items-center gap-3 text-xs">
                <span className="w-3.5 h-3.5 rounded-full bg-[var(--accent)] flex-none" />
                <div className="leading-tight">
                  <span className="font-bold text-[var(--ink)] block">Core Routers (45%)</span>
                  <span className="text-[10px] text-[var(--faint)] font-medium">$128,040 volume</span>
                </div>
              </div>
              <div className="flex items-center gap-3 text-xs">
                <span className="w-3.5 h-3.5 rounded-full bg-[#2bb39a] flex-none" />
                <div className="leading-tight">
                  <span className="font-bold text-[var(--ink)] block">SaaS Softwares (35%)</span>
                  <span className="text-[10px] text-[var(--faint)] font-medium">$99,580 volume</span>
                </div>
              </div>
              <div className="flex items-center gap-3 text-xs">
                <span className="w-3.5 h-3.5 rounded-full bg-[#e9a23b] flex-none" />
                <div className="leading-tight">
                  <span className="font-bold text-[var(--ink)] block">Premium Support SLA (20%)</span>
                  <span className="text-[10px] text-[var(--faint)] font-medium">$56,920 volume</span>
                </div>
              </div>
            </div>

          </div>

          <div className="pt-3 border-t border-[var(--border)] text-xs text-[var(--faint)] flex justify-between items-center font-bold">
            <span>Aggregated term volume: $284,540</span>
            <span className="text-[var(--accent)] cursor-pointer hover:underline">Download JSON</span>
          </div>
        </section>

      </div>

      {/* Grid of secondary smaller widgets */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        
        {/* Audit telemetry */}
        <div className="card bg-[var(--surface)] border border-[var(--border)] p-4 flex gap-4 items-center" style={{ borderRadius: 'var(--radius)' }}>
          <div className="p-3 bg-indigo-500/10 text-indigo-500 rounded-xl">
            <Users className="w-5 h-5" />
          </div>
          <div>
            <span className="text-xs text-[var(--faint)] font-bold block uppercase tracking-wider">Weekly Signups</span>
            <span className="text-lg font-extrabold text-[var(--ink)] num">+1,248</span>
          </div>
        </div>

        {/* Server state */}
        <div className="card bg-[var(--surface)] border border-[var(--border)] p-4 flex gap-4 items-center" style={{ borderRadius: 'var(--radius)' }}>
          <div className="p-3 bg-emerald-500/10 text-emerald-500 rounded-xl">
            <Cpu className="w-5 h-5 animate-pulse" />
          </div>
          <div>
            <span className="text-xs text-[var(--faint)] font-bold block uppercase tracking-wider">Server Latency</span>
            <span className="text-lg font-extrabold text-[var(--ink)] num">14.5ms</span>
          </div>
        </div>

        {/* Conversions rate */}
        <div className="card bg-[var(--surface)] border border-[var(--border)] p-4 flex gap-4 items-center" style={{ borderRadius: 'var(--radius)' }}>
          <div className="p-3 bg-amber-500/10 text-amber-500 rounded-xl">
            <BarChart3 className="w-5 h-5" />
          </div>
          <div>
            <span className="text-xs text-[var(--faint)] font-bold block uppercase tracking-wider">Core Bounce Rate</span>
            <span className="text-lg font-extrabold text-[var(--ink)] num">22.8%</span>
          </div>
        </div>

      </div>

    </div>
  );
}
