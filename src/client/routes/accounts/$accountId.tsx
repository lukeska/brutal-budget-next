import { CURRENCIES, CURRENCY_CODES, type CurrencyCode, minorToDecimalString } from "@shared/money";
import type { Account, HistoryRow, ReconcileConflict, Reconciliation } from "@shared/schemas/account";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { v7 as uuidv7 } from "uuid";
import { Button } from "../../components/ui/button";
import { Empty } from "../../components/ui/empty";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Money } from "../../components/ui/money";
import { Page } from "../../components/ui/page";
import { Select } from "../../components/ui/select";
import { Sheet } from "../../components/ui/sheet";
import { toast } from "../../components/ui/toast";
import { openEdit } from "../../drawer/store";
import {
  errorMessage,
  parseSignedAmount,
  useAccount,
  useAccountHistory,
  useAccounts,
  useBalanceAt,
  useBookReconciliation,
  useDeleteAccount,
  useDeleteReconciliation,
  useReconciliations,
  useUpdateAccount,
} from "../../features/accounts/api";
import { ApiError } from "../../lib/api";

export const Route = createFileRoute("/accounts/$accountId")({
  component: AccountScreen,
});

function formatDay(date: string, withYear = false): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: withYear ? "numeric" : undefined,
    timeZone: "UTC",
  });
}

function localToday(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function AccountScreen() {
  const { accountId } = Route.useParams();
  const { data: account, isPending, isError } = useAccount(accountId);
  const [sheet, setSheet] = useState<"reconcile" | "edit" | null>(null);

  if (isPending) return <Page title="Account">{<p className="text-muted">Loading…</p>}</Page>;
  if (isError || !account) {
    return (
      <Page title="Account">
        <Empty title="This account doesn't exist" action={<Link to="/accounts">Back to accounts</Link>} />
      </Page>
    );
  }

  return (
    <Page
      title={
        <span>
          {account.name}
          {account.archivedAt && <span className="ml-3 text-base font-normal text-muted">Archived</span>}
        </span>
      }
      actions={
        <>
          <Button variant="ghost" size="sm" onClick={() => setSheet("edit")}>
            Edit
          </Button>
          <Button size="sm" onClick={() => setSheet("reconcile")}>
            Reconcile
          </Button>
        </>
      }
    >
      <section className="mb-10">
        <p className="text-sm text-muted">Balance · {account.currency}</p>
        <Money
          minor={account.balanceMinor}
          currency={account.currency}
          className="text-5xl font-semibold md:text-6xl"
        />
        {account.changedSinceReconcile && (
          <p className="mt-2 text-sm text-muted">
            Changed by{" "}
            <Money
              minor={account.changedSinceReconcile.deltaMinor}
              currency={account.currency}
              signed
              className="text-fg"
            />{" "}
            since {formatDay(account.changedSinceReconcile.date)}
          </p>
        )}
      </section>

      <History account={account} />
      <Reconciliations account={account} />

      <ReconcileSheet account={account} open={sheet === "reconcile"} onClose={() => setSheet(null)} />
      {sheet === "edit" && <EditSheet account={account} onClose={() => setSheet(null)} />}
    </Page>
  );
}

// ---------- history ----------

function History({ account }: { account: Account }) {
  const history = useAccountHistory(account.id);
  const { data: accounts } = useAccounts();
  const nameOf = (id: string | null) => accounts?.find((a) => a.id === id)?.name ?? "another account";
  const rows = history.data?.pages.flatMap((p) => p.rows) ?? [];

  return (
    <section className="mb-10">
      <h2 className="mb-2 text-sm tracking-wide text-muted uppercase">History</h2>
      {history.isPending && <p className="text-muted">Loading…</p>}
      {!history.isPending && rows.length === 0 && <Empty title="No entries yet" />}
      {rows.length > 0 && (
        <ul className="border-t border-rule">
          {rows.map((row) => (
            <HistoryItem key={row.id} row={row} currency={account.currency} label={labelFor(row, nameOf)} />
          ))}
        </ul>
      )}
      {history.hasNextPage && (
        <Button
          variant="outline"
          size="sm"
          className="mt-4"
          disabled={history.isFetchingNextPage}
          onClick={() => history.fetchNextPage()}
        >
          {history.isFetchingNextPage ? "Loading…" : "Show older"}
        </Button>
      )}
    </section>
  );
}

function labelFor(row: HistoryRow, nameOf: (id: string | null) => string): string {
  if (row.kind === "adjustment") return "Balance adjustment";
  if (row.kind === "transfer") {
    const other = nameOf(row.counterpartAccountId);
    return row.deltaMinor < 0 ? `Transfer to ${other}` : `Transfer from ${other}`;
  }
  return row.notes ?? (row.kind === "income" ? "Income" : "Expense");
}

function HistoryItem({ row, currency, label }: { row: HistoryRow; currency: CurrencyCode; label: string }) {
  const marked = row.kind === "transfer" || row.kind === "adjustment";
  const content = (
    <>
      <span className="w-14 shrink-0 text-sm text-muted">{formatDay(row.date)}</span>
      <span className="min-w-0 flex-1 truncate text-left">
        {marked && (
          <span className="mr-2 border border-rule px-1 text-xs tracking-wide text-muted uppercase">
            {row.kind === "transfer" ? "Transfer" : "Adjustment"}
          </span>
        )}
        {label}
      </span>
      <span className="flex flex-col items-end">
        <Money minor={row.deltaMinor} currency={currency} signed className="text-fg" />
        <Money minor={row.balanceMinor} currency={currency} className="text-xs text-faint" />
      </span>
    </>
  );
  const rowClass = "flex w-full items-center gap-3 border-b border-rule py-3";
  if (row.kind === "adjustment") {
    return (
      <li className={rowClass} title="Adjustments change only through their reconciliation">
        {content}
      </li>
    );
  }
  const kind = row.kind;
  return (
    <li>
      <button type="button" className={`${rowClass} hover:bg-surface`} onClick={() => openEdit(row.id, kind)}>
        {content}
      </button>
    </li>
  );
}

// ---------- reconciliations ----------

function Reconciliations({ account }: { account: Account }) {
  const { data } = useReconciliations(account.id);
  const remove = useDeleteReconciliation();
  if (!data || data.length === 0) return null;

  function onDelete(rec: Reconciliation) {
    remove.mutate(rec.id, {
      onSuccess: () =>
        toast(rec.adjustmentEntryId ? "Reconciliation and its adjustment deleted" : "Reconciliation deleted"),
      onError: (err) => toast(errorMessage(err)),
    });
  }

  return (
    <section className="mb-10">
      <h2 className="mb-2 text-sm tracking-wide text-muted uppercase">Reconciliations</h2>
      <ul className="border-t border-rule">
        {data.map((rec) => (
          <li key={rec.id} className="flex items-center gap-3 border-b border-rule py-3">
            <span className="w-24 shrink-0 text-sm text-muted">{formatDay(rec.date, true)}</span>
            <span className="flex-1">
              Bank <Money minor={rec.bankBalanceMinor} currency={account.currency} />
            </span>
            <span className="text-sm text-muted">
              {rec.adjustmentMinor === null ? (
                "No gap"
              ) : (
                <>
                  Adjusted{" "}
                  <Money minor={rec.adjustmentMinor} currency={account.currency} signed className="text-fg" />
                </>
              )}
            </span>
            <Button
              variant="danger"
              size="sm"
              disabled={remove.isPending}
              aria-label={`Delete reconciliation of ${formatDay(rec.date, true)}`}
              onClick={() => onDelete(rec)}
            >
              Delete
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ReconcileSheet({
  account,
  open,
  onClose,
}: {
  account: Account;
  open: boolean;
  onClose: () => void;
}) {
  const [date, setDate] = useState(localToday);
  const [bank, setBank] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const balance = useBalanceAt(account.id, date, open);
  const book = useBookReconciliation(account.id);

  const parsed = bank.trim() === "" ? null : parseSignedAmount(bank, account.currency);
  const bankMinor = parsed?.ok ? parsed.minor : null;
  const computed = balance.data?.balanceMinor;
  const gap = bankMinor !== null && computed !== undefined ? bankMinor - computed : null;

  function close() {
    setBank("");
    setNotice(null);
    book.reset();
    onClose();
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (bankMinor === null || computed === undefined) return;
    setNotice(null);
    book.mutate(
      { id: uuidv7(), date, bankBalanceMinor: bankMinor, shownComputedMinor: computed },
      {
        onSuccess: (rec) => {
          toast(rec.adjustmentEntryId ? "Adjustment booked" : "Reconciled — no gap");
          close();
        },
        onError: (err) => {
          if (err instanceof ApiError && err.status === 409) {
            const body = err.body as ReconcileConflict;
            const newGap = bankMinor - body.computedMinor;
            setNotice(
              `The balance changed since you checked it. It is now ${minorToDecimalString(body.computedMinor, account.currency)}, so the gap is ${minorToDecimalString(newGap, account.currency)}.`,
            );
            balance.refetch();
          } else setNotice(errorMessage(err));
        },
      },
    );
  }

  return (
    <Sheet
      open={open}
      onClose={close}
      title={`Reconcile ${account.name}`}
      footer={
        <div className="flex flex-col gap-2">
          <Button type="submit" form="reconcile" className="w-full" disabled={gap === null || book.isPending}>
            {book.isPending ? "Saving…" : gap === 0 ? "Save reconciliation" : "Book adjustment"}
          </Button>
          <Button variant="ghost" className="w-full" onClick={close}>
            I'll add the missing entries
          </Button>
        </div>
      }
    >
      <form id="reconcile" className="flex flex-col gap-5" onSubmit={onSubmit}>
        <div className="flex flex-col gap-1">
          <Label htmlFor="reconcile-date">Date</Label>
          <Input
            id="reconcile-date"
            type="date"
            required
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="reconcile-bank">Bank balance ({account.currency})</Label>
          <Input
            id="reconcile-bank"
            className="font-numbers text-2xl"
            autoComplete="off"
            value={bank}
            onChange={(e) => setBank(e.target.value)}
            aria-invalid={parsed !== null && !parsed.ok}
          />
        </div>
        <dl className="grid grid-cols-2 gap-y-2 border-t border-rule pt-4">
          <dt className="text-muted">Computed</dt>
          <dd className="text-right">
            {computed === undefined ? (
              <span className="text-faint">…</span>
            ) : (
              <Money minor={computed} currency={account.currency} />
            )}
          </dd>
          <dt className="text-muted">Gap</dt>
          <dd className="text-right text-2xl" data-testid="reconcile-gap">
            {gap === null ? (
              <span className="text-faint">—</span>
            ) : (
              <Money minor={gap} currency={account.currency} signed className="text-fg" />
            )}
          </dd>
        </dl>
        {gap !== null && gap !== 0 && (
          <p className="text-sm text-muted">
            Booking adds a balance adjustment to this account only. It never counts in income, expenses or
            statistics.
          </p>
        )}
        {notice && (
          <p role="alert" className="text-sm text-negative">
            {notice}
          </p>
        )}
      </form>
    </Sheet>
  );
}

// ---------- editing ----------

function EditSheet({ account, onClose }: { account: Account; onClose: () => void }) {
  const update = useUpdateAccount(account.id);
  const remove = useDeleteAccount(account.id);
  const navigate = useNavigate();
  const [name, setName] = useState(account.name);
  const [currency, setCurrency] = useState<CurrencyCode>(account.currency);
  const [opening, setOpening] = useState(minorToDecimalString(account.openingMinor, account.currency));
  const [error, setError] = useState<string | null>(null);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const parsed = parseSignedAmount(opening, currency);
    if (!parsed.ok) {
      setError(
        `Enter the opening balance as a number, like ${CURRENCIES[currency].exponent ? "1250.00" : "1250"}.`,
      );
      return;
    }
    setError(null);
    update.mutate(
      {
        version: account.version,
        name: name.trim(),
        openingMinor: parsed.minor,
        ...(currency !== account.currency ? { currency } : {}),
      },
      {
        onSuccess: () => {
          toast("Account saved");
          onClose();
        },
        onError: (err) => setError(errorMessage(err)),
      },
    );
  }

  function onDelete() {
    remove.mutate(account.version, {
      onSuccess: () => {
        toast(`${account.name} deleted`);
        onClose();
        navigate({ to: "/accounts" });
      },
      onError: (err) => setError(errorMessage(err)),
    });
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title="Edit account"
      footer={
        <Button type="submit" form="edit-account" className="w-full" disabled={update.isPending}>
          {update.isPending ? "Saving…" : "Save"}
        </Button>
      }
    >
      <form id="edit-account" className="flex flex-col gap-5" onSubmit={onSubmit}>
        <div className="flex flex-col gap-1">
          <Label htmlFor="edit-name">Account name</Label>
          <Input
            id="edit-name"
            required
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="edit-currency">Currency</Label>
          <Select
            id="edit-currency"
            value={currency}
            disabled={account.hasEntries}
            aria-describedby={account.hasEntries ? "edit-currency-locked" : undefined}
            onChange={(e) => setCurrency(e.target.value as CurrencyCode)}
          >
            {CURRENCY_CODES.map((code) => (
              <option key={code} value={code}>
                {code} · {CURRENCIES[code].name}
              </option>
            ))}
          </Select>
          {account.hasEntries && (
            <p id="edit-currency-locked" className="text-xs text-faint">
              The currency is locked because entries already use this account.
            </p>
          )}
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="edit-opening">Opening balance</Label>
          <Input
            id="edit-opening"
            className="font-numbers"
            autoComplete="off"
            value={opening}
            onChange={(e) => setOpening(e.target.value)}
          />
        </div>
        {error && (
          <p role="alert" className="text-sm text-negative">
            {error}
          </p>
        )}
        {!account.hasEntries && (
          <Button variant="danger" className="self-start" disabled={remove.isPending} onClick={onDelete}>
            Delete account
          </Button>
        )}
      </form>
    </Sheet>
  );
}
