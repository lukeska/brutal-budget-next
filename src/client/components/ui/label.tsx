import type { ComponentProps } from "react";
import { cn } from "../../lib/cn";

export function Label({ className, ...props }: ComponentProps<"label">) {
  // biome-ignore lint/a11y/noLabelWithoutControl: callers pass htmlFor or wrap the control.
  return <label className={cn("text-sm text-muted", className)} {...props} />;
}
