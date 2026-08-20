import type { Admin, Prisma } from "@prisma/client";

import { prisma } from "../../lib/prisma.js";

// Data-access layer for the Admin model. This is the ONLY place that talks to
// Prisma for admins — services depend on these functions, never on Prisma directly.

export function findByEmail(email: string): Promise<Admin | null> {
  return prisma.admin.findUnique({ where: { email } });
}

// Name-only lookup for a batch of emails — the other half of resolving the people a DOCUMENT names.
// A super admin is not a User, so without this a purchase order raised by one resolved to nothing
// and printed a raw login instead of a person.
export function findNamesByEmails(emails: string[]): Promise<{ email: string; name: string | null }[]> {
  if (emails.length === 0) return Promise.resolve([]);
  return prisma.admin.findMany({ where: { email: { in: emails } }, select: { email: true, name: true } });
}

export function findById(id: string): Promise<Admin | null> {
  return prisma.admin.findUnique({ where: { id } });
}

export function findFirst(): Promise<Admin | null> {
  return prisma.admin.findFirst();
}

export function findByResetTokenHash(resetTokenHash: string): Promise<Admin | null> {
  return prisma.admin.findFirst({ where: { resetTokenHash } });
}

export function create(data: Prisma.AdminCreateInput): Promise<Admin> {
  return prisma.admin.create({ data });
}

export function update(id: string, data: Prisma.AdminUpdateInput): Promise<Admin> {
  return prisma.admin.update({ where: { id }, data });
}

export function count(): Promise<number> {
  return prisma.admin.count();
}
