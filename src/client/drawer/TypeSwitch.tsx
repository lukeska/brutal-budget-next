import { Segmented } from "../components/ui/segmented";
import type { EntryKind } from "./store";

const OPTIONS = [
  { value: "expense", label: "Expense" },
  { value: "income", label: "Income" },
  { value: "transfer", label: "Transfer" },
] as const;

/** Expense / Income / Transfer for a new entry. A saved entry's type is fixed, so editing never shows it. */
export function TypeSwitch({ value, onChange }: { value: EntryKind; onChange: (kind: EntryKind) => void }) {
  return <Segmented options={OPTIONS} value={value} onChange={onChange} aria-label="Entry type" />;
}
