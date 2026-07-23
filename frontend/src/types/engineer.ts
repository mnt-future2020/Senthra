// Engineer Portal types — the read-only self-service shapes returned by /engineer/*.

export interface EngineerStockItem {
  irmItemId: string;
  itemCode: string;
  itemName: string;
  baseUnit: string | null;
  quantityOnHand: number;
  lastMovedAt: string | null; // last time this line moved (dispatch/return) — the balance's updatedAt
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

// A slim job row for the dashboard's "next up" list.
export interface EngineerOverviewJob {
  id: string;
  jobNumber: string;
  name: string;
  customerName: string | null;
  completionDate: string | null;
  priority: string;
  status: string;
}

export interface EngineerOverview {
  stock: { lines: number; totalQuantity: number };
  customerStock: { lines: number; totalQuantity: number }; // held customer consignment
  misc: { lines: number; totalQuantity: number }; // held misc (free-text) items
  jobs: {
    toAccept: number;
    accepted: number;
    inProgress: number;
    overdue: number;
    dueThisWeek: number;
    next: EngineerOverviewJob[]; // active jobs, soonest due first
  };
  transfers: { incomingPending: number; toSign: number }; // incoming awaiting acceptance / delivered awaiting signature
  vanStock: { toCollect: number }; // approved/partially-fulfilled restocks waiting to be collected
  kitRequests: { pending: number }; // own kit requests awaiting a planner decision
  recentActivity: EngineerActivity[];
}
