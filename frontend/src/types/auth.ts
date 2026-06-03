// The authenticated admin as returned by the backend (never includes secrets).
export interface Admin {
  id: string;
  email: string;
  name: string | null;
  googleEmail: string | null;
}
