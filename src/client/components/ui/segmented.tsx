import { useId } from "react";
import { cn } from "../../lib/cn";

export type SegmentedOption<T extends string> = { value: T; label: string; disabled?: boolean };

type SegmentedProps<T extends string> = {
  options: ReadonlyArray<SegmentedOption<T>>;
  value: T;
  onChange: (value: T) => void;
  "aria-label": string;
  className?: string;
};

/**
 * Joined segments built on native radio inputs, so arrow keys, Tab and screen readers
 * behave like any radio group.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  className,
  "aria-label": ariaLabel,
}: SegmentedProps<T>) {
  const name = useId();
  return (
    <div role="radiogroup" aria-label={ariaLabel} className={cn("flex border border-rule", className)}>
      {options.map((option) => (
        <label
          key={option.value}
          className={cn(
            "relative flex min-h-11 flex-1 cursor-pointer items-center justify-center px-3 text-sm font-medium",
            "text-muted transition-colors not-first:border-l not-first:border-rule hover:text-fg",
            "has-checked:bg-fg has-checked:text-bg has-disabled:cursor-not-allowed has-disabled:opacity-40",
            "has-focus-visible:outline-2 has-focus-visible:-outline-offset-2 has-focus-visible:outline-fg",
          )}
        >
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={option.value === value}
            disabled={option.disabled}
            onChange={() => onChange(option.value)}
            className="sr-only"
          />
          {option.label}
        </label>
      ))}
    </div>
  );
}
