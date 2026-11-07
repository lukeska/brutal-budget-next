import type { ComponentProps } from "react";
import { cn } from "../../lib/cn";

/** Shared field look: a single bottom rule, no box. */
export const fieldClass =
  "min-h-11 w-full border-0 border-b border-rule bg-transparent py-2 text-base text-fg outline-none " +
  "placeholder:text-faint focus-visible:border-fg focus-visible:shadow-[0_1px_0_0_var(--color-fg)] " +
  "disabled:opacity-40 aria-invalid:border-negative";

export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input className={cn(fieldClass, className)} {...props} />;
}
