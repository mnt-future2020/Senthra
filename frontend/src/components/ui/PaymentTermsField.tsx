"use client";

import * as React from "react";

import { inputCls } from "@/components/ui/styles";
import { Select } from "@/components/ui/Select";
import { CUSTOM_PAYMENT_TERM, PAYMENT_TERMS_SELECT_OPTIONS, STANDARD_PAYMENT_TERMS } from "@/lib/paymentTerms";

const isStandardTerm = (v: string) => (STANDARD_PAYMENT_TERMS as readonly string[]).includes(v);

// A payment-terms control consistent with the Supplier form: a dropdown of standard terms plus a
// "Custom…" option that reveals a free-text input. It stores/returns ONE resolved string (the
// standard label or the custom text), so a PurchaseOrder/PurchaseRequest keeps its single
// `paymentTerms` field.
//
// The custom TEXT is held in LOCAL state so the input owns exactly what the user typed — untrimmed,
// and NOT reclassified while typing. (An earlier version derived the input from the trimmed parent
// value, which (a) ate trailing spaces every render and (b) collapsed the input the instant the
// typed text happened to equal a standard term.) The parent `value` is synced INTO local state only
// when it changes EXTERNALLY (e.g. a supplier-default prefill) — detected by comparing against the
// last value we emitted. This is the sanctioned "adjust state on prop change during render" pattern
// (a conditional setState in render, which React supports), so there is no effect and no ref write.
export function PaymentTermsField({
  value,
  onChange,
  placeholder = "— Select payment terms —",
  ariaLabel = "Payment terms",
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  ariaLabel?: string;
}) {
  // `customMode` = the "Custom…" option is selected (the free-text input is shown).
  // `customText` = exactly what the user typed in that input (untrimmed).
  const seed = value.trim();
  const [customMode, setCustomMode] = React.useState(Boolean(seed) && !isStandardTerm(seed));
  const [customText, setCustomText] = React.useState(customMode ? value : "");
  // Remember the value we last pushed up, to tell our own edits apart from an external change.
  const [lastEmitted, setLastEmitted] = React.useState(value);

  // External change (parent set `value` to something we didn't emit — e.g. a supplier prefill or a
  // reset): re-derive mode + custom text from it. Runs during render, not in an effect.
  if (value !== lastEmitted) {
    setLastEmitted(value);
    const v = value.trim();
    const nowCustom = Boolean(v) && !isStandardTerm(v);
    setCustomMode(nowCustom);
    setCustomText(nowCustom ? value : "");
  }

  const emit = (next: string) => {
    setLastEmitted(next);
    onChange(next);
  };

  const onPickTerm = (picked: string) => {
    if (picked === CUSTOM_PAYMENT_TERM) {
      setCustomMode(true);
      setCustomText("");
      emit(""); // enter Custom with an empty term until the user types
    } else {
      setCustomMode(false);
      setCustomText("");
      emit(picked); // a standard term (or "" when cleared)
    }
  };

  const onTypeCustom = (text: string) => {
    setCustomText(text);
    emit(text);
  };

  const selectValue = customMode ? CUSTOM_PAYMENT_TERM : value;

  return (
    <div className="flex flex-col gap-2">
      <Select value={selectValue} onChange={onPickTerm} options={PAYMENT_TERMS_SELECT_OPTIONS} placeholder={placeholder} ariaLabel={ariaLabel} />
      {customMode && (
        <input
          className={inputCls}
          value={customText}
          onChange={(e) => onTypeCustom(e.target.value)}
          maxLength={100}
          placeholder="e.g. 50% up front, 50% on delivery"
          aria-label="Custom payment terms"
          autoFocus
        />
      )}
    </div>
  );
}
