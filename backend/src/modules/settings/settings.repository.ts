import type { Prisma, Settings } from "@prisma/client";

import { prisma } from "../../lib/prisma.js";

// Data-access layer for the Settings singleton.

export function findFirst(): Promise<Settings | null> {
  return prisma.settings.findFirst();
}

export function create(data: Prisma.SettingsCreateInput = {}): Promise<Settings> {
  return prisma.settings.create({ data });
}

export function update(id: string, data: Prisma.SettingsUpdateInput): Promise<Settings> {
  return prisma.settings.update({ where: { id }, data });
}

export function count(): Promise<number> {
  return prisma.settings.count();
}

// Settings is a singleton — fetch it, creating the default row if it's missing.
export async function getOrCreate(): Promise<Settings> {
  const existing = await findFirst();
  return existing ?? create({});
}
