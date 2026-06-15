// IRM Category master-data — the COMPANY-domain taxonomy (separate from the customer
// Category master). Managed under Settings.

export interface IrmCategory {
  id: string;
  key: string;
  name: string;
  description: string | null;
  status: "active" | "inactive";
  sortOrder: number;
  itemCount: number;
  createdAt: string;
}

export interface IrmCategoryPayload {
  name: string;
  description?: string;
  status?: "active" | "inactive";
}
