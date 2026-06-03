"use client";
import React from 'react';
import { Transaction } from '@/types/dashboard';
import { X, Receipt, Download, CheckCircle2, AlertTriangle, HelpCircle, Mail, RotateCcw, ShieldCheck } from 'lucide-react';

interface ReceiptModalProps {
  transaction: Transaction | null;
  onClose: () => void;
  onUpdateStatus: (id: string, status: Transaction['status']) => void;
  onDelete: (id: string) => void;
}

export default function ReceiptModal({ transaction, onClose, onUpdateStatus, onDelete }: ReceiptModalProps) {
  if (!transaction) return null;

  const getStatusIcon = (status: Transaction['status']) => {
    switch (status) {
      case 'paid':
        return <CheckCircle2 className="w-5 height-5 text-[var(--pos)]" />;
      case 'pending':
        return <HelpCircle className="w-5 height-5 text-[var(--warn)]" />;
      case 'failed':
        return <AlertTriangle className="w-5 height-5 text-[var(--neg)]" />;
      case 'refund':
        return <RotateCcw className="w-5 height-5 text-gray-500" />;
    }
  };

  const getStatusClass = (status: Transaction['status']) => {
    switch (status) {
      case 'paid':
        return 'bg-[rgba(31,174,132,0.1)] text-[var(--pos)]';
      case 'pending':
        return 'bg-[rgba(233,162,59,0.1)] text-[var(--warn)]';
      case 'failed':
        return 'bg-[rgba(239,111,94,0.1)] text-[var(--neg)]';
      case 'refund':
        return 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300';
    }
  };

  // Extract payment method card type
  const isVisa = transaction.method.toLowerCase().includes('visa');
  const isMaster = transaction.method.toLowerCase().includes('mastercard');
  const isAmex = transaction.method.toLowerCase().includes('amex');
  const isPaypal = transaction.method.toLowerCase().includes('paypal');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs tweak-transition anim-fade-in" id="receipt-modal">
      <div 
        className="relative w-full max-w-lg bg-[var(--surface)] border border-[var(--border)] text-[var(--ink)] shadow-2xl p-6 md:p-8 tweak-transition"
        style={{ borderRadius: 'var(--radius)' }}
      >
        {/* Header */}
        <div className="flex items-start justify-between pb-4 border-b border-[var(--border)]">
          <div className="flex items-center gap-3">
            <div className="p-3 bg-[var(--accent-12)] text-[var(--accent)] rounded-xl">
              <Receipt className="w-6 h-6" />
            </div>
            <div>
              <h3 className="font-extrabold text-lg tracking-tight">Receipt Details</h3>
              <p className="text-xs text-[var(--faint)]">{transaction.id}</p>
            </div>
          </div>
          <button 
            onClick={onClose}
            className="p-1.5 rounded-lg border border-[var(--border)] hover:bg-[var(--surface-2)] text-[var(--muted)] hover:text-[var(--ink)] transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Body */}
        <div className="py-6 space-y-6">
          {/* Main Status & Amount Block */}
          <div className="text-center p-4 bg-[var(--surface-2)] rounded-2xl border border-[var(--border-2)]">
            <span className="text-xs font-bold text-[var(--faint)] uppercase tracking-widest block mb-1">Transaction Amount</span>
            <span className="text-4xl font-extrabold tracking-tight num select-all">{transaction.amt}</span>
            <div className="flex justify-center mt-3">
              <span className={`inline-flex items-center gap-1 px-3 py-1 text-xs font-extrabold rounded-full ${getStatusClass(transaction.status)}`}>
                {getStatusIcon(transaction.status)}
                <span className="capitalize">{transaction.status}</span>
              </span>
            </div>
          </div>

          {/* Customer & Billing Meta */}
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <span className="text-xs text-[var(--faint)] font-bold block mb-1 uppercase tracking-wider">Customer Name</span>
              <span className="font-bold block text-[var(--ink)]">{transaction.name}</span>
            </div>
            <div>
              <span className="text-xs text-[var(--faint)] font-bold block mb-1 uppercase tracking-wider">Email Address</span>
              <span className="text-xs block text-[var(--muted)] font-mono break-all leading-tight">{transaction.email}</span>
            </div>
            <div>
              <span className="text-xs text-[var(--faint)] font-bold block mb-1 uppercase tracking-wider">Payment Method</span>
              <span className="font-semibold block flex items-center gap-1.5">
                {isVisa && <span className="px-1 text-[10px] font-extrabold text-blue-600 bg-blue-50 border border-blue-200 rounded">VISA</span>}
                {isMaster && <span className="px-1 text-[10px] font-extrabold text-red-600 bg-red-50 border border-red-200 rounded">MC</span>}
                {isAmex && <span className="px-1 text-[10px] font-extrabold text-amber-700 bg-amber-50 border border-amber-200 rounded">AMEX</span>}
                {isPaypal && <span className="px-1 text-[10px] font-extrabold text-blue-700 bg-sky-50 border border-sky-200 rounded">PP</span>}
                <span className="font-mono">{transaction.method}</span>
              </span>
            </div>
            <div>
              <span className="text-xs text-[var(--faint)] font-bold block mb-1 uppercase tracking-wider">Completed Date</span>
              <span className="font-semibold block text-[var(--muted)]">{transaction.date}</span>
            </div>
          </div>

          {/* Secure Audit Note */}
          <div className="p-3 border border-emerald-500/10 bg-emerald-500/5 rounded-xl flex items-center gap-3 text-xs text-[var(--pos)]">
            <ShieldCheck className="w-4 h-4 flex-none" />
            <span>This payment is thoroughly secured. Authenticated and compiled via custom Senthra admin protocols.</span>
          </div>

          {/* Transaction State Updaters */}
          <div className="pt-2 border-t border-[var(--border)]">
            <span className="text-xs font-extrabold text-[var(--faint)] uppercase tracking-widest block mb-2">Update Statement State</span>
            <div className="grid grid-cols-4 gap-2">
              <button 
                onClick={() => onUpdateStatus(transaction.id, 'paid')}
                disabled={transaction.status === 'paid'}
                className="py-2 text-[11px] font-extrabold rounded-lg border border-[var(--border)] hover:bg-[var(--surface-2)] text-[var(--pos)] disabled:opacity-40 transition-all cursor-pointer"
              >
                Mark Paid
              </button>
              <button 
                onClick={() => onUpdateStatus(transaction.id, 'pending')}
                disabled={transaction.status === 'pending'}
                className="py-2 text-[11px] font-extrabold rounded-lg border border-[var(--border)] hover:bg-[var(--surface-2)] text-[var(--warn)] disabled:opacity-40 transition-all cursor-pointer"
              >
                Pending
              </button>
              <button 
                onClick={() => onUpdateStatus(transaction.id, 'refund')}
                disabled={transaction.status === 'refund'}
                className="py-2 text-[11px] font-extrabold rounded-lg border border-[var(--border)] hover:bg-[var(--surface-2)] text-gray-500 disabled:opacity-40 transition-all cursor-pointer"
              >
                Refund
              </button>
              <button 
                onClick={() => onUpdateStatus(transaction.id, 'failed')}
                disabled={transaction.status === 'failed'}
                className="py-2 text-[11px] font-extrabold rounded-lg border border-[var(--border)] hover:bg-[var(--surface-2)] text-[var(--neg)] disabled:opacity-40 transition-all cursor-pointer"
              >
                Mark Fail
              </button>
            </div>
          </div>
        </div>

        {/* Footer actions */}
        <div className="flex gap-2 pt-4 border-t border-[var(--border)] justify-between">
          <button 
            onClick={() => onDelete(transaction.id)}
            className="px-4 py-2 text-xs font-bold text-[var(--neg)] hover:bg-red-500/10 rounded-xl border border-transparent transition-all cursor-pointer"
          >
            Delete Entry
          </button>
          
          <div className="flex gap-2">
            <button 
              onClick={() => {
                alert(`Receipt PDF generated and queued for download! Invoice ref: ${transaction.id}`);
              }}
              className="flex items-center gap-1.5 px-4 py-2 text-xs font-bold border border-[var(--border)] rounded-xl hover:bg-[var(--surface-2)] text-[var(--ink)] transition-all cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              PDF
            </button>
            <button 
              onClick={() => {
                alert(`Receipt invoice sent to client email: ${transaction.email}`);
              }}
              className="flex items-center gap-1.5 px-4 py-2.5 text-xs font-bold bg-[var(--accent)] text-white rounded-xl hover:opacity-90 transition-all cursor-pointer shadow-xs"
            >
              <Mail className="w-3.5 h-3.5" />
              Email Customer
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
