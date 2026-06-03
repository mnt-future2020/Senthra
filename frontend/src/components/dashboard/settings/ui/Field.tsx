import * as React from "react";

import { hintCls, labelCls } from "./styles";

// Props we may read from / inject into the wrapped control.
type ControlProps = {
  id?: string;
  role?: string;
  "aria-describedby"?: string;
};

// Native elements that a <label htmlFor> can be associated with directly.
const LABELABLE_TAGS = new Set(["input", "select", "textarea"]);

/**
 * A labelled form field with optional helper text underneath.
 *
 * Standardises the "label → control → hint" rhythm across every settings form so
 * each field can describe, in plain language, what it does — and wires it up for
 * assistive tech:
 *
 *  - A single form control (input / select / textarea / PasswordInput) is linked
 *    to the label via `htmlFor`/`id`, and to the hint via `aria-describedby`.
 *  - A composite child (a row of buttons, an input + action) is exposed as an
 *    `aria` group labelled by the field label and described by the hint.
 */
export function Field({
  label,
  hint,
  required,
  children,
}: {
  label: React.ReactNode;
  /** Short, user-friendly description of what this field controls. */
  hint?: React.ReactNode;
  /** Shows a subtle required mark next to the label. */
  required?: boolean;
  children: React.ReactNode;
}) {
  const uid = React.useId();
  const controlId = `field-${uid}`;
  const labelId = `label-${uid}`;
  const hintId = hint ? `hint-${uid}` : undefined;

  const child = React.isValidElement<ControlProps>(children) ? children : null;

  // A single labelable control if it's a native input/select/textarea, or a
  // component (e.g. PasswordInput) that forwards props to one. A plain wrapper
  // element (typically a <div> grouping buttons) is treated as a group instead.
  const isControl =
    child != null &&
    (typeof child.type !== "string" || LABELABLE_TAGS.has(child.type));

  let rendered: React.ReactNode = children;
  let labelFor: string | undefined;

  if (child) {
    const describedBy =
      [child.props["aria-describedby"], hintId].filter(Boolean).join(" ") ||
      undefined;

    if (isControl) {
      const id = child.props.id ?? controlId;
      labelFor = id;
      rendered = React.cloneElement(child, { id, "aria-describedby": describedBy });
    } else {
      rendered = React.cloneElement(child, {
        role: child.props.role ?? "group",
        "aria-labelledby": labelId,
        "aria-describedby": describedBy,
      } as ControlProps & { "aria-labelledby": string });
    }
  }

  return (
    <div>
      <label id={labelId} htmlFor={labelFor} className={labelCls}>
        {label}
        {required && <span className="ml-0.5 text-[var(--accent)]">*</span>}
      </label>
      {rendered}
      {hint && (
        <p id={hintId} className={hintCls}>
          {hint}
        </p>
      )}
    </div>
  );
}
