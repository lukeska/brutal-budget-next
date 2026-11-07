import { type CurrencyCode, formatMinor } from "@shared/money";
import type { CategoryNode } from "@shared/schemas/category";
import { type CsvRow, matchKey } from "@shared/schemas/csv";
import type { Project } from "@shared/schemas/project";
import { Link } from "@tanstack/react-router";
import { type ChangeEvent, type ReactNode, useEffect, useMemo, useState } from "react";
import { Button } from "../../components/ui/button";
import { Label } from "../../components/ui/label";
import { Select } from "../../components/ui/select";
import { errorMessage } from "../../lib/api";
import { cn } from "../../lib/cn";
import { useAccounts } from "../accounts/api";
import { useCategories } from "../categories/api";
import { useProjects } from "../projects/api";
import { useSettings } from "../settings/api";
import {
  type CommitSummary,
  checkRows,
  commitRows,
  createBatch,
  fillRates,
  undoPreview,
  useImportBatches,
  useRefreshAfterImport,
  useUndoBatch,
} from "./api";
import {
  buildRows,
  matchAccount,
  matchPartner,
  type ParsedFile,
  parseCsvFile,
  type RowError,
  rateWindowsForRows,
} from "./parse";

type Stage =
  | { kind: "mapping" }
  | { kind: "checking"; done: number; total: number }
  | { kind: "preview" }
  | { kind: "committing"; label: string; done: number; total: number }
  | { kind: "done"; summary: CommitSummary };

/** The checked rows behind the preview; kept while committing so a failed commit can be retried. */
interface PreviewData {
  rows: CsvRow[];
  buildErrors: RowError[];
  /** Row numbers already stored. */
  existing: Set<number>;
}

const PREVIEW_LIMIT = 100;

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 border-t border-rule py-6">
      <h2 className="text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function ProgressBar({ label, done, total }: { label: string; done: number; total: number }) {
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-muted">
        {label} <span className="font-numbers">{pct}%</span>
      </p>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
        className="h-1 w-full bg-surface"
      >
        <div className="h-1 bg-fg transition-[width]" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function ErrorList({ errors }: { errors: RowError[] }) {
  if (errors.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-negative">{plural(errors.length, "row")} can't be imported</p>
      <ul className="max-h-64 overflow-y-auto border-y border-rule text-sm" aria-label="Rows with errors">
        {errors.map((e) => (
          <li key={e.rowNumber} className="flex gap-3 border-b border-rule py-1.5 last:border-b-0">
            <span className="font-numbers w-16 shrink-0 text-muted">Row {e.rowNumber}</span>
            <span>{e.messages.join("; ")}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Names in the file that don't exist yet and will be created on import. */
function newNames(rows: CsvRow[], tree: CategoryNode[], projects: Project[]) {
  const parents = new Map(tree.map((c) => [`${c.type}|${matchKey(c.name)}`, c]));
  const categories = new Set<string>();
  const subcategories = new Set<string>();
  const newProjects = new Set<string>();
  const projectKeys = new Set(projects.map((p) => matchKey(p.name)));
  const seen = new Set<string>();
  for (const r of rows) {
    const parent = parents.get(`${r.type}|${matchKey(r.categoryPath.parent)}`);
    const parentLabel = r.categoryPath.parent;
    if (!parent && !seen.has(`${r.type}|${matchKey(parentLabel)}`)) {
      seen.add(`${r.type}|${matchKey(parentLabel)}`);
      categories.add(parentLabel);
    }
    const child = r.categoryPath.child;
    if (child) {
      const exists = parent?.children.some((c) => matchKey(c.name) === matchKey(child));
      const key = `${r.type}|${matchKey(parentLabel)}|${matchKey(child)}`;
      if (!exists && !seen.has(key)) {
        seen.add(key);
        subcategories.add(`${parentLabel} › ${child}`);
      }
    }
    if (r.projectName && !projectKeys.has(matchKey(r.projectName))) {
      projectKeys.add(matchKey(r.projectName));
      newProjects.add(r.projectName);
    }
  }
  return { categories: [...categories], subcategories: [...subcategories], projects: [...newProjects] };
}

export function ImportWizard() {
  const { data: accounts = [] } = useAccounts();
  const { data: settings } = useSettings();
  const { data: tree = [] } = useCategories();
  const { data: projects = [] } = useProjects();
  const refresh = useRefreshAfterImport();

  const [file, setFile] = useState<ParsedFile | null>(null);
  const [reading, setReading] = useState(false);
  const [accountMap, setAccountMap] = useState<Record<string, string>>({});
  const [partnerMap, setPartnerMap] = useState<Record<string, string>>({});
  const [stage, setStage] = useState<Stage>({ kind: "mapping" });
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [skipInvalid, setSkipInvalid] = useState(false);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const activeAccounts = useMemo(() => accounts.filter((a) => a.archivedAt === null), [accounts]);
  const currencies = useMemo(
    () => new Map<string, CurrencyCode>(accounts.map((a) => [a.id, a.currency])),
    [accounts],
  );
  const people = useMemo(() => {
    if (!settings) return [];
    const list: { id: string; name: string; email?: string }[] = [settings.me];
    if (settings.partner) list.push(settings.partner);
    return list;
  }, [settings]);

  // Accounts and partners may finish loading after the file is read: fill in matches for names still unmapped.
  useEffect(() => {
    if (!file) return;
    setAccountMap((m) => {
      const missing = file.accountNames.filter((n) => !m[n]);
      if (missing.length === 0) return m;
      const filled = { ...m };
      for (const n of missing) filled[n] = matchAccount(n, activeAccounts) ?? "";
      return filled;
    });
    setPartnerMap((m) => {
      const missing = file.partners.filter((p) => !m[p]);
      if (missing.length === 0) return m;
      const filled = { ...m };
      for (const p of missing) filled[p] = matchPartner(p, people) ?? "";
      return filled;
    });
  }, [file, activeAccounts, people]);

  async function onFile(event: ChangeEvent<HTMLInputElement>) {
    const chosen = event.target.files?.[0];
    // Cleared so choosing the same file again (e.g. after editing it) reads it again.
    event.target.value = "";
    if (!chosen) return;
    setReading(true);
    setFailure(null);
    setBatchId(null);
    setSkipInvalid(false);
    setStage({ kind: "mapping" });
    setPreview(null);
    try {
      const parsed = await parseCsvFile(chosen);
      setFile(parsed);
      setAccountMap(
        Object.fromEntries(parsed.accountNames.map((n) => [n, matchAccount(n, activeAccounts) ?? ""])),
      );
      setPartnerMap(Object.fromEntries(parsed.partners.map((p) => [p, matchPartner(p, people) ?? ""])));
    } catch {
      setFile(null);
      setFailure("This file couldn't be read. Save it as UTF-8 CSV and try again.");
    } finally {
      setReading(false);
    }
  }

  const mapped =
    !!file?.accountNames.every((n) => accountMap[n]) &&
    file.partners.every((p) => partnerMap[p]) &&
    file.rows.length > 0;

  async function runCheck() {
    if (!file) return;
    setFailure(null);
    const { rows, errors } = buildRows(file.rows, {
      accounts: accountMap,
      partners: partnerMap,
      accountCurrencies: currencies,
    });
    setStage({ kind: "checking", done: 0, total: rows.length });
    try {
      const results = await checkRows(rows, (done, total) => setStage({ kind: "checking", done, total }));
      const existing = new Set(results.filter((r) => r.exists).map((r) => r.rowNumber));
      setPreview({ rows, buildErrors: errors, existing });
      setStage({ kind: "preview" });
    } catch (err) {
      setStage({ kind: "mapping" });
      setFailure(errorMessage(err, "The duplicate check failed — try again"));
    }
  }

  async function runCommit(rows: CsvRow[], existing: ReadonlySet<number>) {
    if (!file || !settings) return;
    // Rows the preview found already stored are not sent again; the server would only skip them.
    const fresh = rows.filter((r) => !existing.has(r.rowNumber));
    setFailure(null);
    setStage({ kind: "committing", label: "Importing", done: 0, total: fresh.length });
    try {
      let id = batchId;
      if (!id) {
        const batch = await createBatch({
          fileName: file.fileName,
          fileSha256: file.fileSha256,
          rowCount: rows.length,
        });
        id = batch.id;
        setBatchId(id);
      }
      const windows = rateWindowsForRows(fresh, currencies, settings.household.baseCurrency);
      if (windows.length > 0) {
        await fillRates(windows, (done, total) =>
          setStage({ kind: "committing", label: "Fetching exchange rates", done, total }),
        );
      }
      const summary = await commitRows(id, fresh, (done, total) =>
        setStage({ kind: "committing", label: "Importing", done, total }),
      );
      setStage({
        kind: "done",
        summary: { ...summary, skipped: summary.skipped + (rows.length - fresh.length) },
      });
    } catch (err) {
      setFailure(
        `${errorMessage(err, "The import stopped")}. Try again: rows already stored are skipped, never doubled.`,
      );
      setStage({ kind: "preview" });
    } finally {
      refresh();
    }
  }

  const allErrors = useMemo(() => {
    const parseErrors = file?.errors ?? [];
    return [...parseErrors, ...(preview?.buildErrors ?? [])].sort((a, b) => a.rowNumber - b.rowNumber);
  }, [file, preview]);

  return (
    <div className="flex flex-col">
      <Section title="Choose a file">
        <p className="text-sm text-muted">
          A CSV file with a header row, in the format described in the README (date, type, amount, currency,
          category, partner and optional columns). Transfers and accounts are never imported.
        </p>
        <Label htmlFor="import-file">CSV file</Label>
        <input
          id="import-file"
          type="file"
          accept=".csv,text/csv"
          onChange={onFile}
          disabled={reading || stage.kind === "checking" || stage.kind === "committing"}
          className="text-sm file:mr-3 file:min-h-11 file:border file:border-rule file:bg-transparent file:px-4 file:text-fg"
        />
        {reading && <p className="text-sm text-muted">Reading…</p>}
        {file?.fileError && <p className="text-negative">{file.fileError}</p>}
        {file && !file.fileError && (
          <p className="text-sm">
            <span className="font-numbers">{file.rows.length.toLocaleString()}</span> valid rows in{" "}
            {file.fileName}
          </p>
        )}
        {file && <ErrorList errors={allErrors} />}
      </Section>

      {file && !file.fileError && file.rows.length > 0 && stage.kind !== "done" && (
        <Section title="Match accounts and partners">
          {activeAccounts.length === 0 && (
            <p className="text-negative">
              Import never creates accounts. <Link to="/accounts">Add an account</Link> first.
            </p>
          )}
          <div className="grid gap-4 md:grid-cols-2">
            {file.accountNames.map((name, index) => {
              const id = `map-account-${index}`;
              return (
                <div key={`a-${name}`} className="flex flex-col gap-1">
                  <Label htmlFor={id}>{name === "" ? "Rows with no account" : `Account “${name}”`}</Label>
                  <Select
                    id={id}
                    value={accountMap[name] ?? ""}
                    onChange={(e) => {
                      setAccountMap((m) => ({ ...m, [name]: e.target.value }));
                      setStage({ kind: "mapping" });
                    }}
                    disabled={stage.kind !== "mapping" && stage.kind !== "preview"}
                  >
                    <option value="">Choose an account</option>
                    {activeAccounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} ({a.currency})
                      </option>
                    ))}
                  </Select>
                </div>
              );
            })}
            {file.partners.map((value, index) => {
              const id = `map-partner-${index}`;
              return (
                <div key={`p-${value}`} className="flex flex-col gap-1">
                  <Label htmlFor={id}>{value === "" ? "Rows with no partner" : `Partner “${value}”`}</Label>
                  <Select
                    id={id}
                    value={partnerMap[value] ?? ""}
                    onChange={(e) => {
                      setPartnerMap((m) => ({ ...m, [value]: e.target.value }));
                      setStage({ kind: "mapping" });
                    }}
                    disabled={stage.kind !== "mapping" && stage.kind !== "preview"}
                  >
                    <option value="">Choose a partner</option>
                    {people.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </Select>
                </div>
              );
            })}
          </div>
          {stage.kind === "checking" ? (
            <ProgressBar label="Checking for duplicates" done={stage.done} total={stage.total} />
          ) : (
            <div>
              <Button onClick={runCheck} disabled={!mapped || stage.kind === "committing"}>
                Check for duplicates
              </Button>
            </div>
          )}
        </Section>
      )}

      {(stage.kind === "preview" || stage.kind === "committing") && preview && (
        <Preview
          preview={preview}
          errorCount={allErrors.length}
          tree={tree}
          projects={projects}
          skipInvalid={skipInvalid}
          onSkipInvalid={setSkipInvalid}
          committing={stage.kind === "committing" ? stage : null}
          onConfirm={() => runCommit(preview.rows, preview.existing)}
        />
      )}

      {failure && (
        <p role="alert" className="text-negative">
          {failure}
        </p>
      )}

      {stage.kind === "done" && (
        <Section title="Done">
          <p className="text-lg">
            Imported{" "}
            <span className="font-numbers">{plural(stage.summary.inserted, "entry", "entries")}</span>
            {stage.summary.skipped > 0 && (
              <>
                , skipped <span className="font-numbers">{stage.summary.skipped.toLocaleString()}</span>{" "}
                already imported
              </>
            )}
            .
          </p>
          {stage.summary.failed.length > 0 && (
            <ErrorList
              errors={stage.summary.failed.map((f) => ({ rowNumber: f.rowNumber, messages: [f.message] }))}
            />
          )}
          <div>
            <Link to="/" className="underline underline-offset-4">
              Open the month view
            </Link>
          </div>
        </Section>
      )}

      <ImportHistory />
    </div>
  );
}

function Preview(props: {
  preview: PreviewData;
  errorCount: number;
  tree: CategoryNode[];
  projects: Project[];
  skipInvalid: boolean;
  onSkipInvalid: (value: boolean) => void;
  committing: { label: string; done: number; total: number } | null;
  onConfirm: () => void;
}) {
  const { preview, errorCount, committing } = props;
  const { rows, existing } = preview;
  const fresh = rows.length - rows.filter((r) => existing.has(r.rowNumber)).length;
  const names = useMemo(() => newNames(rows, props.tree, props.projects), [rows, props.tree, props.projects]);
  const newKeys = new Set([...names.categories, ...names.subcategories, ...names.projects].map(matchKey));
  const blocked = errorCount > 0 && !props.skipInvalid;

  return (
    <Section title="Preview">
      <dl className="grid grid-cols-3 gap-4" aria-label="Import summary">
        {[
          ["New", fresh],
          ["Already imported", rows.length - fresh],
          ["Errors", errorCount],
        ].map(([label, n]) => (
          <div key={label} className="flex flex-col">
            <dt className="text-sm text-muted">{label}</dt>
            <dd
              className={cn("font-numbers text-3xl", label === "Errors" && Number(n) > 0 && "text-negative")}
            >
              {Number(n).toLocaleString()}
            </dd>
          </div>
        ))}
      </dl>

      {(names.categories.length > 0 || names.subcategories.length > 0 || names.projects.length > 0) && (
        <div className="flex flex-col gap-1 text-sm">
          <p className="text-muted">Will be created:</p>
          {names.categories.length > 0 && <p>Categories: {names.categories.join(", ")}</p>}
          {names.subcategories.length > 0 && <p>Subcategories: {names.subcategories.join(", ")}</p>}
          {names.projects.length > 0 && <p>Projects: {names.projects.join(", ")}</p>}
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-muted">
            <tr className="border-b border-rule">
              <th className="py-1.5 pr-3 font-normal">Row</th>
              <th className="py-1.5 pr-3 font-normal">Date</th>
              <th className="py-1.5 pr-3 font-normal">Category</th>
              <th className="py-1.5 pr-3 font-normal">Notes</th>
              <th className="py-1.5 pr-3 text-right font-normal">Amount</th>
              <th className="py-1.5 font-normal">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, PREVIEW_LIMIT).map((r) => {
              const path = r.categoryPath.child
                ? `${r.categoryPath.parent} › ${r.categoryPath.child}`
                : r.categoryPath.parent;
              const isNew = newKeys.has(matchKey(r.categoryPath.parent)) || newKeys.has(matchKey(path));
              const dup = existing.has(r.rowNumber);
              return (
                <tr key={r.rowNumber} className={cn("border-b border-rule", dup && "text-muted")}>
                  <td className="font-numbers py-1.5 pr-3">{r.rowNumber}</td>
                  <td className="font-numbers py-1.5 pr-3">{r.date}</td>
                  <td className={cn("py-1.5 pr-3", isNew && "font-semibold")}>
                    {path}
                    {isNew && <span className="ml-1 text-xs text-muted">new</span>}
                  </td>
                  <td className="py-1.5 pr-3">{r.notes}</td>
                  <td className="font-numbers py-1.5 pr-3 text-right">
                    {r.type === "income" ? "+" : "−"}
                    {formatMinor(r.amountMinor, r.currency)}
                  </td>
                  <td className="py-1.5">{dup ? "Already imported" : "New"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length > PREVIEW_LIMIT && (
          <p className="pt-2 text-sm text-muted">and {plural(rows.length - PREVIEW_LIMIT, "more row")}</p>
        )}
      </div>

      {errorCount > 0 && (
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={props.skipInvalid}
            onChange={(e) => props.onSkipInvalid(e.target.checked)}
            className="size-4"
          />
          Skip invalid rows
        </label>
      )}

      {committing ? (
        <ProgressBar label={committing.label} done={committing.done} total={committing.total} />
      ) : (
        <div>
          <Button onClick={props.onConfirm} disabled={blocked || rows.length === 0}>
            Import {plural(fresh, "entry", "entries")}
          </Button>
        </div>
      )}
    </Section>
  );
}

function ImportHistory() {
  const { data: batches = [] } = useImportBatches();
  const undo = useUndoBatch();
  const [confirming, setConfirming] = useState<{
    id: string;
    entryCount: number;
    editedCount: number;
    reconciledCount: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function askUndo(id: string) {
    setError(null);
    try {
      setConfirming({ id, ...(await undoPreview(id)) });
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  if (batches.length === 0) return null;
  return (
    <Section title="Import history">
      <ul className="flex flex-col">
        {batches.map((b) => (
          <li key={b.id} className="flex flex-col gap-2 border-b border-rule py-3 last:border-b-0">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="truncate">{b.fileName}</p>
                <p className="text-sm text-muted">
                  {new Date(b.createdAt).toLocaleString()} ·{" "}
                  <span className="font-numbers">{plural(b.entryCount, "entry", "entries")}</span>
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={() => askUndo(b.id)} disabled={undo.isPending}>
                Undo
              </Button>
            </div>
            {confirming?.id === b.id && (
              <div
                className="flex flex-col gap-2 border-l-2 border-negative pl-3"
                role="alertdialog"
                aria-label="Undo import"
              >
                <p>This deletes {plural(confirming.entryCount, "entry", "entries")} from this import.</p>
                {confirming.editedCount > 0 && (
                  <p className="text-negative">
                    {plural(confirming.editedCount, "entry", "entries")} edited since import
                  </p>
                )}
                {confirming.reconciledCount > 0 && (
                  <p className="text-negative">
                    {plural(confirming.reconciledCount, "entry", "entries")} on or before a reconciliation
                  </p>
                )}
                <div className="flex gap-2">
                  <Button
                    variant="danger"
                    onClick={() =>
                      undo.mutate(b.id, {
                        onSuccess: () => setConfirming(null),
                        onError: (err) => setError(errorMessage(err)),
                      })
                    }
                    disabled={undo.isPending}
                  >
                    Undo import
                  </Button>
                  <Button variant="ghost" onClick={() => setConfirming(null)}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
      {error && <p className="text-negative">{error}</p>}
    </Section>
  );
}
