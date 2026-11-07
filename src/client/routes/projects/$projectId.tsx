import type { CurrencyCode } from "@shared/money";
import type { CategoryNode } from "@shared/schemas/category";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { CategoryIcon, ColourDot } from "../../components/CategoryIcon";
import { Empty } from "../../components/ui/empty";
import { Money } from "../../components/ui/money";
import { Page } from "../../components/ui/page";
import { openEdit } from "../../drawer/store";
import { useCategories } from "../../features/categories/api";
import { useProjectSummary } from "../../features/projects/api";

export const Route = createFileRoute("/projects/$projectId")({
  component: ProjectDetail,
});

function useCategoryLookup() {
  const { data } = useCategories();
  return useMemo(() => {
    const map = new Map<string, { name: string; icon: string; colour: string }>();
    for (const parent of data ?? ([] as CategoryNode[])) {
      map.set(parent.id, parent);
      for (const child of parent.children)
        map.set(child.id, { ...child, name: `${parent.name} › ${child.name}` });
    }
    return map;
  }, [data]);
}

function ProjectDetail() {
  const { projectId } = Route.useParams();
  const { data, isPending, isError } = useProjectSummary(projectId);
  const categories = useCategoryLookup();

  if (isPending)
    return (
      <Page title="Project">
        <p className="text-muted">Loading…</p>
      </Page>
    );
  if (isError || !data)
    return (
      <Page title="Project">
        <p className="text-negative">Couldn't load this project.</p>
      </Page>
    );

  const { project, baseCurrency } = data;
  return (
    <Page
      title={
        <span className="flex items-center gap-3">
          <ColourDot colour={project.colour} className="size-4" />
          <span>
            {project.name}
            {project.archived && <span className="ml-2 align-middle text-base text-muted">archived</span>}
          </span>
        </span>
      }
      actions={
        <Link to="/projects" className="text-sm text-muted hover:text-fg">
          All projects
        </Link>
      }
    >
      <dl className="grid grid-cols-3 gap-4 border-b border-rule pb-6">
        <div>
          <dt className="text-sm text-muted">Expenses</dt>
          <dd>
            <Money minor={data.expenseMinor} currency={baseCurrency} className="text-2xl" />
          </dd>
        </div>
        <div>
          <dt className="text-sm text-muted">Income</dt>
          <dd>
            <Money minor={data.incomeMinor} currency={baseCurrency} className="text-2xl" />
          </dd>
        </div>
        <div>
          <dt className="text-sm text-muted">Net</dt>
          <dd>
            <Money minor={data.netMinor} currency={baseCurrency} signed className="text-3xl font-semibold" />
          </dd>
        </div>
      </dl>

      {data.entries.length === 0 ? (
        <Empty title="No entries tagged with this project yet." className="border-t-0" />
      ) : (
        <ul>
          {data.entries.map((e) => {
            const category = categories.get(e.categoryId ?? "");
            return (
              <li key={e.id} className="border-b border-rule">
                <button
                  type="button"
                  onClick={() => openEdit(e.id, e.kind === "income" ? "income" : "expense")}
                  className="flex w-full items-center gap-3 py-3 text-left hover:bg-surface"
                >
                  <span className="w-24 font-numbers text-sm text-muted">{e.date}</span>
                  {category && <CategoryIcon icon={category.icon} colour={category.colour} size="sm" />}
                  <span className="flex-1 truncate">
                    {e.notes || category?.name || "—"}
                    {e.notes && category && <span className="ml-2 text-sm text-muted">{category.name}</span>}
                  </span>
                  {e.fxState === "waiting" && <span className="text-sm text-faint">waiting for rate</span>}
                  <Money
                    minor={e.kind === "expense" ? -e.amountMinor : e.amountMinor}
                    currency={e.currency as CurrencyCode}
                    signed
                  />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Page>
  );
}
