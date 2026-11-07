import type { Category, CategoryNode, CategoryType } from "@shared/schemas/category";
import { createFileRoute, Link } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useState } from "react";
import { v7 as uuidv7 } from "uuid";
import { CategoryIcon } from "../../components/CategoryIcon";
import { ColourPicker } from "../../components/ColourPicker";
import { IconPicker } from "../../components/IconPicker";
import { Button } from "../../components/ui/button";
import { Empty } from "../../components/ui/empty";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Page } from "../../components/ui/page";
import { Segmented } from "../../components/ui/segmented";
import { Select } from "../../components/ui/select";
import { Sheet } from "../../components/ui/sheet";
import { toast } from "../../components/ui/toast";
import {
  useCategories,
  useCreateCategory,
  useDeleteCategory,
  useMergeCategory,
  useUpdateCategory,
} from "../../features/categories/api";
import { ApiError } from "../../lib/api";
import { cn } from "../../lib/cn";

export const Route = createFileRoute("/categories/")({
  component: CategoriesPage,
});

const TYPES = [
  { value: "expense", label: "Expenses" },
  { value: "income", label: "Income" },
] as const;

/** What the sheet is doing: adding a top-level category, a subcategory, or editing one. */
type Editing =
  | { mode: "create"; parent: CategoryNode | null }
  | { mode: "edit"; category: Category; parent: CategoryNode | null; node: CategoryNode | null };

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const body = err.body as { message?: string; issues?: { message: string }[] } | null;
    if (body?.issues?.[0]) return body.issues[0].message;
    if (body?.message) return body.message;
  }
  return "Something went wrong — try again";
}

function CategoriesPage() {
  const [type, setType] = useState<CategoryType>("expense");
  const { data: tree, isPending, isError } = useCategories(type);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [merging, setMerging] = useState<{ source: Category; node: CategoryNode | null } | null>(null);

  const active = tree?.filter((c) => !c.archived) ?? [];
  const archived = tree?.filter((c) => c.archived) ?? [];

  return (
    <Page
      title="Categories"
      actions={
        <Button size="sm" onClick={() => setEditing({ mode: "create", parent: null })}>
          Add category
        </Button>
      }
    >
      <Segmented
        options={TYPES}
        value={type}
        onChange={setType}
        aria-label="Category type"
        className="mb-6 max-w-xs"
      />
      {isPending && <p className="text-muted">Loading…</p>}
      {isError && <p className="text-negative">Couldn't load categories.</p>}
      {tree && tree.length === 0 && <Empty title={`No ${type} categories yet.`} />}
      <CategoryTree nodes={active} onEdit={setEditing} />
      {archived.length > 0 && (
        <section className="mt-10">
          <h2 className="mb-2 text-sm text-muted">Archived</h2>
          <CategoryTree nodes={archived} onEdit={setEditing} />
        </section>
      )}

      {editing && (
        <CategorySheet
          key={editing.mode === "edit" ? editing.category.id : `new-${editing.parent?.id ?? "top"}`}
          type={type}
          editing={editing}
          onClose={() => setEditing(null)}
          onMerge={(source, node) => {
            setEditing(null);
            setMerging({ source, node });
          }}
        />
      )}
      {merging && tree && (
        <MergeSheet
          source={merging.source}
          node={merging.node}
          tree={tree}
          onClose={() => setMerging(null)}
        />
      )}
    </Page>
  );
}

function CategoryTree({ nodes, onEdit }: { nodes: CategoryNode[]; onEdit: (e: Editing) => void }) {
  return (
    <ul className="border-t border-rule">
      {nodes.map((node) => (
        <li key={node.id} className="border-b border-rule">
          <Row
            category={node}
            onEdit={() => onEdit({ mode: "edit", category: node, parent: null, node })}
            extra={
              !node.archived && (
                <Button variant="ghost" size="sm" onClick={() => onEdit({ mode: "create", parent: node })}>
                  Add sub
                </Button>
              )
            }
          />
          {node.children.length > 0 && (
            <ul className="pb-2 pl-6">
              {node.children.map((child) => (
                <li key={child.id}>
                  <Row
                    category={child}
                    small
                    onEdit={() => onEdit({ mode: "edit", category: child, parent: node, node: null })}
                  />
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}

function Row({
  category,
  small,
  onEdit,
  extra,
}: {
  category: Category;
  small?: boolean;
  onEdit: () => void;
  extra?: ReactNode;
}) {
  return (
    <div className={cn("flex items-center gap-3 py-2", category.archived && "opacity-50")}>
      <CategoryIcon icon={category.icon} colour={category.colour} size={small ? "sm" : "md"} />
      <Link
        to="/categories/$categoryId"
        params={{ categoryId: category.id }}
        className={cn("flex-1 truncate hover:underline", small ? "text-base" : "text-lg font-medium")}
      >
        {category.name}
        {category.archived && <span className="ml-2 text-sm text-muted">archived</span>}
      </Link>
      <span className="font-numbers text-sm text-faint" title="Entries">
        {category.entryCount}
      </span>
      {extra}
      <Button variant="ghost" size="sm" onClick={onEdit} aria-label={`Edit ${category.name}`}>
        Edit
      </Button>
    </div>
  );
}

function CategorySheet({
  type,
  editing,
  onClose,
  onMerge,
}: {
  type: CategoryType;
  editing: Editing;
  onClose: () => void;
  onMerge: (source: Category, node: CategoryNode | null) => void;
}) {
  const existing = editing.mode === "edit" ? editing.category : null;
  const parent = editing.parent;
  const isSub = parent !== null;
  const [name, setName] = useState(existing?.name ?? "");
  const [icon, setIcon] = useState<string | null>(existing?.icon ?? parent?.icon ?? null);
  const [colour, setColour] = useState<string | null>(existing?.colour ?? null);
  const create = useCreateCategory();
  const update = useUpdateCategory();
  const remove = useDeleteCategory();
  const busy = create.isPending || update.isPending || remove.isPending;
  const shownColour = isSub ? parent.colour : colour;

  const fail = (err: unknown) => toast(errorMessage(err));

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || !icon || (!isSub && !colour)) {
      toast(!name.trim() ? "Give it a name" : !icon ? "Pick an icon" : "Pick a colour");
      return;
    }
    try {
      if (existing) {
        await update.mutateAsync({
          id: existing.id,
          version: existing.version,
          name: name.trim(),
          icon,
          ...(isSub || !colour ? {} : { colour }),
        });
      } else {
        await create.mutateAsync({
          id: uuidv7(),
          type,
          parentId: parent?.id ?? null,
          name: name.trim(),
          icon,
          ...(isSub || !colour ? {} : { colour }),
        });
      }
      onClose();
    } catch (err) {
      fail(err);
    }
  }

  async function toggleArchive() {
    if (!existing) return;
    try {
      await update.mutateAsync({ id: existing.id, version: existing.version, archived: !existing.archived });
      toast(existing.archived ? `${existing.name} restored` : `${existing.name} archived`);
      onClose();
    } catch (err) {
      fail(err);
    }
  }

  async function destroy() {
    if (!existing) return;
    try {
      await remove.mutateAsync({ id: existing.id, version: existing.version });
      toast(`${existing.name} deleted`);
      onClose();
    } catch (err) {
      fail(err);
    }
  }

  const hasChildren = editing.mode === "edit" && (editing.node?.children.length ?? 0) > 0;
  const deletable = existing !== null && existing.entryCount === 0 && !hasChildren;
  const title = existing
    ? `Edit ${existing.name}`
    : isSub
      ? `New subcategory of ${parent.name}`
      : "New category";

  return (
    <Sheet
      open
      onClose={onClose}
      title={title}
      footer={
        <Button type="submit" form="category-form" className="w-full" disabled={busy}>
          Save
        </Button>
      }
    >
      <form id="category-form" onSubmit={submit} className="flex flex-col gap-6">
        <div className="flex items-end gap-3">
          {icon && <CategoryIcon icon={icon} colour={shownColour} size="lg" />}
          <div className="flex flex-1 flex-col gap-1">
            <Label htmlFor="category-name">Name</Label>
            <Input
              id="category-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={60}
              required
              autoComplete="off"
            />
          </div>
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm text-muted">Icon</legend>
          <IconPicker value={icon} onChange={setIcon} colour={shownColour} />
        </fieldset>
        {isSub ? (
          <p className="text-sm text-muted">Subcategories always use the colour of {parent.name}.</p>
        ) : (
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-sm text-muted">Colour</legend>
            <ColourPicker value={colour} onChange={setColour} />
          </fieldset>
        )}
      </form>

      {existing && (
        <div className="mt-10 flex flex-col items-start gap-2 border-t border-rule pt-4">
          <Button variant="outline" size="sm" onClick={toggleArchive} disabled={busy}>
            {existing.archived ? "Restore" : "Archive"}
          </Button>
          <p className="text-sm text-muted">
            Archived categories leave the entry picker but stay in history and statistics.
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onMerge(existing, editing.mode === "edit" ? editing.node : null)}
            disabled={busy}
          >
            Merge into another category…
          </Button>
          {deletable ? (
            <Button variant="danger" size="sm" onClick={destroy} disabled={busy}>
              Delete
            </Button>
          ) : (
            <p className="text-sm text-muted">
              {hasChildren
                ? "Has subcategories, so it can't be deleted."
                : "Used by entries, so it can't be deleted — archive or merge it instead."}
            </p>
          )}
        </div>
      )}
    </Sheet>
  );
}

function MergeSheet({
  source,
  node,
  tree,
  onClose,
}: {
  source: Category;
  node: CategoryNode | null;
  tree: CategoryNode[];
  onClose: () => void;
}) {
  const merge = useMergeCategory();
  const hasChildren = (node?.children.length ?? 0) > 0;
  // A category with subcategories can only go into a top-level category (two levels at most).
  const options = tree
    .filter((p) => p.id !== source.id && !p.archived)
    .flatMap((p) => [
      { id: p.id, label: p.name },
      ...(hasChildren
        ? []
        : p.children
            .filter((c) => c.id !== source.id && !c.archived)
            .map((c) => ({ id: c.id, label: `${p.name} › ${c.name}` }))),
    ]);
  const [targetId, setTargetId] = useState(options[0]?.id ?? "");
  const target = options.find((o) => o.id === targetId);

  async function confirm() {
    if (!targetId) return;
    try {
      const result = await merge.mutateAsync({ id: source.id, targetId, version: source.version });
      toast(`Moved ${result.movedEntries} entries into ${target?.label ?? "the category"}`);
      onClose();
    } catch (err) {
      toast(errorMessage(err));
    }
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title={`Merge ${source.name}`}
      footer={
        <Button
          variant="primary"
          className="w-full"
          onClick={confirm}
          disabled={!targetId || merge.isPending}
        >
          Merge and delete {source.name}
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-muted">
          Every entry in {source.name}
          {hasChildren ? " and its subcategories" : ""} moves to the category you pick, then {source.name} is
          deleted. This can't be undone.
        </p>
        {options.length === 0 ? (
          <p className="text-muted">There is no other category of this type to merge into.</p>
        ) : (
          <div className="flex flex-col gap-1">
            <Label htmlFor="merge-target">Merge into</Label>
            <Select id="merge-target" value={targetId} onChange={(e) => setTargetId(e.target.value)}>
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </Select>
          </div>
        )}
      </div>
    </Sheet>
  );
}
