import { PrismaClient } from "@prisma/client";

import { isProduction } from "../config/env.js";

// Reuse a single PrismaClient across hot reloads / module imports in dev.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (!isProduction) {
  globalForPrisma.prisma = prisma;
}
