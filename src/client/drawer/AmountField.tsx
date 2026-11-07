import { CURRENCY_CODES, type CurrencyCode } from "@shared/money";
import { useEffect, useId, useRef } from "react";
import { fieldClass } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { cn } from "../lib/cn";

type AmountFieldProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  /** Shows a currency select next to the amount; omit for a fixed currency (shown as a suffix). */
  currency: CurrencyCode;
  onCurrencyChange?: (currency: CurrencyCode) => void;
  /** Focus on mount: the first thing a partner types is the amount. */
  autoFocus?: boolean;
  hint?: string;
  large?: boolean;
};

/** A decimal amount input (numeric keyboard on phones) with its currency. */
export function AmountField({
  label,
  value,
  onChange,
  error,
  currency,
  onCurrencyChange,
  autoFocus,
  hint,
  large,
}: AmountFieldProps) {
  const id = useId();
  const ref = useRef<HTMLInputElement>(null);
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex items-end gap-3">
        <input
          ref={ref}
          id={id}
          data-autofocus={autoFocus ? "" : undefined}
          inputMode="decimal"
          autoComplete="off"
          placeholder="0"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={cn(error && errorId, hint && hintId) || undefined}
          className={cn(fieldClass, "font-numbers", large && "text-4xl")}
        />
        {onCurrencyChange ? (
          <select
            aria-label={`${label} currency`}
            value={currency}
            onChange={(e) => onCurrencyChange(e.target.value as CurrencyCode)}
            className={cn(fieldClass, "w-24 shrink-0 font-numbers")}
          >
            {CURRENCY_CODES.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        ) : (
          <span className="shrink-0 pb-2 font-numbers text-muted">{currency}</span>
        )}
      </div>
      {hint && (
        <p id={hintId} className="text-sm text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-sm text-negative">
          {error}
        </p>
      )}
    </div>
  );
}
