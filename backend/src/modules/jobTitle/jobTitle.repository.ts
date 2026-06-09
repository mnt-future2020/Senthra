import { Prisma, type JobTitle } from "@prisma/client";

import { prisma } from "../../lib/prisma.js";

// Data-access layer for the JobTitle model (employee master-data). The only place
// Prisma is touched for job titles. Mirrors the Department repository, including the
// `nameLower` unique index that enforces case-insensitive uniqueness at the DB.

export function findMany(): Promise<JobTitle[]> {
  return prisma.jobTitle.findMany({ orderBy: { name: "asc" } });
}

export function findById(id: string): Promise<JobTitle | null> {
  return prisma.jobTitle.findUnique({ where: { id } });
}

// Case-insensitive lookup off the `nameLower` unique index — the polite pre-check.
export function findByName(name: string): Promise<JobTitle | null> {
  return prisma.jobTitle.findUnique({ where: { nameLower: name.trim().toLowerCase() } });
}

// create/update take the display `name` and derive `nameLower` here, so the two can
// never drift out of sync.
export function create(name: string): Promise<JobTitle> {
  return prisma.jobTitle.create({ data: { name, nameLower: name.toLowerCase() } });
}

export function update(
  id: string,
  name: string,
  client: Prisma.TransactionClient = prisma,
): Promise<JobTitle> {
  return client.jobTitle.update({
    where: { id },
    data: { name, nameLower: name.toLowerCase() },
  });
}

export function remove(id: string): Promise<JobTitle> {
  return prisma.jobTitle.delete({ where: { id } });
}

// True when a write failed on the `nameLower` unique index (P2002) — the service
// turns this into the same friendly 409 as the pre-check, covering the concurrent
// write race.
export function isNameConflict(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
}
