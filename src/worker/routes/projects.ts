import type { CurrencyCode } from "@shared/money";
import { versionQuerySchema } from "@shared/schemas/category";
import { CONFLICT_MESSAGE } from "@shared/schemas/entry";
import {
  type Project,
  type ProjectSummary,
  projectCreateSchema,
  projectPatchSchema,
} from "@shared/schemas/project";
import { Hono } from "hono";
import type { z } from "zod";
import type { AppEnv } from "../lib/env";
import { HttpError } from "../lib/errors";
import { nowIso } from "../lib/time";
import { listEntries } from "../services/entries";
import { runDelete, validate } from "./categories";

interface ProjectRow {
  id: string;
  name: string;
  colour: string;
  archived_at: string | null;
  version: number;
  entry_count: number;
  income: number;
  expense: number;
  base_currency: CurrencyCode;
}

// Totals are in the base currency; entries still waiting for a rate have no base value yet.
const SELECT_PROJECT = `SELECT p.id, p.name, p.colour, p.archived_at, p.version,
    (SELECT base_currency FROM household WHERE id = 1) AS base_currency,
    COUNT(e.id) AS entry_count,
    COALESCE(SUM(CASE WHEN e.kind = 'income' AND e.fx_state <> 'waiting' THEN e.base_amount_minor END), 0) AS income,
    COALESCE(SUM(CASE WHEN e.kind = 'expense' AND e.fx_state <> 'waiting' THEN e.base_amount_minor END), 0) AS expense
  FROM projects p LEFT JOIN entries e ON e.project_id = p.id`;

function toProject(r: ProjectRow): Project {
  return {
    id: r.id,
    name: r.name,
    colour: r.colour,
    archived: r.archived_at !== null,
    archivedAt: r.archived_at,
    entryCount: r.entry_count,
    version: r.version,
    baseCurrency: r.base_currency,
    incomeMinor: r.income,
    expenseMinor: r.expense,
    netMinor: r.income - r.expense,
  };
}

async function readProject(d1: D1Database, id: string): Promise<Project | null> {
  const row = await d1
    .prepare(`${SELECT_PROJECT} WHERE p.id = ?1 GROUP BY p.id`)
    .bind(id)
    .first<ProjectRow>();
  return row ? toProject(row) : null;
}

async function mustRead(d1: D1Database, id: string): Promise<Project> {
  const project = await readProject(d1, id);
  if (!project) throw new HttpError(404, "not_found");
  return project;
}

function conflict(current: Project): HttpError {
  return new HttpError(409, "conflict", { message: CONFLICT_MESSAGE, current });
}

async function listProjects(d1: D1Database): Promise<Project[]> {
  const { results } = await d1
    .prepare(`${SELECT_PROJECT} GROUP BY p.id ORDER BY p.name COLLATE NOCASE, p.id`)
    .all<ProjectRow>();
  return results.map(toProject);
}

async function createProject(d1: D1Database, input: z.infer<typeof projectCreateSchema>): Promise<Project> {
  if (await readProject(d1, input.id))
    throw new HttpError(409, "id_conflict", { message: "A project with this id already exists" });
  await d1
    .prepare("INSERT INTO projects (id, name, colour, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)")
    .bind(input.id, input.name, input.colour, nowIso())
    .run();
  return mustRead(d1, input.id);
}

async function updateProject(d1: D1Database, id: string, patch: z.infer<typeof projectPatchSchema>) {
  const existing = await mustRead(d1, id);
  if (patch.version !== existing.version) throw conflict(existing);
  const now = nowIso();
  const archivedAt = patch.archived ? (existing.archivedAt ?? now) : null;
  const { meta } = await d1
    .prepare(
      `UPDATE projects SET
         name = COALESCE(?3, name),
         colour = COALESCE(?4, colour),
         archived_at = CASE WHEN ?5 = 1 THEN ?6 ELSE archived_at END,
         version = version + 1,
         updated_at = ?7
       WHERE id = ?1 AND version = ?2`,
    )
    .bind(
      id,
      patch.version,
      patch.name ?? null,
      patch.colour ?? null,
      patch.archived === undefined ? 0 : 1,
      archivedAt,
      now,
    )
    .run();
  if (meta.changes === 0) throw conflict(await mustRead(d1, id));
  return mustRead(d1, id);
}

async function deleteProject(d1: D1Database, id: string, version: number): Promise<void> {
  const changes = await runDelete(
    d1.prepare("DELETE FROM projects WHERE id = ?1 AND version = ?2").bind(id, version),
  );
  if (changes > 0) return;
  const current = await readProject(d1, id);
  if (current) throw conflict(current);
}

async function projectSummary(d1: D1Database, id: string): Promise<ProjectSummary> {
  const [project, entries] = await Promise.all([mustRead(d1, id), listEntries(d1, { projectId: id })]);
  return {
    project,
    baseCurrency: project.baseCurrency,
    incomeMinor: project.incomeMinor,
    expenseMinor: project.expenseMinor,
    netMinor: project.netMinor,
    entries,
  };
}

/** Projects: colour-coded tags across categories. Paths carry their own prefix; mount at "/". */
export const projectsRoutes = new Hono<AppEnv>()
  .get("/projects", async (c) => c.json(await listProjects(c.env.DB)))
  .post("/projects", validate("json", projectCreateSchema), async (c) => {
    return c.json(await createProject(c.env.DB, c.req.valid("json")), 201);
  })
  .patch("/projects/:id", validate("json", projectPatchSchema), async (c) => {
    return c.json(await updateProject(c.env.DB, c.req.param("id"), c.req.valid("json")));
  })
  .delete("/projects/:id", validate("query", versionQuerySchema), async (c) => {
    await deleteProject(c.env.DB, c.req.param("id"), c.req.valid("query").version);
    return c.body(null, 204);
  })
  .get("/projects/:id/summary", async (c) => c.json(await projectSummary(c.env.DB, c.req.param("id"))));
