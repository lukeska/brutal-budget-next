import { CURRENCIES, CURRENCY_CODES, type CurrencyCode } from "@shared/money";
import type { Account } from "@shared/schemas/account";
import { createFileRoute, Link } from "@tanstack/react-router";
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
import {
  parseSignedAmount,
  useAccounts,
  useCreateAccount,
  useUpdateAccount,
} from "../../features/accounts/api";
import { errorMessage } from "../../lib/api";

export const Route = createFileRoute("/accounts/")({
  component: AccountsScreen,
});

function AccountsScreen() {
  const { data: accounts, isPending, isError } = useAccounts();
  const [adding, setAdding] = useState(false);
  const active = accounts?.filter((a) => a.archivedAt === null) ?? [];
  const archived = accounts?.filter((a) => a.archivedAt !== null) ?? [];

  return (
    <Page
      title="Accounts"
      actions={
        <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
          Add account
        </Button>
      }
    >
      {isPending && <p className="text-muted">Loading…</p>}
      {isError && <p className="text-negative">Couldn't load the accounts.</p>}
      {accounts && accounts.length === 0 && (
        <Empty
          title="No accounts yet"
          action={<Button onClick={() => setAdding(true)}>Add account</Button>}
        />
      )}
      {active.length > 0 && <AccountGroup title="Active" accounts={active} canArchive={active.length > 1} />}
      {archived.length > 0 && <AccountGroup title="Archived" accounts={archived} canArchive={false} />}
      <AddAccountSheet open={adding} onClose={() => setAdding(false)} />
    </Page>
  );
}

function AccountGroup({
  title,
  accounts,
  canArchive,
}: {
  title: string;
  accounts: Account[];
  canArchive: boolean;
}) {
  return (
    <section className="mb-10">
      <h2 className="mb-2 text-sm tracking-wide text-muted uppercase">{title}</h2>
      <ul className="border-t border-rule">
        {accounts.map((account) => (
          <AccountRow key={account.id} account={account} canArchive={canArchive} />
        ))}
      </ul>
    </section>
  );
}

function AccountRow({ account, canArchive }: { account: Account; canArchive: boolean }) {
  const update = useUpdateAccount(account.id);
  const [confirming, setConfirming] = useState(false);
  const isArchived = account.archivedAt !== null;

  function setArchived(archived: boolean) {
    update.mutate(
      { version: account.version, archived },
      {
        onSuccess: () => {
          setConfirming(false);
          toast(archived ? `${account.name} archived` : `${account.name} restored`);
        },
        onError: (err) => toast(errorMessage(err)),
      },
    );
  }

  function onArchiveClick() {
    if (account.balanceMinor !== 0) setConfirming(true);
    else setArchived(true);
  }

  return (
    <li className="border-b border-rule py-3">
      <div className="flex items-center justify-between gap-4">
        <Link
          to="/accounts/$accountId"
          params={{ accountId: account.id }}
          className="flex min-w-0 flex-1 items-baseline justify-between gap-4 hover:underline"
        >
          <span className="truncate text-lg">
            {account.name}
            <span className="ml-2 text-sm text-faint">{account.currency}</span>
          </span>
          <Money minor={account.balanceMinor} currency={account.currency} className="text-xl" />
        </Link>
        {isArchived ? (
          <Button variant="ghost" size="sm" disabled={update.isPending} onClick={() => setArchived(false)}>
            Restore
          </Button>
        ) : (
          canArchive && (
            <Button
              variant="ghost"
              size="sm"
              disabled={update.isPending || confirming}
              onClick={onArchiveClick}
            >
              Archive
            </Button>
          )
        )}
      </div>
      {confirming && (
        <div role="alert" className="mt-2 flex flex-wrap items-center gap-3 text-sm">
          <span>
            {account.name} still holds <Money minor={account.balanceMinor} currency={account.currency} />.
            Archive it anyway?
          </span>
          <Button variant="danger" size="sm" disabled={update.isPending} onClick={() => setArchived(true)}>
            Archive anyway
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
        </div>
      )}
    </li>
  );
}

function AddAccountSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const create = useCreateAccount();
  const [name, setName] = useState("");
  const [currency, setCurrency] = useState<CurrencyCode>("EUR");
  const [opening, setOpening] = useState("0");
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setName("");
    setOpening("0");
    setError(null);
  }

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
    create.mutate(
      { id: uuidv7(), name: name.trim(), currency, openingMinor: parsed.minor },
      {
        onSuccess: (account) => {
          toast(`${account.name} added`);
          reset();
          onClose();
        },
        onError: (err) => setError(errorMessage(err)),
      },
    );
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="New account"
      footer={
        <Button type="submit" form="add-account" className="w-full" disabled={create.isPending}>
          {create.isPending ? "Adding…" : "Add account"}
        </Button>
      }
    >
      <form id="add-account" className="flex flex-col gap-5" onSubmit={onSubmit}>
        <div className="flex flex-col gap-1">
          <Label htmlFor="account-name">Account name</Label>
          <Input
            id="account-name"
            required
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="account-currency">Currency</Label>
          <Select
            id="account-currency"
            value={currency}
            onChange={(e) => setCurrency(e.target.value as CurrencyCode)}
          >
            {CURRENCY_CODES.map((code) => (
              <option key={code} value={code}>
                {code} · {CURRENCIES[code].name}
              </option>
            ))}
          </Select>
          <p className="text-xs text-faint">The currency can't change once the account has entries.</p>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="account-opening">Opening balance</Label>
          <Input
            id="account-opening"
            className="font-numbers"
            value={opening}
            onChange={(e) => setOpening(e.target.value)}
          />
        </div>
        {error && (
          <p role="alert" className="text-sm text-negative">
            {error}
          </p>
        )}
      </form>
    </Sheet>
  );
}
