import { type CurrencyCode, formatMinor } from "@shared/money";
import { cn } from "../../lib/cn";

type MoneyProps = {
  minor: number;
  currency: CurrencyCode;
  /** Show "+" / "−" and colour the amount green or red. The sign is always there, never colour alone. */
  signed?: boolean;
  className?: string;
};

const MINUS = "−";

export function Money({ minor, currency, signed = false, className }: MoneyProps) {
  const magnitude = formatMinor(Math.abs(minor), currency);
  const sign = minor < 0 ? MINUS : signed && minor > 0 ? "+" : "";
  return (
    <span
      className={cn(
        "font-numbers whitespace-nowrap",
        signed && minor > 0 && "text-positive",
        signed && minor < 0 && "text-negative",
        className,
      )}
    >
      {sign}
      {magnitude}
    </span>
  );
}
