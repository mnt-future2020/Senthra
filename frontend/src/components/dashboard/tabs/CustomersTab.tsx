"use client";
import React, { useState } from 'react';
import { DEMO_CUSTOMERS } from '@/data/dashboard';
import { Search, UserPlus, Mail, Users } from 'lucide-react';

export default function CustomersTab() {
  const [search, setSearch] = useState('');
  const [levelFilter, setLevelFilter] = useState('all');

  const filteredCustomers = DEMO_CUSTOMERS.filter((c) => {
    const matchesSearch = c.name.toLowerCase().includes(search.toLowerCase()) || 
                          c.email.toLowerCase().includes(search.toLowerCase()) ||
                          c.level.toLowerCase().includes(search.toLowerCase());
    
    const matchesLevel = levelFilter === 'all' || c.level.toLowerCase().includes(levelFilter.toLowerCase());

    return matchesSearch && matchesLevel;
  });

  return (
    <div className="space-y-6 tweak-transition">
      
      {/* Customers Header */}
      <div 
        className="card bg-[var(--surface)] border border-[var(--border)] p-5 shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-4"
        style={{ borderRadius: 'var(--radius)' }}
      >
        <div className="space-y-0.5">
          <h2 className="text-xl font-extrabold tracking-tight text-[var(--ink)]">Customers Registry</h2>
          <p className="text-xs text-[var(--muted)]">Inspect consumer segments, accumulated spends, and active sessions.</p>
        </div>

        <div className="flex gap-2">
          <button 
            onClick={() => {
              const name = prompt("Enter new customer full name:");
              if(name) {
                alert(`Customer ${name} queued for CRM pipeline sync!`);
              }
            }}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-bold text-white bg-[var(--pos)] hover:opacity-95 rounded-xl transition-all shadow-xs cursor-pointer"
          >
            <UserPlus className="w-4 h-4" /> Add Lead
          </button>
        </div>
      </div>

      {/* Registry Filters Controller */}
      <div className="flex flex-col sm:flex-row items-center gap-4 bg-[var(--surface)] border border-[var(--border)] p-4 rounded-xl shadow-xs">
        {/* Search */}
        <div className="relative w-full sm:w-72">
          <Search className="absolute left-3 top-3 w-4 h-4 text-[var(--faint)]" />
          <input 
            type="text"
            placeholder="Search name, tier or email..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full bg-[var(--surface-2)] text-[var(--ink)] text-xs pl-9 pr-3 py-2.5 rounded-lg border border-[var(--border)] outline-none focus:border-[var(--accent)] transition-all"
          />
        </div>

        {/* Level Filters */}
        <div className="flex gap-1.5 overflow-x-auto w-full sm:w-auto">
          {['all', 'Enterprise', 'Pro Builder', 'Starter', 'Administrator'].map((lvl) => (
            <button 
              key={lvl}
              onClick={() => setLevelFilter(lvl)}
              className={`px-3 py-1.5 text-xs font-bold rounded-lg uppercase tracking-wider transition-all cursor-pointer truncate ${
                levelFilter === lvl
                  ? 'bg-[var(--accent)] text-white' 
                  : 'bg-[var(--surface-2)] text-[var(--muted)] hover:text-[var(--ink)] border border-[var(--border)]'
              }`}
            >
              {lvl}
            </button>
          ))}
        </div>

        <div className="sm:ml-auto text-xs text-[var(--faint)] font-bold">
          Found {filteredCustomers.length} registered accounts
        </div>
      </div>

      {/* Grid of customer profile cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {filteredCustomers.length === 0 ? (
          <div className="col-span-full card bg-[var(--surface)] border border-[var(--border)] p-12 text-center">
            <Users className="w-12 h-12 text-[var(--faint)] mx-auto mb-3 animate-pulse" />
            <span className="font-extrabold text-[var(--ink)] text-base block">No Lead profile located</span>
            <p className="text-xs text-[var(--muted)] mt-1">Try relaxing filters or search keys to discover registered clients.</p>
          </div>
        ) : (
          filteredCustomers.map((c) => {
            const initials = c.name.split(' ').map(part => part[0]).join('').substring(0,2);
            return (
              <div 
                key={c.id} 
                className="card bg-[var(--surface)] border border-[var(--border)] p-5 shadow-xs flex flex-col justify-between hover:border-[var(--accent)] hover:shadow-md group transition-all"
                style={{ borderRadius: 'var(--radius)' }}
              >
                <div>
                  {/* Avatar and name banner info */}
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3">
                      <div 
                        className="w-10 h-10 rounded-full flex items-center justify-center text-white text-sm font-extrabold transition-all group-hover:scale-105"
                        style={{ backgroundColor: c.avatarBg }}
                      >
                        {initials}
                      </div>

                      <div className="leading-tight">
                        <h4 className="font-extrabold text-sm text-[var(--ink)] group-hover:text-[var(--accent)] transition-all">{c.name}</h4>
                        <span className="text-[11px] font-mono text-[var(--faint)]">{c.id}</span>
                      </div>
                    </div>

                    <span className="inline-flex items-center gap-0.5 px-2 py-0.5 text-[9px] font-extrabold text-[var(--accent)] bg-[var(--accent-10)] border border-[var(--accent-10)] rounded-md uppercase tracking-wider">
                      {c.level}
                    </span>
                  </div>

                  {/* Customer Meta Details */}
                  <div className="grid grid-cols-2 gap-3 bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 my-4 text-xs">
                    <div>
                      <span className="text-[9px] text-[var(--faint)] font-bold block uppercase tracking-wider">Total Invested</span>
                      <span className="font-extrabold text-[var(--ink)] num">{c.spend}</span>
                    </div>
                    <div>
                      <span className="text-[9px] text-[var(--faint)] font-bold block uppercase tracking-wider">Total Orders</span>
                      <span className="font-extrabold text-[var(--ink)] num">{c.orders} rows</span>
                    </div>
                  </div>

                  {/* Email & Info details */}
                  <p className="text-xs text-[var(--muted)] font-mono truncate">{c.email}</p>
                </div>

                {/* Card footer controls action */}
                <div className="flex items-center justify-between border-t border-[var(--border-2)] pt-3.5 mt-3.5">
                  <span className="text-xs text-[var(--faint)] font-semibold">
                    Last active: <b className="text-[var(--muted)]">{c.lastActive}</b>
                  </span>

                  <button 
                    onClick={() => {
                      alert(`Queued system diagnostic mail report to customer path ${c.email}`);
                    }}
                    className="p-1 px-2 text-[10px] font-bold border border-[var(--border)] rounded-md hover:bg-[var(--surface-2)] text-[var(--ink)] flex items-center gap-1 cursor-pointer transition-all"
                  >
                    <Mail className="w-3 h-3 text-[var(--accent)]" /> Send Mail
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

    </div>
  );
}
