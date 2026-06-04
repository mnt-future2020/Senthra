// A role as returned by the backend. `userCount` is how many active users hold
// it (used to guard deletion). `permissions` is reserved for a future RBAC phase.
export interface Role {
  id: string;
  key: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  userCount: number;
  sortOrder: number;
}
