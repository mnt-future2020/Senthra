// Augments Express's Request so authenticated handlers can read the admin id
// set by the requireAuth middleware.
export {};

declare global {
  namespace Express {
    interface Request {
      adminId?: string;
    }
  }
}
