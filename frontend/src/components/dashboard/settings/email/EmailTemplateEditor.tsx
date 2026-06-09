"use client";

import * as React from "react";
import {
  ArrowLeft,
  Copy,
  Eye,
  FileText,
  Loader2,
  Lock,
  RotateCcw,
  Send,
  Trash2,
} from "lucide-react";

import * as templateService from "@/services/emailTemplate.service";
import { useAuth } from "@/hooks/useAuth";
import type { EmailPreview, EmailTemplate } from "@/types/emailTemplate";
import { Field } from "@/components/ui/Field";
import { ReadOnlyNotice } from "@/components/dashboard/settings/ui/ReadOnlyNotice";
import { Notice } from "@/components/ui/Notice";
import { ghostBtn, inputCls, labelCls, primaryBtn } from "@/components/ui/styles";
import type { Msg } from "@/components/ui/types";

type EditorTab = "message" | "preview";

const monoCls =
  "w-full rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3.5 font-mono text-xs leading-relaxed text-[var(--ink)] outline-none transition-all focus:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-60";

export function EmailTemplateEditor({
  template,
  onBack,
  onChanged,
}: {
  template: EmailTemplate;
  onBack: () => void;
  onChanged: () => void;
}) {
  const { can } = useAuth();
  const canManage = can("email_templates.manage");
  const [name, setName] = React.useState(template.name);
  const [subject, setSubject] = React.useState(template.subject);
  // The admin edits one plain-text "message"; the branded HTML is generated from
  // it server-side, so they never touch HTML.
  const [message, setMessage] = React.useState(template.textContent);

  // Re-seed the form when a different template is opened in the same editor
  // instance (the parent reuses this component across selections). Keyed on the
  // template id only, so a version bump after the user's own save doesn't wipe
  // their in-progress edits.
  const loadedId = React.useRef(template.id);
  React.useEffect(() => {
    if (loadedId.current === template.id) return;
    loadedId.current = template.id;
    setName(template.name);
    setSubject(template.subject);
    setMessage(template.textContent);
  }, [template.id, template.name, template.subject, template.textContent]);

  const [tab, setTab] = React.useState<EditorTab>("message");
  const [preview, setPreview] = React.useState<EmailPreview | null>(null);
  const [previewLoading, setPreviewLoading] = React.useState(false);

  const [saving, setSaving] = React.useState(false);
  const [testing, setTesting] = React.useState(false);
  const [testTo, setTestTo] = React.useState("");
  const [confirmAction, setConfirmAction] = React.useState<null | "restore" | "delete">(null);
  const [msg, setMsg] = React.useState<Msg>(null);

  const subjectRef = React.useRef<HTMLInputElement>(null);
  const messageRef = React.useRef<HTMLTextAreaElement>(null);
  const lastFocused = React.useRef<"subject" | "message">("message");

  // Auto-clear a pending destructive confirmation.
  React.useEffect(() => {
    if (!confirmAction) return;
    const t = setTimeout(() => setConfirmAction(null), 4000);
    return () => clearTimeout(t);
  }, [confirmAction]);

  const refreshPreview = React.useCallback(async () => {
    setPreviewLoading(true);
    try {
      setPreview(
        await templateService.previewTemplate(template.id, { subject, textContent: message }),
      );
    } catch {
      setPreview(null);
    } finally {
      setPreviewLoading(false);
    }
  }, [template.id, subject, message]);

  const openTab = (next: EditorTab) => {
    setTab(next);
    if (next === "preview") refreshPreview();
  };

  const insertVariable = (variable: string) => {
    const token = `{{${variable}}}`;
    const el = lastFocused.current === "subject" ? subjectRef.current : messageRef.current;
    const setter = lastFocused.current === "subject" ? setSubject : setMessage;
    if (!el) {
      setter((prev) => prev + token);
      return;
    }
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    setter(el.value.slice(0, start) + token + el.value.slice(end));
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + token.length;
      el.setSelectionRange(pos, pos);
    });
  };

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      await templateService.updateTemplate(template.id, { name, subject, textContent: message });
      setMsg({ type: "success", text: "Template saved." });
      onChanged();
    } catch (e) {
      setMsg({ type: "error", text: e instanceof Error ? e.message : "Save failed." });
    } finally {
      setSaving(false);
    }
  };

  // Save the current edits first, then send a test of them.
  const sendTest = async () => {
    if (!testTo.trim()) {
      setMsg({ type: "error", text: "Enter an address to send the test to." });
      return;
    }
    setTesting(true);
    setMsg(null);
    try {
      await templateService.updateTemplate(template.id, { name, subject, textContent: message });
      const res = await templateService.sendTest(template.id, testTo.trim());
      setMsg({ type: "success", text: res.message });
      onChanged();
    } catch (e) {
      setMsg({ type: "error", text: e instanceof Error ? e.message : "Test failed." });
    } finally {
      setTesting(false);
    }
  };

  const duplicate = async () => {
    setMsg(null);
    try {
      await templateService.duplicateTemplate(template.id);
      onChanged();
      setMsg({ type: "success", text: "Duplicated — find the copy in the list." });
    } catch (e) {
      setMsg({ type: "error", text: e instanceof Error ? e.message : "Duplicate failed." });
    }
  };

  const doRestore = async () => {
    setConfirmAction(null);
    setSaving(true);
    setMsg(null);
    try {
      const t = await templateService.restoreDefault(template.id);
      setName(t.name);
      setSubject(t.subject);
      setMessage(t.textContent);
      setMsg({ type: "success", text: "Default content restored." });
      onChanged();
    } catch (e) {
      setMsg({ type: "error", text: e instanceof Error ? e.message : "Restore failed." });
    } finally {
      setSaving(false);
    }
  };

  const doDelete = async () => {
    setConfirmAction(null);
    try {
      await templateService.deleteTemplate(template.id);
      onChanged();
      onBack();
    } catch (e) {
      setMsg({ type: "error", text: e instanceof Error ? e.message : "Delete failed." });
    }
  };

  const tabs: { id: EditorTab; label: string; icon: React.ElementType }[] = [
    { id: "message", label: "Message", icon: FileText },
    { id: "preview", label: "Preview", icon: Eye },
  ];

  return (
    <section
      className="border border-[var(--border)] bg-[var(--surface)] p-6 shadow-xs md:p-7"
      style={{ borderRadius: "var(--radius)" }}
    >
      {/* Header */}
      <div className="mb-5 flex items-start gap-3">
        <button
          onClick={onBack}
          className="mt-0.5 rounded-lg p-1.5 text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--ink)]"
          aria-label="Back to templates"
        >
          <ArrowLeft className="h-4.5 w-4.5" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-extrabold tracking-tight text-[var(--ink)]">{name}</h2>
            <span className="rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wider text-[var(--muted)]">
              {template.category}
            </span>
            {template.isSystem && (
              <span className="inline-flex items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--surface-2)] px-2 py-0.5 text-[9px] font-extrabold uppercase tracking-wider text-[var(--muted)]">
                <Lock className="h-2.5 w-2.5" />
                System
              </span>
            )}
          </div>
          <p className="mt-1 font-mono text-[11px] text-[var(--faint)]">
            {template.key} · v{template.version}
          </p>
        </div>
      </div>

      <div className="space-y-4">
        {!canManage && (
          <ReadOnlyNotice>
            Read-only — you can view this template but don&apos;t have permission to change it.
          </ReadOnlyNotice>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Template name">
            <input
              className={inputCls}
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={!canManage}
            />
          </Field>
          <Field label="Subject" hint="The email subject line. Variables are allowed.">
            <input
              ref={subjectRef}
              className={inputCls}
              value={subject}
              onFocus={() => (lastFocused.current = "subject")}
              onChange={(e) => setSubject(e.target.value)}
              disabled={!canManage}
            />
          </Field>
        </div>

        {/* Variable chips */}
        {template.variables.length > 0 && (
          <div>
            <label className={labelCls}>Variables — click to insert</label>
            <div className="flex flex-wrap gap-1.5">
              {template.variables.map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => insertVariable(v)}
                  disabled={!canManage}
                  className="rounded-md border border-[var(--accent)]/30 bg-[var(--accent-10)] px-2 py-1 font-mono text-[11px] font-bold text-[var(--accent)] transition-all hover:bg-[var(--accent)] hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {`{{${v}}}`}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Message / Preview tabs */}
        <div>
          <div className="mb-2 flex gap-1 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-1">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => openTab(t.id)}
                className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition-all ${
                  tab === t.id
                    ? "bg-[var(--accent)] text-white shadow-xs"
                    : "text-[var(--muted)] hover:text-[var(--ink)]"
                }`}
              >
                <t.icon className="h-3.5 w-3.5" />
                {t.label}
              </button>
            ))}
          </div>

          {tab === "message" && (
            <>
              <textarea
                ref={messageRef}
                className={monoCls}
                rows={16}
                value={message}
                onFocus={() => (lastFocused.current = "message")}
                onChange={(e) => setMessage(e.target.value)}
                spellCheck
                disabled={!canManage}
                placeholder="Type the email message in plain text… a blank line starts a new paragraph."
              />
              <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--faint)]">
                Just type your message — we wrap it in the branded design automatically. A blank
                line starts a new paragraph, and links become clickable. Use the chips above to
                insert details like a name or password. Check the <strong className="text-[var(--muted)]">Preview</strong> to
                see exactly how it&apos;ll look.
              </p>
            </>
          )}
          {tab === "preview" && (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3.5 py-2">
                <div className="min-w-0">
                  <span className="text-[10px] font-extrabold uppercase tracking-wider text-[var(--faint)]">
                    Subject
                  </span>
                  <p className="truncate text-sm font-bold text-[var(--ink)]">
                    {preview?.subject ?? "—"}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={refreshPreview}
                  disabled={previewLoading}
                  className={ghostBtn}
                >
                  {previewLoading ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RotateCcw className="h-3.5 w-3.5" />
                  )}
                  Refresh
                </button>
              </div>
              <iframe
                title="Email preview"
                sandbox=""
                srcDoc={preview?.html ?? ""}
                className="h-[440px] w-full rounded-xl border border-[var(--border)] bg-white"
              />
              <p className="text-[11px] text-[var(--faint)]">
                This is exactly how recipients will see it. Sample values fill each variable.
              </p>
            </div>
          )}
        </div>

        <Notice msg={msg} />

        {/* Actions — hidden for view-only users (the API enforces this too). */}
        {canManage && (
        <div className="flex flex-wrap items-center gap-2 border-t border-[var(--border-2)] pt-4">
          <button onClick={save} disabled={saving} className={primaryBtn}>
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Save changes
          </button>
          <button type="button" onClick={duplicate} className={ghostBtn}>
            <Copy className="h-3.5 w-3.5" />
            Duplicate
          </button>
          {template.isSystem ? (
            <button
              type="button"
              onClick={() => (confirmAction === "restore" ? doRestore() : setConfirmAction("restore"))}
              className={`${ghostBtn} ${confirmAction === "restore" ? "border-[var(--accent)] text-[var(--accent)]" : ""}`}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              {confirmAction === "restore" ? "Click to confirm" : "Restore default"}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => (confirmAction === "delete" ? doDelete() : setConfirmAction("delete"))}
              className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-bold transition-all ${
                confirmAction === "delete"
                  ? "border-[var(--neg)] bg-[var(--neg)]/10 text-[var(--neg)]"
                  : "border-[var(--border)] bg-[var(--surface-2)] text-[var(--muted)] hover:text-[var(--neg)]"
              }`}
            >
              <Trash2 className="h-3.5 w-3.5" />
              {confirmAction === "delete" ? "Click to confirm" : "Delete"}
            </button>
          )}

          {/* Send test */}
          <div className="ml-auto flex w-full items-center gap-2 sm:w-auto">
            <input
              type="email"
              value={testTo}
              onChange={(e) => setTestTo(e.target.value)}
              placeholder="you@example.com"
              className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-xs text-[var(--ink)] outline-none focus:border-[var(--accent)] sm:w-48"
            />
            <button
              type="button"
              onClick={sendTest}
              disabled={testing}
              className={ghostBtn}
              title="Saves your changes, then sends a test"
            >
              {testing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Send className="h-3.5 w-3.5" />
              )}
              Save &amp; test
            </button>
          </div>
        </div>
        )}
      </div>
    </section>
  );
}
