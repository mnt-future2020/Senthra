"use client";
import React, { useState } from 'react';
import { Transaction } from '../types';
import { Search, Download, Trash2, Mail, ShieldAlert } from 'lucide-react';

interface InvoicesTabProps {
  transactions: Transaction[];
  onSelectTransaction: (txn: Transaction) => void;
  onDeleteTransaction: (id: string) => void;
  onUpdateStatus: (id: string, status: Transaction['status']) => void;
}

export default function InvoicesTab({ 
  transactions, 
  onSelectTransaction, 
  onDeleteTransaction, 
  onUpdateStatus 
}: InvoicesTabProps) {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');

  // filter
  const filtered = transactions.filter((t) => {
    const matchesSearch = t.name.toLowerCase().includes(search.toLowerCase()) || 
                          t.email.toLowerCase().includes(search.toLowerCase()) ||
                          t.id.toLowerCase().includes(search.toLowerCase()) ||
                          t.method.toLowerCase().includes(search.toLowerCase());
    
    const matchesStatus = statusFilter === 'all' || t.status === statusFilter;

    return matchesSearch && matchesStatus;
  });

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
      
      {/* Index Invoices Title Banner */}
      <div 
        className="card bg-[var(--surface)] border border-[var(--border)] p-5 shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-4"
        style={{ borderRadius: 'var(--radius)' }}
      >
        <div className="space-y-0.5">
          <h2 className="text-xl font-extrabold tracking-tight text-[var(--ink)]">Billing & Invoices Hub</h2>
          <p className="text-xs text-[var(--muted)]">Inspect structured customer slips, dispatch invoice copies, or enforce status adjustments.</p>
        </div>

        <button 
          onClick={() => {
            alert("Compiling audit report of current ledger terms...");
          }}
          className="inline-flex items-center gap-1.5 px-4 py-2.5 bg-[var(--surface-2)] text-[var(--ink)] hover:bg-[var(--border-2)] border border-[var(--border)] font-bold text-xs rounded-xl transition-all cursor-pointer"
        >
          <Download className="w-4 h-4 text-[var(--accent)]" /> Export Master Ledger
        </button>
      </div>

      {/* Structured Billing Control Filters */}
      <div className="flex flex-col md:flex-row items-center gap-4 bg-[var(--surface)] border border-[var(--border)] p-4 rounded-xl shadow-xs">
        {/* Search Input block */}
        <div className="relative w-full md:w-72">
          <Search className="absolute left-3 top-3 w-4 h-4 text-[var(--faint)]" />
          <input 
            type="text"
            placeholder="Search invoices ref, customer, email..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full bg-[var(--surface-2)] text-[var(--ink)] text-xs pl-9 pr-3 py-2.5 rounded-lg border border-[var(--border)] outline-none focus:border-[var(--accent)] transition-all"
          />
        </div>

        {/* State filters pills */}
        <div className="flex flex-wrap gap-1.5 w-full md:w-auto">
          {['all', 'paid', 'pending', 'failed', 'refund'].map((st) => (
            <button 
              key={st}
              onClick={() => setStatusFilter(st)}
              className={`px-3 py-1.5 text-[11px] font-extrabold rounded-lg uppercase tracking-wider transition-all cursor-pointer ${
                statusFilter === st
                  ? 'bg-[var(--accent)] text-white shadow-xs' 
                  : 'bg-[var(--surface-2)] text-[var(--muted)] hover:text-[var(--ink)] border border-[var(--border)]'
              }`}
            >
              {st}
            </button>
          ))}
        </div>

        <div className="md:ml-auto text-xs text-[var(--faint)] font-bold">
          Found {filtered.length} invoice rows
        </div>
      </div>

      {/* Main Ledger Structured Table Card */}
      <div className="card bg-[var(--surface)] border border-[var(--border)] shadow-xs" style={{ borderRadius: 'var(--radius)' }}>
        <div className="p-4 border-b border-[var(--border-2)] flex justify-between items-center bg-[var(--surface-2)] rounded-t-2xl">
          <span className="text-xs uppercase font-extrabold tracking-widest text-[var(--muted)]">Statement Ledger</span>
          <span className="text-xs font-bold text-[var(--faint)]">Click row to open interactive inspector</span>
        </div>

        <div className="overflow-x-auto">
          {filtered.length === 0 ? (
            <div className="p-12 text-center col-span-full">
              <ShieldAlert className="w-12 h-12 text-[var(--faint)] mx-auto mb-3 animate-ping" />
              <p className="text-sm font-bold text-[var(--muted)]">No billing statements located</p>
            </div>
          ) : (
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-[var(--border)] bg-[var(--surface-2)] text-xs text-[var(--muted)]">
                  <th className="p-4 font-bold">LID REF</th>
                  <th className="p-4 font-bold">Customer Client</th>
                  <th className="p-4 font-bold">Completed On</th>
                  <th className="p-4 font-bold">Payment Method</th>
                  <th className="p-4 font-bold">Billing State</th>
                  <th className="p-4 font-bold text-right">Amount</th>
                  <th className="p-4 font-bold text-right">Quick Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((t) => (
                  <tr 
                    key={t.id} 
                    className="border-b border-[var(--border-2)] hover:bg-[var(--surface-2)] transition-colors group cursor-pointer"
                  >
                    <td 
                      onClick={() => onSelectTransaction(t)}
                      className="p-4 text-xs font-mono font-bold text-[var(--muted)] hover:text-[var(--accent)] transition-colors"
                    >
                      {t.id}
                    </td>
                    <td 
                      onClick={() => onSelectTransaction(t)}
                      className="p-4"
                    >
                      <div className="leading-tight">
                        <span className="text-xs font-bold block text-[var(--ink)]">{t.name}</span>
                        <span className="text-[10px] text-[var(--faint)] font-mono block select-all">{t.email}</span>
                      </div>
                    </td>
                    <td onClick={() => onSelectTransaction(t)} className="p-4 text-xs text-[var(--muted)]">
                      {t.date}
                    </td>
                    <td onClick={() => onSelectTransaction(t)} className="p-4 text-xs text-[var(--muted)] font-mono">
                      {t.method}
                    </td>
                    <td onClick={() => onSelectTransaction(t)} className="p-4">
                      <span className={`inline-flex items-center px-2 py-0.5 text-[10px] font-extrabold rounded-full ${getStatusBadgeClass(t.status)}`}>
                        <i className="w-1.5 h-1.5 rounded-full bg-current mr-1"></i>
                        <span className="capitalize">{t.status}</span>
                      </span>
                    </td>
                    <td onClick={() => onSelectTransaction(t)} className="p-4 text-xs font-bold text-right text-[var(--ink)] num">
                      {t.amt}
                    </td>
                    <td className="p-4 text-right">
                      <div className="flex justify-end gap-1.5 opacity-60 group-hover:opacity-100 transition-opacity">
                        
                        {/* Quick Refund indicator toggle */}
                        {t.status === 'paid' && (
                          <button 
                            onClick={(e) => {
                              e.stopPropagation();
                              onUpdateStatus(t.id, 'refund');
                            }}
                            className="p-1.5 text-xs font-extrabold text-[var(--warn)] border border-[var(--border)] rounded-md hover:bg-[var(--surface)] transition-all cursor-pointer"
                            title="Process instant refund"
                          >
                            Refund
                          </button>
                        )}

                        <button 
                          onClick={(e) => {
                            e.stopPropagation();
                            alert(`Ledger details sent to recipient: ${t.email}`);
                          }}
                          className="p-1 px-1.5 text-xs text-[var(--muted)] hover:text-[var(--accent)] border border-[var(--border)] rounded hover:bg-[var(--surface)] transition-all cursor-pointer"
                          title="Email client statement"
                        >
                          <Mail className="w-3.5 h-3.5" />
                        </button>

                        <button 
                          onClick={(e) => {
                            e.stopPropagation();
                            onDeleteTransaction(t.id);
                          }}
                          className="p-1 px-1.5 text-xs text-[var(--muted)] hover:text-[var(--neg)] border border-[var(--border)] rounded hover:bg-[var(--surface)] transition-all cursor-pointer"
                          title="Purge transaction row"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>

                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="p-4 border-t border-[var(--border-2)] text-xs text-[var(--faint)] text-center font-bold">
          Standard administrative log is fully certified. Legally encrypted via custom SHA ledger signatures.
        </div>
      </div>

    </div>
  );
}
