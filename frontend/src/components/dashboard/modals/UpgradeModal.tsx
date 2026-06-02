"use client";
import React, { useState } from 'react';
import { X, Check, Award, Flame, ShieldCheck, Heart } from 'lucide-react';

interface UpgradeModalProps {
  onClose: () => void;
  onUpgradeSuccess: (tier: string) => void;
}

export default function UpgradeModal({ onClose, onUpgradeSuccess }: UpgradeModalProps) {
  const [isAnnual, setIsAnnual] = useState(false);

  const handleSelectTier = (tier: string) => {
    onUpgradeSuccess(tier);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs tweak-transition anim-fade-in" id="upgrade-modal">
      <div 
        className="relative w-full max-w-3xl bg-[var(--surface)] border border-[var(--border)] text-[var(--ink)] shadow-2xl p-6 md:p-8 tweak-transition overflow-y-auto max-h-[90vh]"
        style={{ borderRadius: 'var(--radius)' }}
      >
        {/* Close Button */}
        <button 
          onClick={onClose}
          className="absolute right-4 top-4 p-1.5 rounded-lg border border-[var(--border)] hover:bg-[var(--surface-2)] text-[var(--muted)] hover:text-[var(--ink)] transition-colors"
        >
          <X className="w-5 h-5" />
        </button>

        {/* Hero title */}
        <div className="text-center max-w-md mx-auto mb-8">
          <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-[var(--accent-12)] text-[var(--accent)] font-extrabold text-[11px] rounded-full uppercase tracking-wider mb-3">
            <Award className="w-3.5 h-3.5" /> Premium Ecosystem
          </span>
          <h2 className="text-3xl font-extrabold tracking-tight">Upgrade Your Operations</h2>
          <p className="text-sm text-[var(--muted)] mt-1.5">
            Unlock advanced financial forecasts, custom automated filters, team allocations, and dedicated server configurations.
          </p>
        </div>

        {/* Toggle Billing */}
        <div className="flex items-center justify-center gap-3 mb-8">
          <span className={`text-xs font-semibold ${!isAnnual ? 'text-[var(--ink)]' : 'text-[var(--muted)]'}`}>Monthly</span>
          <div 
            onClick={() => setIsAnnual(!isAnnual)}
            className="w-12 h-6 bg-[var(--surface-2)] border border-[var(--border)] rounded-full flex items-center p-0.5 cursor-pointer"
          >
            <div className={`w-5 h-5 bg-[var(--accent)] rounded-full shadow-md transform transition-transform duration-300 ${isAnnual ? 'translate-x-6' : ''}`}></div>
          </div>
          <span className={`text-xs font-semibold flex items-center gap-1.5 ${isAnnual ? 'text-[var(--ink)]' : 'text-[var(--muted)]'}`}>
            Annually 
            <span className="px-1.5 py-0.5 text-[9px] font-extrabold text-emerald-600 bg-emerald-50 border border-emerald-200 dark:bg-emerald-900/30 dark:border-emerald-800 rounded-md">SAVE 20%</span>
          </span>
        </div>

        {/* Pricing Matrix GRID */}
        <div className="grid md:grid-cols-3 gap-6">
          
          {/* Item 1: Starter */}
          <div className="border border-[var(--border)] bg-[var(--surface-2)] p-5 rounded-2xl flex flex-col justify-between">
            <div>
              <span className="text-xs font-bold text-[var(--faint)] block uppercase tracking-wider">Default</span>
              <h4 className="text-lg font-bold mt-1">Free Tier</h4>
              <p className="text-xs text-[var(--muted)] mt-1">Standard metrics & local session tracking.</p>
              
              <div className="mt-4 mb-5">
                <span className="text-2xl font-extrabold">$0</span>
                <span className="text-xs text-[var(--faint)]"> / mo</span>
              </div>

              <ul className="space-y-2.5 text-xs text-[var(--muted)] border-t border-[var(--border)] pt-4">
                <li className="flex items-center gap-2">
                  <Check className="w-3.5 h-3.5 text-emerald-500" />
                  <span>Up to 6 transactions/month</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check className="w-3.5 h-3.5 text-emerald-500" />
                  <span>Interactive charts</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check className="w-3.5 h-3.5 text-emerald-500" />
                  <span>Compact Layout Toggle</span>
                </li>
              </ul>
            </div>
            
            <button 
              disabled 
              className="w-full mt-6 py-2.5 text-xs font-semibold border border-[var(--border)] rounded-xl bg-[var(--surface)] text-[var(--muted)] cursor-not-allowed"
            >
              Current Active
            </button>
          </div>

          {/* Item 2: Business Pro */}
          <div className="border-2 border-[var(--accent)] bg-[var(--surface)] p-5 rounded-2xl flex flex-col justify-between relative accent-glow">
            <span className="absolute -top-3 left-1/2 -translate-x-1/2 px-2.5 py-0.5 bg-[var(--accent)] text-white text-[9px] font-extrabold rounded-full flex items-center gap-1">
              <Flame className="w-3 h-3 fill-white" /> POPULAR PRESET
            </span>
            <div>
              <span className="text-xs font-bold text-[var(--accent)] block uppercase tracking-wider">Growth Tier</span>
              <h4 className="text-lg font-bold mt-1">Senthra Business Pro</h4>
              <p className="text-xs text-[var(--muted)] mt-1">Premium visual themes, infinite tables and logs.</p>
              
              <div className="mt-4 mb-5">
                <span className="text-3xl font-extrabold num">${isAnnual ? '39' : '49'}</span>
                <span className="text-xs text-[var(--faint)]"> / month</span>
              </div>

              <ul className="space-y-2.5 text-xs text-[var(--muted)] border-t border-[var(--border)] pt-4">
                <li className="flex items-center gap-2">
                  <Check className="w-3.5 h-3.5 text-[var(--accent)] font-bold" />
                  <span className="text-[var(--ink)] font-bold">Infinite transactions streams</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check className="w-3.5 h-3.5 text-emerald-500" />
                  <span>Interactive Theme Configurator</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check className="w-3.5 h-3.5 text-emerald-500" />
                  <span>Export Transactions PDF / CSV</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check className="w-3.5 h-3.5 text-emerald-500" />
                  <span>24/7 Priority Support Chat</span>
                </li>
              </ul>
            </div>
            
            <button 
              onClick={() => handleSelectTier('Business Pro')}
              className="w-full mt-6 py-2.5 text-xs font-bold bg-[var(--accent)] text-white rounded-xl hover:opacity-90 transition-all cursor-pointer shadow-md"
            >
              Upgrade Now
            </button>
          </div>

          {/* Item 3: Enterprise */}
          <div className="border border-[var(--border)] bg-[var(--surface-2)] p-5 rounded-2xl flex flex-col justify-between">
            <div>
              <span className="text-xs font-bold text-[var(--faint)] block uppercase tracking-wider">Ultimate Specs</span>
              <h4 className="text-lg font-bold mt-1">Senthra Enterprise</h4>
              <p className="text-xs text-[var(--muted)] mt-1">High fidelity dedicated virtualized controls.</p>
              
              <div className="mt-4 mb-5">
                <span className="text-2xl font-extrabold num">${isAnnual ? '79' : '99'}</span>
                <span className="text-xs text-[var(--faint)]"> / mo</span>
              </div>

              <ul className="space-y-2.5 text-xs text-[var(--muted)] border-t border-[var(--border)] pt-4">
                <li className="flex items-center gap-2">
                  <Check className="w-3.5 h-3.5 text-emerald-500" />
                  <span>All Business Pro specifications</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check className="w-3.5 h-3.5 text-emerald-500" />
                  <span>Custom sub-domain allocations</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check className="w-3.5 h-3.5 text-emerald-500" />
                  <span>Dedicated SQL server backing</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check className="w-3.5 h-3.5 text-emerald-500" />
                  <span>SLA uptime guarantee (99.99%)</span>
                </li>
              </ul>
            </div>
            
            <button 
              onClick={() => handleSelectTier('Senthra Enterprise')}
              className="w-full mt-6 py-2.5 text-xs font-semibold border border-[var(--accent)] text-[var(--accent)] hover:bg-[var(--surface)] rounded-xl transition-all cursor-pointer"
            >
              Contact Scale
            </button>
          </div>

        </div>

        {/* Footer Guarantee */}
        <div className="flex items-center justify-center gap-6 mt-8 pt-6 border-t border-[var(--border)] text-xs text-[var(--faint)]">
          <div className="flex items-center gap-1.5">
            <ShieldCheck className="w-4 h-4 text-emerald-500" /> Secure 256-bit Sockets
          </div>
          <div className="flex items-center gap-1.5">
            <Heart className="w-4 h-4 text-red-400" /> Cancel Anytime
          </div>
        </div>

      </div>
    </div>
  );
}
