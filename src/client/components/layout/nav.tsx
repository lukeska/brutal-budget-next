import { useQueryClient } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import { meQueryKey } from "../../features/auth/use-me";
import { api } from "../../lib/api";
import { cn } from "../../lib/cn";

export const NAV_ITEMS = [
  { to: "/", label: "Month" },
  { to: "/accounts", label: "Accounts" },
  { to: "/statistics", label: "Statistics" },
  { to: "/categories", label: "Categories" },
  { to: "/projects", label: "Projects" },
  { to: "/settings", label: "Settings" },
] as const;

type NavLinksProps = { className?: string; linkClassName?: string; onNavigate?: () => void };

/** The six sections. The current one gets aria-current="page" and an underline. */
export function NavLinks({ className, linkClassName, onNavigate }: NavLinksProps) {
  return (
    <ul className={className}>
      {NAV_ITEMS.map((item) => (
        <li key={item.to}>
          <Link
            to={item.to}
            activeOptions={{ exact: item.to === "/" }}
            onClick={onNavigate}
            className={cn(
              "flex min-h-11 items-center text-muted transition-colors hover:text-fg",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fg",
              "aria-[current=page]:text-fg aria-[current=page]:underline aria-[current=page]:decoration-1 aria-[current=page]:underline-offset-8",
              linkClassName,
            )}
          >
            {item.label}
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** Ends the session, drops every cached household number, and goes to the login screen. */
export function useLogout() {
  const queryClient = useQueryClient();
  const router = useRouter();
  return async () => {
    try {
      await api.post("/api/auth/logout");
    } finally {
      queryClient.clear();
      queryClient.setQueryData(meQueryKey, null);
      await router.navigate({ href: "/login" });
    }
  };
}
