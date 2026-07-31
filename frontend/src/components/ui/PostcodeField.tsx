"use client";

import * as React from "react";
import { Loader2, Search } from "lucide-react";

import * as geoService from "@/services/geo.service";
import { formatUkPostcode } from "@/lib/validation";
import { inputCls, labelCls } from "./styles";
import { RequiredMark } from "./FormScaffold";

type Setter = React.Dispatch<React.SetStateAction<string>>;

interface PostcodeFieldProps {
  value: string;
  // Parent updates its own postcode state (and typically clears its postcode error).
  onChange: (next: string) => void;
  setCity: Setter;
  // Optional — forms without a County / Country field simply omit these.
  setCounty?: Setter;
  setCountry?: Setter;
  // Called after a successful fill so the parent can clear City/Country errors.
  onResolved?: () => void;
  error?: string;
  label?: string;
  // MANDATORY, not defaulted. This drives the red asterisk, and a default of `true` meant that
  // simply FORGETTING the prop asserted "this field is required" — which is how the customer form
  // ended up marking an optional postcode as mandatory while nothing on either side enforced it.
  // A marker that isn't backed by a rule is worse than no marker, so the compiler now asks.
  required: boolean;
  errorId?: string;
  // The host form has no City/County fields to populate — the lookup becomes a confirm-only check that
  // reports the resolved place (e.g. "Found: Leeds, West Yorkshire") rather than claiming it filled any
  // fields. Used by address-lite forms (customer sites, job Site & location).
  confirmOnly?: boolean;
}

// Postcode input + "Find address" button that fills City/County (and confirms Country)
// from postcodes.io via the backend. Shared across the warehouse, supplier, customer
// and user forms so the behaviour and look stay identical. Street (address line 1) is
// never returned by the lookup, so it stays manual. UK-only.
export function PostcodeField({
  value,
  onChange,
  setCity,
  setCounty,
  setCountry,
  onResolved,
  error,
  label = "Postcode",
  required,
  errorId = "err-postcode",
  confirmOnly = false,
}: PostcodeFieldProps) {
  const [lookingUp, setLookingUp] = React.useState(false);
  const [lookupMsg, setLookupMsg] = React.useState<string | null>(null);
  // What the last lookup auto-filled, so editing the postcode can invalidate it
  // without ever wiping a value the user typed by hand.
  const autofilledRef = React.useRef<{ city: string; county: string } | null>(null);

  const handleChange = (next: string) => {
    // Uppercase live — postcodes are always displayed in caps and this is length-preserving,
    // so the caret never jumps. The space is NOT inserted here: doing that mid-typing would
    // shift the caret under the user. Canonical spacing is applied on blur instead.
    onChange(next.toUpperCase());
    setLookupMsg(null);
    const af = autofilledRef.current;
    if (af) {
      setCity((c) => (c === af.city ? "" : c));
      setCounty?.((c) => (c === af.county ? "" : c));
      autofilledRef.current = null;
    }
  };

  // Finish the job once the user leaves the field: "LS14DY" → "LS1 4DY". Calls onChange
  // DIRECTLY rather than going through handleChange — this is a reformat of the same postcode,
  // not an edit, so it must not discard a City/County that was just auto-filled from it.
  const handleBlur = () => {
    const formatted = formatUkPostcode(value);
    if (formatted !== value) onChange(formatted);
  };

  const findAddress = async () => {
    const code = value.trim();
    if (!code) {
      setLookupMsg("Enter a postcode first.");
      return;
    }
    setLookingUp(true);
    setLookupMsg(null);
    try {
      const result = await geoService.lookupPostcode(code);
      if (!result) {
        autofilledRef.current = null;
        setLookupMsg("Couldn't find that postcode — enter the address manually.");
        return;
      }
      // A confirmed postcode is worth normalising immediately (not just on blur) — the user
      // has proof it's real. Direct onChange: this is a reformat, not an edit, so it must not
      // wipe the City/County being filled in on the next lines.
      const formatted = formatUkPostcode(code);
      if (formatted !== value) onChange(formatted);
      const filledCity = result.city ?? "";
      const filledCounty = result.county ?? "";
      if (result.city) setCity(result.city);
      if (result.county && setCounty) setCounty(result.county);
      setCountry?.("United Kingdom");
      autofilledRef.current = { city: filledCity, county: filledCounty };
      onResolved?.();
      if (confirmOnly) {
        // No City/County fields to fill — confirm the resolved place instead of claiming a fill.
        const place = [result.city, result.county].filter(Boolean).join(", ");
        setLookupMsg(place ? `Found: ${place}.` : "Postcode recognised.");
      } else {
        setLookupMsg("Filled from postcode — check and adjust if needed.");
      }
    } catch {
      setLookupMsg("Couldn't look up that postcode right now.");
    } finally {
      setLookingUp(false);
    }
  };

  return (
    <div>
      <label className={labelCls}>
        {label}
        {required && <RequiredMark />}
      </label>
      <div className="flex items-stretch gap-2">
        <input
          className={`${inputCls} min-w-0 flex-1`}
          value={value}
          onChange={(e) => handleChange(e.target.value)}
          onBlur={handleBlur}
          placeholder="e.g. LS1 4DY"
          maxLength={12}
          autoComplete="postal-code"
          // Mobile keyboards: start in caps and stop autocorrect "fixing" a postcode.
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          aria-invalid={Boolean(error)}
        />
        <button
          type="button"
          onClick={findAddress}
          disabled={lookingUp || !value.trim()}
          title="Find address from postcode — fills City & County"
          aria-label="Find address from postcode"
          className="flex shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-xl bg-[var(--accent-10)] px-4 text-xs font-bold text-[var(--accent)] shadow-xs transition-all hover:bg-[var(--accent)] hover:text-white disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-[var(--accent-10)] disabled:hover:text-[var(--accent)]"
        >
          {lookingUp ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" /> : <Search className="h-3.5 w-3.5 shrink-0" />}
          Find
        </button>
      </div>
      {error && <p id={errorId} className="mt-1.5 text-[11px] font-semibold text-[var(--neg)]">{error}</p>}
      {lookupMsg && <p className="mt-1.5 text-[11px] text-[var(--muted)]">{lookupMsg}</p>}
    </div>
  );
}
