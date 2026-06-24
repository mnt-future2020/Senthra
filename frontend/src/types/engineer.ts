// Engineer Portal types — the read-only self-service shapes returned by /engineer/*.

export interface EngineerStockItem {
  irmItemId: string;
  itemCode: string;
  itemName: string;
  baseUnit: string | null;
  quantityOnHand: number;
}

export interface EngineerActivity {
  id: string;
  type: string; // goods_out (future: usage | return | transfer_in | transfer_out)
  label: string; // human label for the type
  itemCode: string;
  itemName: string;
  quantityDelta: number;
  balanceAfter: number;
  sourceCode: string | null; // e.g. GDN-0001
  notes: string | null;
  createdAt: string;
}

export interface EngineerOverview {
  stock: { lines: number; totalQuantity: number };
  dispatches: { total: number };
  recentActivity: EngineerActivity[];
}
