import type { ChangedSinceReconcile } from "@shared/schemas/account";

export { accountBalances } from "./entries";

/**
 * SQL scalar for an account's balance at the end of a day: opening + income + adjustments
 * − expenses − transfers out + transfers in, over entries dated on or before that day.
 * `account` and `date` are SQL expressions (placeholders or column references). NULL when the
 * account doesn't exist, so a comparison against it is never true.
 */
export function balanceAsOfSql(account: string, date: string): string {
  return `((SELECT opening_minor FROM accounts WHERE id = ${account})
    + COALESCE((SELECT SUM(CASE WHEN kind IN ('income', 'adjustment') THEN account_amount_minor
                                ELSE -account_amount_minor END)
                FROM entries WHERE account_id = ${account} AND date <= ${date}), 0)
    + COALESCE((SELECT SUM(to_amount_minor) FROM entries
                WHERE to_account_id = ${account} AND kind = 'transfer' AND date <= ${date}), 0))`;
}

/** The account's balance at the end of `date`; null when the account doesn't exist. */
export async function balanceAsOf(d1: D1Database, accountId: string, date: string): Promise<number | null> {
  const row = await d1
    .prepare(`SELECT ${balanceAsOfSql("?1", "?2")} AS balance`)
    .bind(accountId, date)
    .first<{ balance: number | null }>();
  return row?.balance ?? null;
}

/**
 * For each account's latest reconciliation, how much the balance as of its date has moved away from
 * the bank balance entered then. Accounts with no reconciliation, or no change, are left out.
 */
export async function changesSinceReconcile(
  d1: D1Database,
  accountIds?: string[],
): Promise<Record<string, ChangedSinceReconcile>> {
  const filter = accountIds ? "AND r.account_id IN (SELECT value FROM json_each(?1))" : "";
  const stmt = d1.prepare(
    `SELECT r.account_id, r.date, r.bank_balance_minor,
            ${balanceAsOfSql("r.account_id", "r.date")} - r.bank_balance_minor AS delta
     FROM reconciliations r
     WHERE r.id = (SELECT r2.id FROM reconciliations r2 WHERE r2.account_id = r.account_id
                   ORDER BY r2.date DESC, r2.created_at DESC, r2.id DESC LIMIT 1) ${filter}`,
  );
  const { results } = await (accountIds ? stmt.bind(JSON.stringify(accountIds)) : stmt).all<{
    account_id: string;
    date: string;
    bank_balance_minor: number;
    delta: number;
  }>();
  const out: Record<string, ChangedSinceReconcile> = {};
  for (const r of results) {
    if (r.delta !== 0) {
      out[r.account_id] = { date: r.date, bankBalanceMinor: r.bank_balance_minor, deltaMinor: r.delta };
    }
  }
  return out;
}
