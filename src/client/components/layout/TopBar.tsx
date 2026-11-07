import { AddButton } from "../AddButton";
import { Button } from "../ui/button";
import { NavLinks, useLogout } from "./nav";

/** Desktop navigation (md and wider): brand, sections, "+ Add", log out. */
export function TopBar() {
  const logout = useLogout();
  return (
    <header className="sticky top-0 z-40 border-b border-rule bg-bg">
      <div className="mx-auto flex max-w-5xl items-center gap-8 px-8">
        <span className="font-numbers text-lg font-semibold tracking-tight">Brutal Budget</span>
        <nav aria-label="Main" className="flex-1">
          <NavLinks className="flex items-center gap-6 text-sm" />
        </nav>
        <div className="flex items-center gap-2">
          <AddButton variant="bar" />
          <Button variant="ghost" size="sm" onClick={logout}>
            Log out
          </Button>
        </div>
      </div>
    </header>
  );
}
