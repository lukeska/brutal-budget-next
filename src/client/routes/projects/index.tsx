import type { Project } from "@shared/schemas/project";
import { createFileRoute, Link } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { v7 as uuidv7 } from "uuid";
import { ColourDot } from "../../components/CategoryIcon";
import { ColourPicker } from "../../components/ColourPicker";
import { Button } from "../../components/ui/button";
import { Empty } from "../../components/ui/empty";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Money } from "../../components/ui/money";
import { Page } from "../../components/ui/page";
import { Sheet } from "../../components/ui/sheet";
import { toast } from "../../components/ui/toast";
import {
  useCreateProject,
  useDeleteProject,
  useProjects,
  useUpdateProject,
} from "../../features/projects/api";
import { ApiError } from "../../lib/api";
import { cn } from "../../lib/cn";

export const Route = createFileRoute("/projects/")({
  component: ProjectsPage,
});

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const body = err.body as { message?: string; issues?: { message: string }[] } | null;
    if (body?.issues?.[0]) return body.issues[0].message;
    if (body?.message) return body.message;
  }
  return "Something went wrong — try again";
}

function ProjectsPage() {
  const { data: projects, isPending, isError } = useProjects();
  const [editing, setEditing] = useState<Project | "new" | null>(null);
  const active = projects?.filter((p) => !p.archived) ?? [];
  const archived = projects?.filter((p) => p.archived) ?? [];

  return (
    <Page
      title="Projects"
      actions={
        <Button size="sm" onClick={() => setEditing("new")}>
          Add project
        </Button>
      }
    >
      {isPending && <p className="text-muted">Loading…</p>}
      {isError && <p className="text-negative">Couldn't load projects.</p>}
      {projects && projects.length === 0 && (
        <Empty title="No projects yet.">
          Tag expenses and income with a project, such as “Japan trip”, to see its total.
        </Empty>
      )}
      <ProjectList projects={active} onEdit={setEditing} />
      {archived.length > 0 && (
        <section className="mt-10">
          <h2 className="mb-2 text-sm text-muted">Archived</h2>
          <ProjectList projects={archived} onEdit={setEditing} />
        </section>
      )}
      {editing && (
        <ProjectSheet
          key={editing === "new" ? "new" : editing.id}
          project={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </Page>
  );
}

function ProjectList({ projects, onEdit }: { projects: Project[]; onEdit: (p: Project) => void }) {
  return (
    <ul className="border-t border-rule">
      {projects.map((p) => (
        <li
          key={p.id}
          className={cn("flex items-center gap-3 border-b border-rule py-3", p.archived && "opacity-50")}
        >
          <ColourDot colour={p.colour} />
          <Link
            to="/projects/$projectId"
            params={{ projectId: p.id }}
            className="flex-1 truncate text-lg font-medium hover:underline"
          >
            {p.name}
          </Link>
          <Money minor={p.netMinor} currency={p.baseCurrency} signed className="text-lg" />
          <Button variant="ghost" size="sm" onClick={() => onEdit(p)} aria-label={`Edit ${p.name}`}>
            Edit
          </Button>
        </li>
      ))}
    </ul>
  );
}

function ProjectSheet({ project, onClose }: { project: Project | null; onClose: () => void }) {
  const [name, setName] = useState(project?.name ?? "");
  const [colour, setColour] = useState<string | null>(project?.colour ?? null);
  const create = useCreateProject();
  const update = useUpdateProject();
  const remove = useDeleteProject();
  const busy = create.isPending || update.isPending || remove.isPending;

  async function run(action: () => Promise<unknown>, done?: string) {
    try {
      await action();
      if (done) toast(done);
      onClose();
    } catch (err) {
      toast(errorMessage(err));
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || !colour) {
      toast(!name.trim() ? "Give it a name" : "Pick a colour");
      return;
    }
    void run(() =>
      project
        ? update.mutateAsync({ id: project.id, version: project.version, name: name.trim(), colour })
        : create.mutateAsync({ id: uuidv7(), name: name.trim(), colour }),
    );
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title={project ? `Edit ${project.name}` : "New project"}
      footer={
        <Button type="submit" form="project-form" className="w-full" disabled={busy}>
          Save
        </Button>
      }
    >
      <form id="project-form" onSubmit={submit} className="flex flex-col gap-6">
        <div className="flex flex-col gap-1">
          <Label htmlFor="project-name">Name</Label>
          <Input
            id="project-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={60}
            required
            autoComplete="off"
          />
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm text-muted">Colour</legend>
          <ColourPicker value={colour} onChange={setColour} />
        </fieldset>
      </form>
      {project && (
        <div className="mt-10 flex flex-col items-start gap-2 border-t border-rule pt-4">
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() =>
              run(
                () =>
                  update.mutateAsync({
                    id: project.id,
                    version: project.version,
                    archived: !project.archived,
                  }),
                project.archived ? `${project.name} restored` : `${project.name} archived`,
              )
            }
          >
            {project.archived ? "Restore" : "Archive"}
          </Button>
          <p className="text-sm text-muted">
            Archived projects leave the entry picker; their entries keep the tag.
          </p>
          {project.entryCount === 0 ? (
            <Button
              variant="danger"
              size="sm"
              disabled={busy}
              onClick={() =>
                run(
                  () => remove.mutateAsync({ id: project.id, version: project.version }),
                  `${project.name} deleted`,
                )
              }
            >
              Delete
            </Button>
          ) : (
            <p className="text-sm text-muted">
              Used by entries, so it can't be deleted — archive it instead.
            </p>
          )}
        </div>
      )}
    </Sheet>
  );
}
