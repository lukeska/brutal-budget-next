import type { Category, CategoryType } from "@shared/schemas/category";
import { CategoryIcon } from "../components/CategoryIcon";
import { activeCategories, useCategories } from "../features/categories/api";
import { cn } from "../lib/cn";

type CategoryPickerProps = {
  type: CategoryType;
  value: string;
  onChange: (categoryId: string) => void;
  /** The partner's most used categories for this type, most used first. */
  topIds: string[];
  error?: string;
};

function CategoryButton({
  category,
  selected,
  onSelect,
  chip,
  indent,
}: {
  category: Category;
  selected: boolean;
  onSelect: () => void;
  chip?: boolean;
  indent?: boolean;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        "flex min-h-11 items-center gap-2 text-left text-sm transition-colors",
        "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-fg",
        chip ? "border border-rule px-2 hover:border-fg" : "w-full px-1 hover:bg-surface",
        indent && "pl-8",
        selected && "bg-fg text-bg hover:bg-fg",
      )}
    >
      <CategoryIcon icon={category.icon} colour={category.colour} size="sm" />
      <span className="truncate">{category.name}</span>
    </button>
  );
}

/**
 * Category is required and never preselected. The partner's most used categories sit on top as
 * one-tap chips; below them the full list, subcategories indented under their parent.
 */
export function CategoryPicker({ type, value, onChange, topIds, error }: CategoryPickerProps) {
  const { data, isPending, isError } = useCategories(type);
  const tree = activeCategories(data ?? []);
  const byId = new Map<string, Category>();
  for (const parent of tree) {
    byId.set(parent.id, parent);
    for (const child of parent.children) byId.set(child.id, child);
  }
  const chips = topIds
    .map((id) => byId.get(id))
    .filter((c): c is Category => c !== undefined)
    .slice(0, 5);

  return (
    <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
      <legend className="mb-2 text-sm text-muted">Category</legend>
      {chips.length > 0 && (
        <fieldset className="m-0 flex min-w-0 flex-wrap gap-2 border-0 p-0">
          <legend className="sr-only">Most used categories</legend>
          {chips.map((c) => (
            <CategoryButton
              key={c.id}
              category={c}
              chip
              selected={c.id === value}
              onSelect={() => onChange(c.id)}
            />
          ))}
        </fieldset>
      )}
      {isPending && <p className="text-sm text-muted">Loading categories…</p>}
      {isError && <p className="text-sm text-negative">Couldn't load categories</p>}
      {!isPending && !isError && tree.length === 0 && (
        <p className="text-sm text-muted">No {type} categories yet — add one in Categories.</p>
      )}
      {tree.length > 0 && (
        <ul
          aria-label="All categories"
          className="flex max-h-72 flex-col overflow-y-auto border-y border-rule"
        >
          {tree.map((parent) => (
            <li key={parent.id}>
              <CategoryButton
                category={parent}
                selected={parent.id === value}
                onSelect={() => onChange(parent.id)}
              />
              {parent.children.length > 0 && (
                <ul>
                  {parent.children.map((child) => (
                    <li key={child.id}>
                      <CategoryButton
                        category={child}
                        indent
                        selected={child.id === value}
                        onSelect={() => onChange(child.id)}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
      {error && <p className="text-sm text-negative">{error}</p>}
    </fieldset>
  );
}
