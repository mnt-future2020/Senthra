import { Prisma, type Department } from "@prisma/client";

import { prisma } from "../../lib/prisma.js";

// Data-access layer for the Department model (employee master-data). The only place
// Prisma is touched for departments.

export function findMany(): Promise<Department[]> {
  return prisma.department.findMany({ orderBy: { name: "asc" } });
}

export function findById(id: string): Promise<Department | null> {
  return prisma.department.findUnique({ where: { id } });
}

// Case-insensitive lookup, served straight off the `nameLower` unique index — used
// to enforce uniqueness with a friendly message before writing. The @unique index
// is the real guard; this is just the polite pre-check.
export function findByName(name: string): Promise<Department | null> {
  return prisma.department.findUnique({ where: { nameLower: name.trim().toLowerCase() } });
}

// create/update take the display `name` and derive `nameLower` here, so the two can
// never drift out of sync — the lowercased mirror is always written alongside.
export function create(name: string): Promise<Department> {
  return prisma.department.create({ data: { name, nameLower: name.toLowerCase() } });
}

export function update(
  id: string,
  name: string,
  client: Prisma.TransactionClient = prisma,
): Promise<Department> {
  return client.department.update({
    where: { id },
    data: { name, nameLower: name.toLowerCase() },
  });
}

export function remove(id: string): Promise<Department> {
  return prisma.department.delete({ where: { id } });
}

// True when a write failed because the `nameLower` unique index rejected a duplicate
// (P2002). The service turns this into the same friendly 409 as the pre-check, so a
// name that slips past the pre-check under a concurrent write still gets a clean
// message instead of leaking a raw Prisma error.
export function isNameConflict(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
}
