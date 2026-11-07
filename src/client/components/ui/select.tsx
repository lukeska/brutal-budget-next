import type { ComponentProps } from "react";
import { cn } from "../../lib/cn";
import { fieldClass } from "./input";

/** A native <select> (best on phones) with the field look and a thin chevron. */
export function Select({ className, children, ...props }: ComponentProps<"select">) {
  return (
    <div className="relative">
      <select className={cn(fieldClass, "appearance-none pr-8", className)} {...props}>
        {children}
      </select>
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className="pointer-events-none absolute top-1/2 right-1 size-4 -translate-y-1/2 text-muted"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      >
        <path d="M6 9l6 6 6-6" />
      </svg>
    </div>
  );
}
