import type { Prisma, PurchaseOrderCustomField } from "@prisma/client";

import * as customFieldRepo from "./poCustomField.repository.js";
import {
  mergeCustomFieldValues,
  PO_CUSTOM_FIELD_MAX_ACTIVE,
  type StoredPoCustomField,
} from "./poCustomField.values.js";
import type { CreatePoCustomFieldInput, UpdatePoCustomFieldInput } from "./poCustomField.validation.js";
import * as audit from "#modules/audit/audit.service.js";
import type { AuditActor } from "#modules/audit/audit.service.js";
import { conflict, notFound } from "../../utils/http-error.js";

// PO custom-field DEFINITIONS (Settings → Purchase Orders). PO-specific, text-only, informational: a
// definition decides only which extra boxes the PO form offers and whether a value prints on the PDF.
// It can be created, renamed while active, switched on/off, set to print or not, and reordered — never
// deleted, because orders already hold values keyed by its id.

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

export interface PublicPoCustomField {
  id: string;
  label: string;
  type: string;
  active: boolean;
  printOnPdf: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

function toPublic(f: PurchaseOrderCustomField): PublicPoCustomField {
  return {
    id: f.id,
    label: f.label,
    type: f.type ?? "text",
    active: f.active,
    printOnPdf: f.printOnPdf,
    sortOrder: f.sortOrder,
    createdAt: f.createdAt.toISOString(),
    updatedAt: f.updatedAt.toISOString(),
  };
}

const sameLabel = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const tooManyActive = () =>
  conflict(`You can have up to ${PO_CUSTOM_FIELD_MAX_ACTIVE} active fields. Deactivate one first.`);
const onOff = (v: boolean) => (v ? "on" : "off");

export async function listCustomFields(): Promise<PublicPoCustomField[]> {
  return (await customFieldRepo.findMany()).map(toPublic);
}

export async function createCustomField(input: CreatePoCustomFieldInput, actor?: AuditActor): Promise<PublicPoCustomField> {
  const label = input.label.trim();
  // The whole list is a handful of rows; one read answers the name clash, the active cap and the next
  // position together.
  const all = await customFieldRepo.findMany();
  const clash = all.find((f) => sameLabel(f.label, label));
  if (clash) {
    throw conflict(
      clash.active
        ? `A field called "${clash.label}" already exists.`
        : `A field called "${clash.label}" already exists but is inactive — reactivate it instead.`,
    );
  }
  if (all.filter((f) => f.active).length >= PO_CUSTOM_FIELD_MAX_ACTIVE) throw tooManyActive();
  const sortOrder = all.reduce((max, f) => Math.max(max, f.sortOrder), -1) + 1;

  let created: PurchaseOrderCustomField;
  try {
    created = await customFieldRepo.create({
      label,
      type: "text",
      active: true,
      printOnPdf: input.printOnPdf ?? true,
      sortOrder,
      createdBy: actor?.email ?? null,
      updatedBy: actor?.email ?? null,
    });
  } catch (e) {
    if (customFieldRepo.isLabelConflict(e)) throw conflict(`A field called "${label}" already exists.`);
    throw e;
  }
  audit.record({
    actor,
    action: "purchase_order_custom_field.created",
    targetType: "purchase_order_custom_field",
    targetId: created.id,
    targetLabel: created.label,
  });
  return toPublic(created);
}

export async function updateCustomField(
  id: string,
  input: UpdatePoCustomFieldInput,
  actor?: AuditActor,
): Promise<PublicPoCustomField> {
  const field = OBJECT_ID_RE.test(id) ? await customFieldRepo.findById(id) : null;
  if (!field) throw notFound("Custom field not found.");

  const data: Prisma.PurchaseOrderCustomFieldUpdateInput = { updatedBy: actor?.email ?? null };
  const changes: { field: string; from: string; to: string; label: string }[] = [];
  const willBeActive = input.active ?? field.active;

  if (input.label !== undefined && input.label.trim() !== field.label) {
    const label = input.label.trim();
    // A field is renamed while it is in use. An inactive one is frozen: its name is the one the orders
    // carrying it already print, and nothing new can be entered against it — reactivate to rename.
    if (!willBeActive) throw conflict("Reactivate this field before renaming it.");
    const clash = (await customFieldRepo.findMany()).find((f) => f.id !== id && sameLabel(f.label, label));
    if (clash) throw conflict(`A field called "${clash.label}" already exists.`);
    data.label = label;
    changes.push({ field: "label", from: field.label, to: label, label: `Name: ${field.label} → ${label}` });
  }
  if (input.active !== undefined && input.active !== field.active) {
    if (input.active && (await customFieldRepo.findMany()).filter((f) => f.active).length >= PO_CUSTOM_FIELD_MAX_ACTIVE) {
      throw tooManyActive();
    }
    data.active = input.active;
    changes.push({ field: "active", from: onOff(field.active), to: onOff(input.active), label: input.active ? "Reactivated" : "Deactivated" });
  }
  if (input.printOnPdf !== undefined && input.printOnPdf !== field.printOnPdf) {
    data.printOnPdf = input.printOnPdf;
    changes.push({
      field: "printOnPdf",
      from: onOff(field.printOnPdf),
      to: onOff(input.printOnPdf),
      label: `Print on PDF: ${onOff(field.printOnPdf)} → ${onOff(input.printOnPdf)}`,
    });
  }

  let updated: PurchaseOrderCustomField;
  try {
    updated = await customFieldRepo.update(id, data);
  } catch (e) {
    if (typeof data.label === "string" && customFieldRepo.isLabelConflict(e)) {
      throw conflict(`A field called "${data.label}" already exists.`);
    }
    throw e;
  }
  audit.record({
    actor,
    action: "purchase_order_custom_field.updated",
    targetType: "purchase_order_custom_field",
    targetId: id,
    targetLabel: updated.label,
    metadata: changes.length ? { changes } : undefined,
  });
  return toPublic(updated);
}

/**
 * Reorder every definition. `ids` must be the COMPLETE current list: one that is missing a field or
 * names an unknown one means the list changed in another tab since it was loaded, and applying it would
 * silently put that field somewhere nobody chose.
 */
export async function reorderCustomFields(ids: string[], actor?: AuditActor): Promise<PublicPoCustomField[]> {
  const all = await customFieldRepo.findMany();
  const known = new Set(all.map((f) => f.id));
  if (ids.length !== all.length || ids.some((id) => !known.has(id))) {
    throw conflict("The field list changed while you were reordering it. Refresh and try again.");
  }
  await customFieldRepo.setSortOrders(ids, actor?.email ?? null);
  audit.record({
    actor,
    action: "purchase_order_custom_field.reordered",
    targetType: "purchase_order_custom_field",
    targetLabel: `${ids.length} fields`,
  });
  return listCustomFields();
}

/**
 * A PO create / draft-edit body's additional-information values, resolved against the live definitions
 * and merged onto what the order already stores — see mergeCustomFieldValues for the rules. An empty
 * body changes nothing, so it costs no read.
 */
export async function resolveCustomFieldValues(
  stored: StoredPoCustomField[],
  input: Record<string, string>,
): Promise<StoredPoCustomField[]> {
  if (Object.keys(input).length === 0) return stored;
  return mergeCustomFieldValues(stored, input, await customFieldRepo.findMany());
}
