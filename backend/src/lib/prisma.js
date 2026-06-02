import { PrismaClient } from "@prisma/client";

// Reuse a single PrismaClient across hot reloads / module imports.
const globalForPrisma = globalThis;

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
