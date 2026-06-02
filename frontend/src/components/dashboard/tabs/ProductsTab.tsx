"use client";
import React, { useState } from 'react';
import { DEMO_PRODUCTS } from '../data';
import { Search, Plus, ShoppingBag, Server, Notebook, Sparkles } from 'lucide-react';

export default function ProductsTab() {
  const [products, setProducts] = useState(DEMO_PRODUCTS);
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('all');

  const filtered = products.filter((p) => {
    const matchesSearch = p.name.toLowerCase().includes(search.toLowerCase()) || 
                          p.id.toLowerCase().includes(search.toLowerCase());
    
    const matchesCat = categoryFilter === 'all' || p.category === categoryFilter;

    return matchesSearch && matchesCat;
  });

  const handleCreateProduct = () => {
    const name = prompt("Enter product name:");
    if(!name) return;
    const category = prompt("Enter category (Hardware/Software/Compliance):", "Software");
    if(!category) return;
    const priceStr = prompt("Enter price tag (e.g. $299):", "$299");
    if(!priceStr) return;

    const newProd = {
      id: `PROD-${Math.random().toString(36).slice(2,5).toUpperCase()}`,
      name,
      category,
      price: priceStr.startsWith('$') ? priceStr : `$${priceStr}`,
      sales: 0,
      status: 'In Stock'
    };

    setProducts([newProd, ...products]);
    alert(`${name} successfully registered in internal catalogues!`);
  };

  const handleSell = (id: string) => {
    setProducts(products.map(p => {
      if(p.id === id) {
        return { ...p, sales: p.sales + 1 };
      }
      return p;
    }));
  };

  const getCatIcon = (category: string) => {
    switch (category.toLowerCase()) {
      case 'hardware':
        return <Server className="w-5 h-5 text-indigo-500" />;
      case 'software':
        return <ShoppingBag className="w-5 h-5 text-[var(--accent)]" />;
      default:
        return <Notebook className="w-5 h-5 text-emerald-500" />;
    }
  };

  return (
    <div className="space-y-6 tweak-transition">
      
      {/* Products Banner */}
      <div 
        className="card bg-[var(--surface)] border border-[var(--border)] p-5 shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-4"
        style={{ borderRadius: 'var(--radius)' }}
      >
        <div className="space-y-0.5">
          <h2 className="text-xl font-extrabold tracking-tight text-[var(--ink)]">Catalog Management</h2>
          <p className="text-xs text-[var(--muted)]">Inspect hardware sensors, local platform licenses and pricing configurations.</p>
        </div>

        <button 
          onClick={handleCreateProduct}
          className="inline-flex items-center gap-1.5 px-4 py-2 bg-[var(--pos)] text-white hover:opacity-90 font-bold text-xs rounded-xl transition-all cursor-pointer shadow-xs"
        >
          <Plus className="w-4 h-4" /> Add Product
        </button>
      </div>

      {/* Catalog Search & Filtering */}
      <div className="flex flex-col sm:flex-row items-center gap-4 bg-[var(--surface)] border border-[var(--border)] p-4 rounded-xl shadow-xs">
        {/* Search */}
        <div className="relative w-full sm:w-72">
          <Search className="absolute left-3 top-3 w-4 h-4 text-[var(--faint)]" />
          <input 
            type="text"
            placeholder="Search items by name or SKU ID..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full bg-[var(--surface-2)] text-[var(--ink)] text-xs pl-9 pr-3 py-2.5 rounded-lg border border-[var(--border)] outline-none focus:border-[var(--accent)] transition-all"
          />
        </div>

        {/* Categories togglers */}
        <div className="flex gap-1.5 overflow-x-auto w-full sm:w-auto">
          {['all', 'Hardware', 'Software', 'Compliance'].map((cat) => (
            <button 
              key={cat}
              onClick={() => setCategoryFilter(cat)}
              className={`px-3 py-1.5 text-xs font-bold rounded-lg uppercase tracking-wider transition-all cursor-pointer ${
                categoryFilter === cat
                  ? 'bg-[var(--accent)] text-white shadow-xs' 
                  : 'bg-[var(--surface-2)] text-[var(--muted)] hover:text-[var(--ink)] border border-[var(--border)]'
              }`}
            >
              {cat}
            </button>
          ))}
        </div>

        <div className="sm:ml-auto text-xs text-[var(--faint)] font-bold">
          Found {filtered.length} products listed
        </div>
      </div>

      {/* Products list grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {filtered.length === 0 ? (
          <div className="col-span-full card bg-[var(--surface)] border border-[var(--border)] p-12 text-center">
            <ShoppingBag className="w-12 h-12 text-[var(--faint)] mx-auto mb-3 animate-ping" />
            <span className="font-extrabold text-[var(--ink)] text-base block">No listed items found</span>
          </div>
        ) : (
          filtered.map((p) => {
            const isOutOfStock = p.status.toLowerCase().includes('out');
            const isLimited = p.status.toLowerCase().includes('limit');

            return (
              <div 
                key={p.id} 
                className="card bg-[var(--surface)] border border-[var(--border)] p-5 shadow-xs flex flex-col justify-between hover:border-[var(--accent)] hover:shadow-md transition-all group"
                style={{ borderRadius: 'var(--radius)' }}
              >
                <div>
                  <div className="flex items-start justify-between">
                    <div className="p-2.5 bg-[var(--surface-2)] border border-[var(--border)] rounded-xl group-hover:scale-105 transition-transform">
                      {getCatIcon(p.category)}
                    </div>

                    <div className="text-right">
                      <span className={`inline-flex items-center gap-0.5 px-2 py-0.5 text-[9px] font-extrabold rounded-md uppercase tracking-wider ${
                        isOutOfStock ? 'text-[var(--neg)] bg-red-500/10' : 
                        isLimited ? 'text-[var(--warn)] bg-amber-500/10' : 'text-[var(--pos)] bg-emerald-500/10'
                      }`}>
                        {p.status}
                      </span>
                      <span className="text-[10px] text-[var(--faint)] font-mono block mt-1">{p.id}</span>
                    </div>
                  </div>

                  <div className="my-4">
                    <span className="text-[10px] text-[var(--faint)] uppercase font-bold tracking-wider">{p.category}</span>
                    <h3 className="font-extrabold text-sm text-[var(--ink)] group-hover:text-[var(--accent)] transition-all mt-0.5 leading-snug">{p.name}</h3>
                  </div>

                  <div className="flex items-baseline gap-2 pb-3 border-b border-[var(--border-2)]">
                    <span className="text-lg font-black text-[var(--ink)] num">{p.price}</span>
                    <span className="text-[10px] text-[var(--faint)]">unit cost basis</span>
                  </div>
                </div>

                {/* Footer Controls */}
                <div className="flex items-center justify-between pt-3.5 mt-3.5">
                  <span className="text-xs text-[var(--muted)] font-bold">
                    Logged Sales: <b className="text-[var(--ink)] font-extrabold num">{p.sales}</b>
                  </span>

                  <button 
                    onClick={() => handleSell(p.id)}
                    className="px-3 py-1.5 text-xs font-bold bg-[var(--accent-10)] text-[var(--accent)] hover:bg-[var(--accent)] hover:text-white rounded-lg transition-all flex items-center gap-1 cursor-pointer"
                  >
                    <Sparkles className="w-3.5 h-3.5" /> Book Sale
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
