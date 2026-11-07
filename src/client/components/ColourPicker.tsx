import { COLOUR_PALETTE, COLOURS } from "@shared/icons";
import { useId } from "react";
import { cn } from "../lib/cn";

type ColourPickerProps = {
  value: string | null;
  onChange: (colour: string) => void;
  label?: string;
  className?: string;
};

/**
 * The category palette as a radio grid: one row per shade, one column per hue. A stored colour
 * outside the palette (e.g. a starter category) stays selected and is shown first.
 */
export function ColourPicker({ value, onChange, label = "Colour", className }: ColourPickerProps) {
  const name = useId();
  const current = value?.toLowerCase() ?? null;
  const custom = current && !COLOURS.includes(current) ? current : null;
  const swatches = [
    ...(custom ? [{ hex: custom, title: "Current colour" }] : []),
    ...[0, 1, 2].flatMap((shade) =>
      COLOUR_PALETTE.map((h) => ({
        hex: h.shades[shade] as string,
        title: `${h.hue} ${["light", "", "dark"][shade]}`.trim(),
      })),
    ),
  ];
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn("grid grid-cols-9 gap-1.5 sm:grid-cols-[repeat(17,minmax(0,1fr))]", className)}
    >
      {swatches.map(({ hex, title }) => (
        <label
          key={hex}
          title={title}
          className={cn(
            "relative aspect-square min-h-7 cursor-pointer outline-offset-2",
            "has-checked:outline-2 has-checked:outline-fg has-focus-visible:outline-2 has-focus-visible:outline-fg",
          )}
          style={{ backgroundColor: hex }}
        >
          <input
            type="radio"
            name={name}
            value={hex}
            checked={current === hex}
            onChange={() => onChange(hex)}
            className="sr-only"
            aria-label={title}
          />
        </label>
      ))}
    </div>
  );
}
