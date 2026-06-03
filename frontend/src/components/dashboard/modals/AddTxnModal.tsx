"use client";
import React, { useState } from 'react';
import { Transaction } from '@/types/dashboard';
import { X, DollarSign, User, Mail, AlertCircle, Sparkles } from 'lucide-react';

interface AddTxnModalProps {
  onClose: () => void;
  onAdd: (txn: Omit<Transaction, 'id' | 'date'>) => void;
}

export default function AddTxnModal({ onClose, onAdd }: AddTxnModalProps) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [amt, setAmt] = useState('');
  const [method, setMethod] = useState('Visa •• 4021');
  const [status, setStatus] = useState<'paid' | 'pending' | 'failed' | 'refund'>('paid');
  const [errors, setErrors] = useState<Record<string, string>>({});

  const validate = () => {
    const newErrors: Record<string, string> = {};
    if (!name.trim()) newErrors.name = 'Customer name is required';
    if (!email.trim() || !email.includes('@')) newErrors.email = 'Valid customer email is required';
    if (!amt.trim() || isNaN(parseFloat(amt)) || parseFloat(amt) <= 0) {
      newErrors.amt = 'Please enter a valid numeric transaction amount greater than 0';
    }
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) return;

    // format decimal
    const roundedAmt = parseFloat(amt).toFixed(2);

    onAdd({
      name: name.trim(),
      email: email.trim().toLowerCase(),
      method,
      status,
      amt: `$${parseFloat(roundedAmt).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
      av: ['#5b8def', '#7b6ef0', '#2bb39a', '#e9a23b', '#ef6f5e', '#5bb1c9'][Math.floor(Math.random() * 6)]
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs tweak-transition anim-fade-in" id="add-txn-modal">
      <div 
        className="relative w-full max-w-md bg-[var(--surface)] border border-[var(--border)] text-[var(--ink)] shadow-2xl p-6 md:p-8 tweak-transition"
        style={{ borderRadius: 'var(--radius)' }}
      >
        {/* Header */}
        <div className="flex items-start justify-between pb-4 border-b border-[var(--border)]">
          <div className="flex items-center gap-2">
            <div className="p-2 bg-[rgba(31,174,132,0.12)] text-[var(--pos)] rounded-lg">
              <Sparkles className="w-5 h-5 animate-pulse" />
            </div>
            <div>
              <h3 className="font-extrabold text-lg tracking-tight">Generate Transaction</h3>
              <p className="text-xs text-[var(--faint)]">Instantly streams and updates state stats</p>
            </div>
          </div>
          <button 
            onClick={onClose}
            className="p-1.5 rounded-lg border border-[var(--border)] hover:bg-[var(--surface-2)] text-[var(--muted)] hover:text-[var(--ink)] transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Input Form */}
        <form onSubmit={handleSubmit} className="pt-5 space-y-4">
          
          {/* Customer Name */}
          <div>
            <label className="text-xs font-bold text-[var(--muted)] uppercase tracking-wider block mb-1.5">Customer Name</label>
            <div className="relative">
              <User className="absolute left-3 top-3 w-4 h-4 text-[var(--faint)]" />
              <input 
                type="text" 
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Marcus Aurelius"
                className={`w-full bg-[var(--surface)] text-[var(--ink)] pl-10 pr-4 py-2.5 rounded-xl border ${errors.name ? 'border-[var(--neg)]' : 'border-[var(--border)]'} outline-none focus:border-[var(--accent)] transition-all`}
              />
            </div>
            {errors.name && <span className="text-[11px] text-[var(--neg)] font-bold mt-1 block flex items-center gap-1"><AlertCircle className="w-3 h-3" /> {errors.name}</span>}
          </div>

          {/* Email */}
          <div>
            <label className="text-xs font-bold text-[var(--muted)] uppercase tracking-wider block mb-1.5">Email Address</label>
            <div className="relative">
              <Mail className="absolute left-3 top-3 w-4 h-4 text-[var(--faint)]" />
              <input 
                type="text" 
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="marcus@emperor.org"
                className={`w-full bg-[var(--surface)] text-[var(--ink)] pl-10 pr-4 py-2.5 rounded-xl border ${errors.email ? 'border-[var(--neg)]' : 'border-[var(--border)]'} outline-none focus:border-[var(--accent)] transition-all`}
              />
            </div>
            {errors.email && <span className="text-[11px] text-[var(--neg)] font-bold mt-1 block flex items-center gap-1"><AlertCircle className="w-3 h-3" /> {errors.email}</span>}
          </div>

          {/* Amount */}
          <div>
            <label className="text-xs font-bold text-[var(--muted)] uppercase tracking-wider block mb-1.5">Transaction Amount ($ USD)</label>
            <div className="relative">
              <DollarSign className="absolute left-3 top-3 w-4 h-4 text-[var(--pos)] font-bold" />
              <input 
                type="number" 
                step="any"
                value={amt}
                onChange={(e) => setAmt(e.target.value)}
                placeholder="1450.00"
                className={`w-full bg-[var(--surface)] text-[var(--ink)] font-bold num pl-10 pr-4 py-2.5 rounded-xl border ${errors.amt ? 'border-[var(--neg)]' : 'border-[var(--border)]'} outline-none focus:border-[var(--accent)] transition-all`}
              />
            </div>
            {errors.amt && <span className="text-[11px] text-[var(--neg)] font-bold mt-1 block flex items-center gap-1"><AlertCircle className="w-3 h-3" /> {errors.amt}</span>}
          </div>

          {/* Method and Status Grid */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-xs font-bold text-[var(--muted)] uppercase tracking-wider block mb-1.5">Billing Method</label>
              <select 
                value={method} 
                onChange={(e) => setMethod(e.target.value)}
                className="w-full bg-[var(--surface)] text-[var(--ink)] px-3 py-2.5 rounded-xl border border-[var(--border)] outline-none focus:border-[var(--accent)] transition-all"
              >
                <option value="Visa •• 4021">Visa •• 4021</option>
                <option value="Visa •• 1199">Visa •• 1199</option>
                <option value="Mastercard •• 8810">Mastercard •• 8810</option>
                <option value="Mastercard •• 5521">Mastercard •• 5521</option>
                <option value="PayPal">PayPal Account</option>
                <option value="Amex •• 3007">Amex •• 3007</option>
              </select>
            </div>
            <div>
              <label className="text-xs font-bold text-[var(--muted)] uppercase tracking-wider block mb-1.5">Initial Status</label>
              <select 
                value={status} 
                onChange={(e) => setStatus(e.target.value as typeof status)}
                className="w-full bg-[var(--surface)] text-[var(--ink)] px-3 py-2.5 rounded-xl border border-[var(--border)] outline-none focus:border-[var(--accent)] transition-all"
              >
                <option value="paid">Paid</option>
                <option value="pending">Pending</option>
                <option value="failed">Failed</option>
                <option value="refund">Refunded</option>
              </select>
            </div>
          </div>

          {/* Submit Actions */}
          <div className="flex gap-2 pt-4 border-t border-[var(--border)] justify-end">
            <button 
              type="button"
              onClick={onClose}
              className="px-4 py-2.5 text-xs font-bold border border-[var(--border)] rounded-xl hover:bg-[var(--surface-2)] text-[var(--muted)] hover:text-[var(--ink)] transition-all cursor-pointer"
            >
              Cancel
            </button>
            <button 
              type="submit"
              className="px-5 py-2.5 text-xs font-extrabold bg-[var(--pos)] text-white rounded-xl hover:opacity-90 transition-all cursor-pointer shadow-sm accent-glow"
            >
              Save & Process
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
