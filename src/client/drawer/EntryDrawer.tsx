import { type CurrencyCode, minorToDecimalString, parseAmount } from "@shared/money";
import { CONFLICT_MESSAGE, type Entry, NOTES_MAX, type ValidationIssue } from "@shared/schemas/entry";
import { type KeyboardEvent, type ReactNode, useEffect, useId, useState } from "react";
import { Button } from "../components/ui/button";
import { fieldClass, Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Select } from "../components/ui/select";
import { Sheet } from "../components/ui/sheet";
import { toast } from "../components/ui/toast";
import { useCreateEntry, useDeleteEntry, useEntry, useUpdateEntry } from "../features/entries/api";
import { useProjects } from "../features/projects/api";
import { ApiError, errorMessage } from "../lib/api";
import { cn } from "../lib/cn";
import { useOnline } from "../lib/online";
import { AmountField } from "./AmountField";
import { CategoryPicker } from "./CategoryPicker";
import {
  type EntryForm,
  errorsFromIssues,
  type FieldErrors,
  formFromEntry,
  needsAccountAmount,
  needsToAmount,
  rebaseForm,
  toEntryCreate,
  toEntryPatch,
} from "./form";
import { closeDrawer, type DrawerState, type EntryKind, useDrawer } from "./store";
import { TypeSwitch } from "./TypeSwitch";
import { draftKey, useDrawerDraft } from "./useDrawerDraft";
import { type Prefill, useConvertedPrefill, useDrawerDefaults } from "./useEntryDefaults";

const KIND_LABEL: Record<EntryKind, string> = { expense: "expense", income: "income", transfer: "transfer" };

export const OFFLINE_MESSAGE = "You're offline — this entry can't be saved yet";
export const NETWORK_MESSAGE = "Couldn't reach the server";
export const NO_RATE_MESSAGE =
  "No rate available — enter what your bank charged; it'll be valued when a rate is published";

type SaveProblem = { type: "network" } | { type: "conflict" } | { type: "other"; message: string } | null;

/** The one drawer for adding and editing expenses, income and transfers. Mounted by the shell's DrawerHost. */
export function EntryDrawer() {
  const drawer = useDrawer();
  if (!drawer.open) return null;
  return (
    <OpenEntryDrawer key={drawer.mode === "edit" ? `edit:${drawer.entryId}` : "create"} drawer={drawer} />
  );
}

function OpenEntryDrawer({ drawer }: { drawer: Extract<DrawerState, { open: true }> }) {
  const editing = drawer.mode === "edit";
  const defaults = useDrawerDefaults();
  const entryQuery = useEntry(editing ? drawer.entryId : undefined);
  const draft = useDrawerDraft(defaults.meId ? draftKey(defaults.meId, drawer.mode, drawer.entryId) : null);

  const [form, setForm] = useState<EntryForm | null>(null);
  const [dirty, setDirty] = useState(false);
  /** The entry as the form was loaded from it: what tells the partner's own edits apart after a conflict. */
  const [baseline, setBaseline] = useState<EntryForm | null>(null);

  // Start the form once its inputs are known: a saved draft wins over defaults or the loaded entry.
  const entry = entryQuery.data;
  const canStart = defaults.ready && (!editing || (entry !== undefined && entry.kind !== "adjustment"));
  useEffect(() => {
    if (form || !canStart) return;
    if (editing && entry) setBaseline(formFromEntry(entry));
    const restored = draft.load();
    if (restored) {
      setForm(restored);
      setDirty(true);
    } else {
      setForm(editing && entry ? formFromEntry(entry) : defaults.newForm(drawer.kind));
    }
  }, [form, canStart, draft, editing, entry, defaults, drawer.kind]);

  useEffect(() => {
    if (form && dirty) draft.save(form);
  }, [form, dirty, draft]);

  const cancel = () => {
    draft.clear();
    closeDrawer();
  };

  const kind = form?.kind ?? (entry && entry.kind !== "adjustment" ? entry.kind : drawer.kind);
  const title = `${editing ? "Edit" : "New"} ${KIND_LABEL[kind]}`;

  let body: ReactNode;
  if (editing && entry?.kind === "adjustment") {
    body = <p className="text-muted">Adjustments are changed from the account's reconciliation.</p>;
  } else if (editing && entryQuery.isError) {
    body = <p className="text-negative">Couldn't load this entry.</p>;
  } else if (!form) {
    body = <p className="text-muted">Loading…</p>;
  }

  if (body || !form) {
    return (
      <Sheet open onClose={cancel} title={editing && entry?.kind === "adjustment" ? "Adjustment" : title}>
        {body}
      </Sheet>
    );
  }

  return (
    <EntryFormSheet
      title={title}
      form={form}
      entry={editing ? entry : undefined}
      defaults={defaults}
      onChange={(next) => {
        setForm(next);
        setDirty(true);
      }}
      onPrefill={setForm}
      onReload={async () => {
        const fresh = (await entryQuery.refetch()).data;
        if (!fresh || fresh.kind === "adjustment") return;
        setForm((current) => (current && baseline ? rebaseForm(current, baseline, fresh) : current));
        setBaseline(formFromEntry(fresh));
        setDirty(true);
      }}
      onSaved={() => {
        draft.clear();
        closeDrawer();
        toast("Saved");
      }}
      onDeleted={() => {
        draft.clear();
        closeDrawer();
      }}
      onCancel={cancel}
    />
  );
}

type FormSheetProps = {
  title: string;
  form: EntryForm;
  entry: Entry | undefined;
  defaults: ReturnType<typeof useDrawerDefaults>;
  onChange: (form: EntryForm) => void;
  /** Rate prefills change the form without making it a draft worth keeping. */
  onPrefill: (form: EntryForm) => void;
  /** Loads the entry as it now is and rebases the form on it, keeping the partner's own edits. */
  onReload: () => Promise<void>;
  onSaved: () => void;
  onDeleted: () => void;
  onCancel: () => void;
};

function parsedMinor(input: string, currency: CurrencyCode | undefined): number | null {
  if (!currency) return null;
  const result = parseAmount(input, currency);
  return result.ok && result.minor > 0 ? result.minor : null;
}

/** Writes a rate-based prefill into a field the partner hasn't typed into. */
function usePrefillField(
  prefill: Prefill,
  applies: boolean,
  touched: boolean,
  current: string,
  currency: CurrencyCode | undefined,
  write: (value: string) => void,
) {
  const next =
    !applies || touched || !currency
      ? null
      : prefill.state === "ok"
        ? minorToDecimalString(prefill.minor, currency)
        : prefill.state === "unavailable" || prefill.state === "idle"
          ? ""
          : null;
  useEffect(() => {
    if (next !== null && next !== current) write(next);
  }, [next, current, write]);
}

function EntryFormSheet({
  title,
  form,
  entry,
  defaults,
  onChange,
  onPrefill,
  onReload,
  onSaved,
  onDeleted,
  onCancel,
}: FormSheetProps) {
  const formId = useId();
  const online = useOnline();
  const create = useCreateEntry();
  const update = useUpdateEntry();
  const remove = useDeleteEntry();
  const projects = useProjects();
  const [errors, setErrors] = useState<FieldErrors>({});
  const [problem, setProblem] = useState<SaveProblem>(null);

  const editing = entry !== undefined;
  const { currencyOf, accounts, activeAccounts } = defaults;
  const accountCurrency = currencyOf(form.accountId);
  const toCurrency = currencyOf(form.toAccountId);
  const accountName = accounts.find((a) => a.id === form.accountId)?.name ?? "account";
  const toAccountName = accounts.find((a) => a.id === form.toAccountId)?.name ?? "account";
  const showAccountAmount = needsAccountAmount(form, currencyOf);
  const showToAmount = needsToAmount(form, currencyOf);
  const pending = create.isPending || update.isPending;

  const accountPrefill = useConvertedPrefill({
    amountMinor: parsedMinor(form.amount, form.currency),
    from: form.kind === "transfer" ? undefined : form.currency,
    to: accountCurrency,
    date: form.date,
    today: defaults.today,
  });
  const toPrefill = useConvertedPrefill({
    amountMinor: parsedMinor(form.amount, accountCurrency),
    from: form.kind === "transfer" ? accountCurrency : undefined,
    to: toCurrency,
    date: form.date,
    today: defaults.today,
  });

  // A prefill still fetching its rate would save the previous conversion; a typed amount never waits.
  const prefillLoading =
    (showAccountAmount && !form.accountAmountTouched && accountPrefill.state === "loading") ||
    (showToAmount && !form.toAmountTouched && toPrefill.state === "loading");
  const canSave = online && !pending && !prefillLoading;

  usePrefillField(
    accountPrefill,
    showAccountAmount,
    form.accountAmountTouched,
    form.accountAmount,
    accountCurrency,
    (accountAmount) => onPrefill({ ...form, accountAmount }),
  );
  usePrefillField(toPrefill, showToAmount, form.toAmountTouched, form.toAmount, toCurrency, (toAmount) =>
    onPrefill({ ...form, toAmount }),
  );

  const set = (patch: Partial<EntryForm>) => {
    onChange({ ...form, ...patch });
    for (const key of Object.keys(patch))
      if (errors[fieldKey(key)]) setErrors((e) => ({ ...e, [fieldKey(key)]: undefined }));
  };

  const setKind = (kind: EntryKind) => {
    const previousDefault = defaults.accountFor(form.kind)?.id;
    const nextAccount = form.accountId === previousDefault ? defaults.accountFor(kind) : undefined;
    const accountId = nextAccount?.id ?? form.accountId;
    const toAccountId =
      kind === "transfer" && (!form.toAccountId || form.toAccountId === accountId)
        ? (activeAccounts.find((a) => a.id !== accountId)?.id ?? "")
        : form.toAccountId;
    set({ kind, categoryId: "", ...accountChange(accountId), toAccountId });
  };

  /** A new account brings its currency along when the amount was in the old account's currency. */
  const accountChange = (accountId: string): Partial<EntryForm> => {
    const oldCurrency = currencyOf(form.accountId);
    const newCurrency = currencyOf(accountId);
    const patch: Partial<EntryForm> = { accountId };
    if (newCurrency && form.currency === oldCurrency) patch.currency = newCurrency;
    if (newCurrency !== oldCurrency) {
      patch.accountAmountTouched = false;
      patch.toAmountTouched = false;
    }
    return patch;
  };

  const buildRequest = (): { run: () => Promise<unknown> } | { errors: FieldErrors } => {
    if (editing) {
      const patch = toEntryPatch(form, currencyOf);
      return patch.ok ? { run: () => update.mutateAsync({ id: form.id, patch: patch.value }) } : patch;
    }
    const input = toEntryCreate(form, currencyOf);
    return input.ok ? { run: () => create.mutateAsync(input.value) } : input;
  };

  /** Saves the form. A retry skips the offline check: it is the partner's explicit "try the network again". */
  const submit = async (retry = false) => {
    if (pending || prefillLoading || (!online && !retry)) return;
    const request = buildRequest();
    if ("errors" in request) {
      setErrors(request.errors);
      return;
    }
    setErrors({});
    setProblem(null);
    try {
      await request.run();
      onSaved();
    } catch (err) {
      if (err instanceof TypeError) setProblem({ type: "network" });
      else if (err instanceof ApiError && err.status === 409) setProblem({ type: "conflict" });
      else if (err instanceof ApiError && err.status === 422) {
        const issues = (err.body as { issues?: ValidationIssue[] } | null)?.issues ?? [];
        const mapped = errorsFromIssues(issues);
        setErrors(mapped);
        if (mapped.form) setProblem({ type: "other", message: mapped.form });
      } else setProblem({ type: "other", message: errorMessage(err, "Couldn't save — try again") });
    }
  };

  const reload = async () => {
    await onReload();
    setProblem(null);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    const target = event.target;
    if (target instanceof HTMLTextAreaElement) {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        void submit();
      }
      return;
    }
    const textual =
      (target instanceof HTMLInputElement && target.type !== "radio" && target.type !== "checkbox") ||
      target instanceof HTMLSelectElement;
    if (textual) {
      event.preventDefault();
      void submit();
    }
  };

  const accountOptions = (selected: string) => {
    const list = activeAccounts.some((a) => a.id === selected)
      ? activeAccounts
      : [...activeAccounts, ...accounts.filter((a) => a.id === selected)];
    return list.map((a) => (
      <option key={a.id} value={a.id}>
        {a.name} ({a.currency})
      </option>
    ));
  };

  const activeProjects = (projects.data ?? []).filter((p) => !p.archived || p.id === form.projectId);

  const footer = (
    <div className="flex flex-col gap-2">
      {!online && <p className="text-sm text-negative">{OFFLINE_MESSAGE}</p>}
      {problem?.type === "network" && (
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-negative">{NETWORK_MESSAGE}</p>
          <Button variant="outline" size="sm" onClick={() => void submit(true)} disabled={pending}>
            Retry
          </Button>
        </div>
      )}
      {problem?.type === "conflict" && (
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-negative">{CONFLICT_MESSAGE}</p>
          {editing && (
            <Button variant="outline" size="sm" onClick={() => void reload()}>
              Reload
            </Button>
          )}
        </div>
      )}
      {problem?.type === "other" && <p className="text-sm text-negative">{problem.message}</p>}
      <div className="flex items-center gap-2">
        {editing && entry && (
          <Button
            variant="danger"
            onClick={() => {
              remove.mutate(entry);
              onDeleted();
            }}
          >
            Delete
          </Button>
        )}
        <Button type="submit" form={formId} className="flex-1" disabled={!canSave}>
          {pending ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );

  return (
    <Sheet open onClose={onCancel} title={title} footer={footer}>
      <form
        id={formId}
        noValidate
        onKeyDown={onKeyDown}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        className="flex flex-col gap-5"
      >
        {!editing && <TypeSwitch value={form.kind} onChange={setKind} />}

        <AmountField
          label="Amount"
          large
          autoFocus
          value={form.amount}
          onChange={(amount) => set({ amount })}
          error={errors.amountMinor}
          currency={form.kind === "transfer" ? (accountCurrency ?? form.currency) : form.currency}
          onCurrencyChange={form.kind === "transfer" ? undefined : (currency) => set({ currency })}
        />

        <Field label={form.kind === "transfer" ? "From" : "Account"} error={errors.accountId}>
          {(id, describedBy) => (
            <Select
              id={id}
              aria-describedby={describedBy}
              aria-invalid={errors.accountId ? true : undefined}
              value={form.accountId}
              onChange={(e) => set(accountChange(e.target.value))}
            >
              {form.accountId === "" && <option value="">Choose an account</option>}
              {accountOptions(form.accountId)}
            </Select>
          )}
        </Field>

        {showAccountAmount && accountCurrency && (
          <AmountField
            label={`Amount on ${accountName} (${accountCurrency})`}
            value={form.accountAmount}
            onChange={(accountAmount) => set({ accountAmount, accountAmountTouched: true })}
            error={errors.accountAmountMinor}
            currency={accountCurrency}
            hint={accountPrefill.state === "unavailable" ? NO_RATE_MESSAGE : undefined}
          />
        )}

        {form.kind === "transfer" && (
          <Field label="To" error={errors.toAccountId}>
            {(id, describedBy) => (
              <Select
                id={id}
                aria-describedby={describedBy}
                aria-invalid={errors.toAccountId ? true : undefined}
                value={form.toAccountId}
                onChange={(e) => {
                  const changed = currencyOf(e.target.value) !== toCurrency;
                  set({ toAccountId: e.target.value, ...(changed ? { toAmountTouched: false } : {}) });
                }}
              >
                {form.toAccountId === "" && <option value="">Choose an account</option>}
                {accountOptions(form.toAccountId)}
              </Select>
            )}
          </Field>
        )}

        {showToAmount && toCurrency && (
          <AmountField
            label={`Arrived in ${toAccountName} (${toCurrency})`}
            value={form.toAmount}
            onChange={(toAmount) => set({ toAmount, toAmountTouched: true })}
            error={errors.toAmountMinor}
            currency={toCurrency}
            hint={toPrefill.state === "unavailable" ? NO_RATE_MESSAGE : undefined}
          />
        )}

        {form.kind !== "transfer" && (
          <CategoryPicker
            type={form.kind}
            value={form.categoryId}
            onChange={(categoryId) => set({ categoryId })}
            topIds={defaults.topCategories[form.kind]}
            error={errors.categoryId}
          />
        )}

        <Field label="Date" error={errors.date}>
          {(id, describedBy) => (
            <Input
              id={id}
              type="date"
              aria-describedby={describedBy}
              aria-invalid={errors.date ? true : undefined}
              value={form.date}
              onChange={(e) => set({ date: e.target.value })}
            />
          )}
        </Field>

        {form.kind !== "transfer" && defaults.partners.length > 0 && (
          <Field label="Partner" error={errors.userId}>
            {(id, describedBy) => (
              <Select
                id={id}
                aria-describedby={describedBy}
                value={form.userId}
                onChange={(e) => set({ userId: e.target.value })}
              >
                {defaults.partners.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.id === defaults.meId ? `${p.name} (me)` : p.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}

        {form.kind === "transfer" ? (
          <NotesField value={form.notes} onChange={(notes) => set({ notes })} error={errors.notes} />
        ) : (
          <details open={Boolean(form.projectId || form.notes) || undefined} className="group">
            <summary className="flex min-h-11 cursor-pointer items-center text-sm text-muted hover:text-fg">
              More
            </summary>
            <div className="flex flex-col gap-5 pt-2">
              <Field label="Project" error={errors.projectId}>
                {(id, describedBy) => (
                  <Select
                    id={id}
                    aria-describedby={describedBy}
                    value={form.projectId}
                    onChange={(e) => set({ projectId: e.target.value })}
                  >
                    <option value="">No project</option>
                    {activeProjects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <NotesField value={form.notes} onChange={(notes) => set({ notes })} error={errors.notes} />
            </div>
          </details>
        )}
      </form>
    </Sheet>
  );
}

/** Form keys that differ from the API's issue paths. */
function fieldKey(key: string): string {
  const map: Record<string, string> = {
    amount: "amountMinor",
    accountAmount: "accountAmountMinor",
    toAmount: "toAmountMinor",
  };
  return map[key] ?? key;
}

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: (id: string, describedBy: string | undefined) => ReactNode;
}) {
  const id = useId();
  const errorId = `${id}-error`;
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      {children(id, error ? errorId : undefined)}
      {error && (
        <p id={errorId} className="text-sm text-negative">
          {error}
        </p>
      )}
    </div>
  );
}

function NotesField({
  value,
  onChange,
  error,
}: {
  value: string;
  onChange: (v: string) => void;
  error?: string;
}) {
  return (
    <Field label="Notes" error={error}>
      {(id, describedBy) => (
        <textarea
          id={id}
          aria-describedby={describedBy}
          maxLength={NOTES_MAX}
          rows={3}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={cn(fieldClass, "resize-y")}
        />
      )}
    </Field>
  );
}
