"use client";

import * as React from "react";
import { Eye, EyeOff } from "lucide-react";

import { inputCls } from "./styles";

type PasswordInputProps = Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "type"
>;

// Password field with a built-in show/hide toggle. Used across every settings
// form so reveal behaviour stays consistent.
export function PasswordInput({ className, ...props }: PasswordInputProps) {
  const [show, setShow] = React.useState(false);

  return (
    <div className="relative">
      <input
        {...props}
        type={show ? "text" : "password"}
        className={`${inputCls} pr-10 ${className ?? ""}`}
      />
      <button
        type="button"
        onClick={() => setShow((v) => !v)}
        aria-label={show ? "Hide password" : "Show password"}
        className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--faint)] transition-colors hover:text-[var(--ink)]"
      >
        {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  );
}
