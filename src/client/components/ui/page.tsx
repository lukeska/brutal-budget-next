import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

type PageProps = {
  title: ReactNode;
  /** Buttons on the right of the title. */
  actions?: ReactNode;
  /** A period stepper (previous / current / next) under the title. */
  stepper?: ReactNode;
  children: ReactNode;
  className?: string;
};

/** The frame of every screen: a page header and its content, inside the shell's width. */
export function Page({ title, actions, stepper, children, className }: PageProps) {
  return (
    <main className={cn("mx-auto w-full max-w-5xl px-4 pt-6 pb-28 md:px-8 md:pb-12", className)}>
      <header className="flex flex-col gap-3 border-b border-rule pb-4">
        <div className="flex items-center justify-between gap-4">
          <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">{title}</h1>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>
        {stepper}
      </header>
      <div className="pt-6">{children}</div>
    </main>
  );
}
