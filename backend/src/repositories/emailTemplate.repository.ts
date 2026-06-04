import type { EmailTemplate, Prisma } from "@prisma/client";

import { prisma } from "../lib/prisma.js";

// Data-access layer for the EmailTemplate model.

export function findMany(): Promise<EmailTemplate[]> {
  return prisma.emailTemplate.findMany({
    orderBy: [{ category: "asc" }, { name: "asc" }],
  });
}

export function findById(id: string): Promise<EmailTemplate | null> {
  return prisma.emailTemplate.findUnique({ where: { id } });
}

export function findByKey(key: string): Promise<EmailTemplate | null> {
  return prisma.emailTemplate.findUnique({ where: { key } });
}

export function count(): Promise<number> {
  return prisma.emailTemplate.count();
}

export function create(data: Prisma.EmailTemplateCreateInput): Promise<EmailTemplate> {
  return prisma.emailTemplate.create({ data });
}

export function update(
  id: string,
  data: Prisma.EmailTemplateUpdateInput,
): Promise<EmailTemplate> {
  return prisma.emailTemplate.update({ where: { id }, data });
}

export function remove(id: string): Promise<EmailTemplate> {
  return prisma.emailTemplate.delete({ where: { id } });
}

// Idempotent seed helper — creates the template if its key is missing, never
// overwrites an existing one (so admin edits are preserved across restarts).
export function upsertByKey(
  key: string,
  create: Prisma.EmailTemplateCreateInput,
): Promise<EmailTemplate> {
  return prisma.emailTemplate.upsert({ where: { key }, update: {}, create });
}
