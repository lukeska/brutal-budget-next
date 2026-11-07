import { env } from "cloudflare:workers";
import type { CategoryNode, CategorySummary } from "@shared/schemas/category";
import type { Project, ProjectSummary } from "@shared/schemas/project";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { csrfGuard, requireSession } from "../../src/worker/auth/middleware";
import { addDays, todayIn } from "../../src/worker/fx/today";
import { sha256Hex } from "../../src/worker/lib/crypto";
import type { AppEnv } from "../../src/worker/lib/env";
import { HttpError } from "../../src/worker/lib/errors";
import { newId } from "../../src/worker/lib/ids";
import { categoriesRoutes } from "../../src/worker/routes/categories";
import { projectsRoutes } from "../../src/worker/routes/projects";

const db = env.DB;
const ORIGIN = "https://app.test";
const NOW = new Date().toISOString();
const TODAY = todayIn("Europe/Rome");
const THIS_MONTH = TODAY.slice(0, 7);
const LAST_MONTH = addDays(`${THIS_MONTH}-01`, -1).slice(0, 7);
const TWO_MONTHS_AGO = addDays(`${LAST_MONTH}-01`, -1).slice(0, 7);

const ALICE = "01900000-0000-7000-8000-00000000000a";
const TOKEN = "alice-session-token";
const JOINT = "acc-joint-eur";

const FOOD = "cat-food";
const GROCERIES = "cat-groceries";
const RESTAURANTS = "cat-restaurants";
const EATING_OUT = "cat-eating-out";
const SALARY = "cat-salary";
const TRIP = "proj-trip";

function makeApp() {
  const app = new Hono<AppEnv>().basePath("/api");
  app.use("*", csrfGuard);
  for (const prefix of ["/categories", "/projects"]) {
    app.use(prefix, requireSession);
    app.use(`${prefix}/*`, requireSession);
  }
  app.route("/", categoriesRoutes);
  app.route("/", projectsRoutes);
  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.code, ...err.extra }, err.status);
    throw err;
  });
  return app;
}
const app = makeApp();

function call(method: string, path: string, body?: unknown) {
  return app.request(
    `${ORIGIN}/api${path}`,
    {
      method,
      headers: { origin: ORIGIN, "content-type": "application/json", cookie: `__Host-bb_session=${TOKEN}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env,
  );
}
const get = (path: string) => call("GET", path);
const post = (path: string, body: unknown) => call("POST", path, body);
const patch = (path: string, body: unknown) => call("PATCH", path, body);
const del = (path: string) => call("DELETE", path);

async function seed() {
  await db.batch(
    [
      "DELETE FROM reconciliations",
      "DELETE FROM entries",
      "DELETE FROM projects",
      "DELETE FROM categories WHERE parent_id IS NOT NULL",
      "DELETE FROM categories",
      "DELETE FROM accounts",
      "DELETE FROM sessions",
      "DELETE FROM users",
      "DELETE FROM household",
    ].map((s) => db.prepare(s)),
  );
  const category = db.prepare(
    "INSERT INTO categories (id, type, parent_id, name, icon, colour, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
  );
  await db.batch([
    db
      .prepare(
        "INSERT INTO household (id, base_currency, timezone, argon_params, created_at) VALUES (1, 'EUR', 'Europe/Rome', '{}', ?)",
      )
      .bind(NOW),
    db
      .prepare(
        "INSERT INTO users (id, email, name, salt, verifier, created_at, updated_at) VALUES (?1, 'alice@example.com', 'Alice', 's', 'v', ?2, ?2)",
      )
      .bind(ALICE, NOW),
    db
      .prepare(
        "INSERT INTO sessions (token_hash, user_id, created_at, last_used_at, expires_at) VALUES (?1, ?2, ?3, ?3, ?4)",
      )
      .bind(await sha256Hex(TOKEN), ALICE, NOW, new Date(Date.now() + 86_400_000).toISOString()),
    db
      .prepare(
        "INSERT INTO accounts (id, name, currency, opening_minor, created_at, updated_at) VALUES (?1, 'Joint', 'EUR', 0, ?2, ?2)",
      )
      .bind(JOINT, NOW),
    category.bind(FOOD, "expense", null, "Food", "IconToolsKitchen2", "#f97316", NOW),
    category.bind(GROCERIES, "expense", FOOD, "Groceries", "IconShoppingCart", null, NOW),
    category.bind(RESTAURANTS, "expense", FOOD, "Restaurants", "IconChefHat", null, NOW),
    category.bind(EATING_OUT, "expense", null, "Eating out", "IconBeer", "#ef4444", NOW),
    category.bind(SALARY, "income", null, "Salary", "IconCash", "#22c55e", NOW),
    db
      .prepare(
        "INSERT INTO projects (id, name, colour, created_at, updated_at) VALUES (?1, 'Japan trip', '#ec4899', ?2, ?2)",
      )
      .bind(TRIP, NOW),
  ]);
}

type EntryOpts = {
  kind?: "expense" | "income";
  date?: string;
  base?: number | null;
  project?: string | null;
};

/** Inserts an entry directly; `base: null` makes it one still waiting for a rate. */
async function insertEntry(categoryId: string, amount: number, opts: EntryOpts = {}): Promise<string> {
  const id = newId();
  const base = opts.base === undefined ? amount : opts.base;
  await db
    .prepare(
      `INSERT INTO entries (id, kind, date, user_id, account_id, account_amount_minor, base_amount_minor,
         fx_state, category_id, project_id, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)`,
    )
    .bind(
      id,
      opts.kind ?? "expense",
      opts.date ?? TODAY,
      ALICE,
      JOINT,
      amount,
      base,
      base === null ? "waiting" : "fixed",
      categoryId,
      opts.project ?? null,
      NOW,
    )
    .run();
  return id;
}

async function categories(type?: string): Promise<CategoryNode[]> {
  const res = await get(type ? `/categories?type=${type}` : "/categories");
  expect(res.status).toBe(200);
  return res.json();
}

async function find(id: string) {
  const all = (await categories()).flatMap((c) => [c, ...c.children]);
  const found = all.find((c) => c.id === id);
  if (!found) throw new Error(`category ${id} not listed`);
  return found;
}

async function summary(id: string, query = ""): Promise<CategorySummary> {
  const res = await get(`/categories/${id}/summary${query}`);
  expect(res.status, await res.clone().text()).toBe(200);
  return res.json();
}

function monthTotal(s: CategorySummary, month: string): number {
  return s.months.find((m) => m.month === month)?.totalMinor ?? Number.NaN;
}

beforeEach(seed);

describe("category tree", () => {
  it("lists parents with their subcategories, entry counts and each subcategory in its parent's colour", async () => {
    await insertEntry(GROCERIES, 4000);
    const tree = await categories("expense");
    expect(tree.map((c) => c.name)).toEqual(["Eating out", "Food"]);
    const food = tree.find((c) => c.id === FOOD);
    expect(food?.children.map((c) => c.name)).toEqual(["Groceries", "Restaurants"]);
    expect(food?.children[0]).toMatchObject({ colour: "#f97316", entryCount: 1, archived: false });
  });

  it("creates a subcategory that defaults to its parent's icon and stores no colour", async () => {
    const id = newId();
    const res = await post("/categories", { id, type: "expense", parentId: FOOD, name: "Snacks" });
    expect(res.status, await res.clone().text()).toBe(201);
    expect(await res.json()).toMatchObject({ icon: "IconToolsKitchen2", colour: "#f97316", parentId: FOOD });
    const stored = await db.prepare("SELECT colour FROM categories WHERE id = ?").bind(id).first();
    expect(stored).toEqual({ colour: null });
  });

  it("refuses a subcategory under a subcategory", async () => {
    const res = await post("/categories", {
      id: newId(),
      type: "expense",
      parentId: GROCERIES,
      name: "Fruit",
      icon: "IconTag",
    });
    expect(res.status).toBe(422);
  });

  it("refuses a colour on a subcategory and a top-level category without one", async () => {
    const sub = await post("/categories", {
      id: newId(),
      type: "expense",
      parentId: FOOD,
      name: "Fruit",
      colour: "#000000",
    });
    expect(sub.status).toBe(422);
    const top = await post("/categories", { id: newId(), type: "expense", name: "Pets", icon: "IconPaw" });
    expect(top.status).toBe(422);
  });

  it("shows a subcategory in its parent's new colour after the parent is recoloured", async () => {
    const res = await patch(`/categories/${FOOD}`, { version: 1, colour: "#3b82f6" });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await find(GROCERIES)).toMatchObject({ colour: "#3b82f6" });
  });

  it("renames and re-icons a category, and answers a stale version with a conflict", async () => {
    const ok = await patch(`/categories/${GROCERIES}`, {
      version: 1,
      name: "Supermarket",
      icon: "IconBasket",
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ name: "Supermarket", icon: "IconBasket", version: 2 });
    const stale = await patch(`/categories/${GROCERIES}`, { version: 1, name: "Shop" });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: "conflict", current: { name: "Supermarket" } });
  });

  it("refuses to recolour a subcategory", async () => {
    const res = await patch(`/categories/${GROCERIES}`, { version: 1, colour: "#000000" });
    expect(res.status).toBe(422);
  });
});

describe("deleting and archiving categories", () => {
  it("refuses to delete a used category, and once archived it is flagged while its entries still count", async () => {
    await insertEntry(EATING_OUT, 2500);
    const refused = await del(`/categories/${EATING_OUT}?version=1`);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: "in_use" });

    expect((await patch(`/categories/${EATING_OUT}`, { version: 1, archived: true })).status).toBe(200);
    expect(await find(EATING_OUT)).toMatchObject({ archived: true });
    expect(monthTotal(await summary(EATING_OUT), THIS_MONTH)).toBe(2500);
  });

  it("deletes an unused category", async () => {
    const res = await del(`/categories/${RESTAURANTS}?version=1`);
    expect(res.status).toBe(204);
    const left = await db.prepare("SELECT id FROM categories WHERE id = ?").bind(RESTAURANTS).first();
    expect(left).toBeNull();
  });

  it("refuses to delete a parent that still has subcategories", async () => {
    expect((await del(`/categories/${FOOD}?version=1`)).status).toBe(409);
  });
});

describe("merging categories", () => {
  it("moves every entry of Eating out into Food > Restaurants so past months roll up into Food", async () => {
    const a = await insertEntry(EATING_OUT, 3000, { date: `${TWO_MONTHS_AGO}-10` });
    const b = await insertEntry(EATING_OUT, 2000, { date: `${LAST_MONTH}-05` });
    await insertEntry(RESTAURANTS, 1000, { date: `${LAST_MONTH}-06` });

    const res = await post(`/categories/${EATING_OUT}/merge`, { targetId: RESTAURANTS, version: 1 });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toMatchObject({ targetId: RESTAURANTS, movedEntries: 2 });

    const moved = await db
      .prepare("SELECT category_id, version FROM entries WHERE id IN (?1, ?2)")
      .bind(a, b)
      .all();
    expect(moved.results).toEqual([
      { category_id: RESTAURANTS, version: 2 },
      { category_id: RESTAURANTS, version: 2 },
    ]);
    const gone = await db.prepare("SELECT id FROM categories WHERE id = ?").bind(EATING_OUT).first();
    expect(gone).toBeNull();

    const food = await summary(FOOD);
    expect(monthTotal(food, TWO_MONTHS_AGO)).toBe(3000);
    expect(monthTotal(food, LAST_MONTH)).toBe(3000);
  });

  it("moves a source's subcategories under a top-level target", async () => {
    const id = newId();
    expect(
      (await post("/categories", { id, type: "expense", parentId: EATING_OUT, name: "Bars" })).status,
    ).toBe(201);
    const res = await post(`/categories/${EATING_OUT}/merge`, { targetId: FOOD, version: 1 });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await find(id)).toMatchObject({ parentId: FOOD, colour: "#f97316" });
  });

  it("refuses to merge an expense category into an income category", async () => {
    const res = await post(`/categories/${EATING_OUT}/merge`, { targetId: SALARY, version: 1 });
    expect(res.status).toBe(422);
  });

  it("refuses to merge a category with subcategories into Food > Restaurants", async () => {
    await post("/categories", { id: newId(), type: "expense", parentId: EATING_OUT, name: "Bars" });
    const res = await post(`/categories/${EATING_OUT}/merge`, { targetId: RESTAURANTS, version: 1 });
    expect(res.status).toBe(422);
    expect(await find(EATING_OUT)).toBeTruthy();
  });

  it("refuses a merge from a stale version", async () => {
    await insertEntry(EATING_OUT, 1000);
    const res = await post(`/categories/${EATING_OUT}/merge`, { targetId: RESTAURANTS, version: 7 });
    expect(res.status).toBe(409);
    const row = await db
      .prepare("SELECT COUNT(*) AS n FROM entries WHERE category_id = ?")
      .bind(EATING_OUT)
      .first();
    expect(row).toEqual({ n: 1 });
  });
});

describe("category detail", () => {
  it("shows Food at €50 in a month with €40 on Groceries and €10 on Food itself", async () => {
    await insertEntry(GROCERIES, 4000);
    await insertEntry(FOOD, 1000);
    const s = await summary(FOOD);
    expect(s.baseCurrency).toBe("EUR");
    expect(s.months).toHaveLength(12);
    expect(s.months.at(-1)).toEqual({ month: THIS_MONTH, totalMinor: 5000 });
    expect(s.breakdown).toEqual(
      expect.arrayContaining([
        { categoryId: GROCERIES, totalMinor: 4000 },
        { categoryId: FOOD, totalMinor: 1000 },
      ]),
    );
    expect(s.entries).toHaveLength(2);
  });

  it("leaves entries waiting for a rate out of the totals but lists them", async () => {
    await insertEntry(GROCERIES, 4000);
    await insertEntry(GROCERIES, 999, { base: null });
    const s = await summary(GROCERIES, `?month=${THIS_MONTH}`);
    expect(monthTotal(s, THIS_MONTH)).toBe(4000);
    expect(s.entries).toHaveLength(2);
  });
});

describe("projects", () => {
  it("creates, lists with totals, and summarises a project across categories", async () => {
    const id = newId();
    const created = await post("/projects", { id, name: "Wedding", colour: "#8b5cf6" });
    expect(created.status, await created.clone().text()).toBe(201);
    await insertEntry(FOOD, 3000, { project: id });
    await insertEntry(EATING_OUT, 2000, { project: id });
    await insertEntry(SALARY, 10_000, { kind: "income", project: id });

    const list = (await (await get("/projects")).json()) as Project[];
    expect(list.find((p) => p.id === id)).toMatchObject({
      expenseMinor: 5000,
      incomeMinor: 10_000,
      netMinor: 5000,
      entryCount: 3,
    });
    const s = (await (await get(`/projects/${id}/summary`)).json()) as ProjectSummary;
    expect(s).toMatchObject({ expenseMinor: 5000, incomeMinor: 10_000, netMinor: 5000, baseCurrency: "EUR" });
    expect(s.entries).toHaveLength(3);
  });

  it("refuses to delete a project entries refer to, and archiving it keeps the tag on its entries", async () => {
    const entry = await insertEntry(FOOD, 1500, { project: TRIP });
    const refused = await del(`/projects/${TRIP}?version=1`);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: "in_use" });

    const archived = await patch(`/projects/${TRIP}`, { version: 1, archived: true });
    expect(archived.status).toBe(200);
    expect(await archived.json()).toMatchObject({ archived: true });
    const row = await db.prepare("SELECT project_id FROM entries WHERE id = ?").bind(entry).first();
    expect(row).toEqual({ project_id: TRIP });
  });

  it("deletes an unused project", async () => {
    expect((await del(`/projects/${TRIP}?version=1`)).status).toBe(204);
  });
});
