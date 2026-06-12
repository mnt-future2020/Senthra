"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";

import * as customerService from "@/services/customer.service";
import { Modal } from "@/components/ui/Modal";
import { RequiredMark } from "@/components/ui/FormScaffold";
import { ghostBtn, inputCls, labelCls, primaryBtn } from "@/components/ui/styles";
import type { CustomerProject, ProjectStatus } from "@/types/customer";

const STATUS_OPTIONS: { value: ProjectStatus; label: string }[] = [
  { value: "active", label: "Active" },
  { value: "planned", label: "Planned" },
  { value: "on_hold", label: "On hold" },
  { value: "completed", label: "Completed" },
];

const TYPE_SUGGESTIONS = ["Migration", "Rollout", "Upgrade", "Build", "Maintenance", "Survey"];

// ISO timestamp → "yyyy-mm-dd" for <input type="date">.
const toDateInput = (iso: string | null) => (iso ? iso.slice(0, 10) : "");

// Add / edit a customer project — name, code (read-only, auto-allocated),
// type, start/end dates, status and description. (Internal PM assignment is
// handled later in the Job Pack, so it's deliberately not captured here.)
export function ProjectModal({
  customerId,
  project,
  onClose,
  onSaved,
}: {
  customerId: string;
  project: CustomerProject | null; // null = create
  onClose: () => void;
  onSaved: (p: CustomerProject) => void;
}) {
  const isEdit = Boolean(project);
  const [name, setName] = React.useState(project?.name ?? "");
  const [status, setStatus] = React.useState<ProjectStatus>(project?.status ?? "active");
  const [type, setType] = React.useState(project?.type ?? "");
  const [startDate, setStartDate] = React.useState(toDateInput(project?.startDate ?? null));
  const [endDate, setEndDate] = React.useState(toDateInput(project?.endDate ?? null));
  const [description, setDescription] = React.useState(project?.description ?? "");
  const [busy, setBusy] = React.useState(false);
  const [nameErr, setNameErr] = React.useState<string | undefined>();
  const [error, setError] = React.useState<string | null>(null);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setNameErr("Project name is required.");
      return;
    }
    if (startDate && endDate && endDate < startDate) {
      setError("End date can't be before the start date.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const payload = {
        name: name.trim(),
        status,
        type: type.trim() || undefined,
        startDate: startDate || undefined,
        endDate: endDate || undefined,
        description: description.trim() || undefined,
      };
      const saved =
        isEdit && project
          ? await customerService.updateProject(customerId, project.id, payload)
          : await customerService.addProject(customerId, payload);
      onSaved(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the project.");
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      title={isEdit ? "Edit project" : "Add project"}
      subtitle={project?.code ?? "A customer project — used when creating jobs."}
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy} className={ghostBtn}>
            Cancel
          </button>
          <button type="submit" form="project-form" disabled={busy} className={primaryBtn}>
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {isEdit ? "Save changes" : "Add project"}
          </button>
        </>
      }
    >
      <form id="project-form" onSubmit={save} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className={labelCls}>Project name<RequiredMark /></label>
            <input
              className={inputCls}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setNameErr(undefined);
              }}
              placeholder="e.g. BT Core Migration"
              maxLength={120}
              autoFocus
              aria-invalid={Boolean(nameErr)}
            />
            {nameErr && <p className="mt-1 text-[11px] font-semibold text-[var(--neg)]">{nameErr}</p>}
          </div>
          <div>
            <label className={labelCls}>Project type</label>
            <input
              className={inputCls}
              value={type}
              onChange={(e) => setType(e.target.value)}
              placeholder="e.g. Migration"
              list="project-type-options"
              maxLength={80}
            />
            <datalist id="project-type-options">
              {TYPE_SUGGESTIONS.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
          </div>
          <div>
            <label className={labelCls}>Status</label>
            <select
              className={inputCls}
              value={status}
              onChange={(e) => setStatus(e.target.value as ProjectStatus)}
            >
              {STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>Start date</label>
            <input
              type="date"
              className={inputCls}
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </div>
          <div>
            <label className={labelCls}>End date</label>
            <input
              type="date"
              className={inputCls}
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
            />
          </div>
          <div className="sm:col-span-2">
            <label className={labelCls}>Description</label>
            <textarea
              className={inputCls}
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional — scope / notes for this project."
              maxLength={2000}
            />
          </div>
        </div>

        {error && <p className="text-sm font-semibold text-[var(--neg)]">{error}</p>}
      </form>
    </Modal>
  );
}
