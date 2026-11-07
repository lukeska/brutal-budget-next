import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

type EmptyProps = { title: string; children?: ReactNode; action?: ReactNode; className?: string };

/** What a list shows when it has nothing in it: one plain line, an optional hint and action. */
export function Empty({ title, children, action, className }: EmptyProps) {
  return (
    <div className={cn("flex flex-col items-start gap-2 border-t border-rule py-10", className)}>
      <p className="text-lg text-fg">{title}</p>
      {children && <div className="text-sm text-muted">{children}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
