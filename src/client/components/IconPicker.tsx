import { ICON_NAMES, isKnownIcon } from "@shared/icons";
import { useId, useMemo, useState } from "react";
import { cn } from "../lib/cn";
import { iconComponent } from "./CategoryIcon";
import { fieldClass } from "./ui/input";

type IconPickerProps = {
  value: string | null;
  onChange: (icon: string) => void;
  /** Tints the selected icon, so the choice previews in the category's colour. */
  colour?: string | null;
  label?: string;
  className?: string;
};

/** "IconToolsKitchen2" → "tools kitchen 2", for search and accessible names. */
function words(name: string): string {
  return name
    .replace(/^Icon/, "")
    .replace(/([a-z])([A-Z0-9])/g, "$1 $2")
    .toLowerCase();
}

/** A searchable radio grid of the curated Tabler icons. An unknown stored name stays selectable. */
export function IconPicker({ value, onChange, colour, label = "Icon", className }: IconPickerProps) {
  const name = useId();
  const [query, setQuery] = useState("");
  const names = useMemo(() => {
    const all: string[] = value && !isKnownIcon(value) ? [value, ...ICON_NAMES] : [...ICON_NAMES];
    const q = query.trim().toLowerCase();
    return q ? all.filter((n) => words(n).includes(q)) : all;
  }, [query, value]);

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search icons"
        aria-label={`Search ${label.toLowerCase()}s`}
        className={fieldClass}
      />
      <div
        role="radiogroup"
        aria-label={label}
        className="grid max-h-60 grid-cols-7 gap-1 overflow-y-auto sm:grid-cols-9"
      >
        {names.map((n) => {
          const Glyph = iconComponent(n);
          const selected = n === value;
          return (
            <label
              key={n}
              title={words(n)}
              className={cn(
                "flex aspect-square min-h-10 cursor-pointer items-center justify-center text-muted hover:text-fg",
                "has-checked:bg-surface has-checked:text-fg has-checked:outline-1 has-checked:outline-fg",
                "has-focus-visible:outline-2 has-focus-visible:outline-fg",
              )}
              style={selected && colour ? { color: colour } : undefined}
            >
              <input
                type="radio"
                name={name}
                value={n}
                checked={selected}
                onChange={() => onChange(n)}
                className="sr-only"
                aria-label={words(n)}
              />
              <Glyph size={22} stroke={1.5} aria-hidden="true" />
            </label>
          );
        })}
        {names.length === 0 && <p className="col-span-full py-4 text-sm text-muted">No icon matches.</p>}
      </div>
    </div>
  );
}
