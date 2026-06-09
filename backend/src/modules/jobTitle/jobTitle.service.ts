import type { JobTitle } from "@prisma/client";

import * as jobTitleRepo from "./jobTitle.repository.js";
import * as userRepo from "#modules/user/user.repository.js";
import { withTransaction } from "../../lib/prisma.js";
import { badRequest, conflict, notFound } from "../../utils/http-error.js";
import * as audit from "#modules/audit/audit.service.js";
import type { AuditActor } from "#modules/audit/audit.service.js";

export interface PublicJobTitle {
  id: string;
  name: string;
  createdAt: string;
}

function toPublic(j: JobTitle): PublicJobTitle {
  return { id: j.id, name: j.name, createdAt: j.createdAt.toISOString() };
}

export async function listJobTitles(): Promise<PublicJobTitle[]> {
  const rows = await jobTitleRepo.findMany();
  return rows.map(toPublic);
}

export interface JobTitleInput {
  name: string;
}

export async function createJobTitle(
  input: JobTitleInput,
  actor?: AuditActor,
): Promise<PublicJobTitle> {
  const name = input.name.trim();
  if (!name) throw badRequest("Job title is required.");
  // Friendly pre-check; the nameLower @unique index is the real guard, re-checked in
  // the catch below for the concurrent-write race.
  if (await jobTitleRepo.findByName(name)) {
    throw conflict(`A job title "${name}" already exists.`);
  }
  let created: JobTitle;
  try {
    created = await jobTitleRepo.create(name);
  } catch (e) {
    if (jobTitleRepo.isNameConflict(e)) {
      throw conflict(`A job title "${name}" already exists.`);
    }
    throw e;
  }
  audit.record({
    actor,
    action: "jobTitle.created",
    targetType: "jobTitle",
    targetId: created.id,
    targetLabel: created.name,
  });
  return toPublic(created);
}

export async function updateJobTitle(
  id: string,
  input: JobTitleInput,
  actor?: AuditActor,
): Promise<PublicJobTitle> {
  const existing = await jobTitleRepo.findById(id);
  if (!existing) throw notFound("Job title not found.");
  const name = input.name.trim();
  if (!name) throw badRequest("Job title is required.");
  // Re-check uniqueness on rename, excluding this row.
  const clash = await jobTitleRepo.findByName(name);
  if (clash && clash.id !== id) {
    throw conflict(`A job title "${name}" already exists.`);
  }
  // Rename the record AND cascade to every user holding the old name in ONE atomic
  // transaction — User.jobTitle is the denormalized name, so both writes commit
  // together or roll back together. The user cascade is skipped when unchanged.
  let updated: JobTitle;
  try {
    updated = await withTransaction(async (tx) => {
      const renamed = await jobTitleRepo.update(id, name, tx);
      if (existing.name !== name) {
        await userRepo.renameJobTitle(existing.name, name, tx);
      }
      return renamed;
    });
  } catch (e) {
    if (jobTitleRepo.isNameConflict(e)) {
      throw conflict(`A job title "${name}" already exists.`);
    }
    throw e;
  }
  audit.record({
    actor,
    action: "jobTitle.updated",
    targetType: "jobTitle",
    targetId: id,
    targetLabel: updated.name,
  });
  return toPublic(updated);
}

export async function deleteJobTitle(id: string, actor?: AuditActor): Promise<void> {
  const existing = await jobTitleRepo.findById(id);
  if (!existing) throw notFound("Job title not found.");
  // User.jobTitle stores the NAME (denormalized), so removing a job title from the
  // master list never orphans a user — their stored title text is kept.
  await jobTitleRepo.remove(id);
  audit.record({
    actor,
    action: "jobTitle.deleted",
    targetType: "jobTitle",
    targetId: id,
    targetLabel: existing.name,
  });
}
