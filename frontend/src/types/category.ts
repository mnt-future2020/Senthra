export interface Category {
  id: string;
  key: string;
  name: string;
  description: string | null;
  status: "active" | "inactive";
  sortOrder: number;
  itemCount: number;
  createdAt: string;
}

export interface CategoryPayload {
  name: string;
  description?: string;
  status?: "active" | "inactive";
}
