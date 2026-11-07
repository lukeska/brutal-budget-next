import {
  RECONCILE_CONFLICT_MESSAGE,
  type ReconcileCreate,
  type Reconciliation,
} from "@shared/schemas/account";
import { HttpError } from "../lib/errors";
import { newId } from "../lib/ids";
import { nowIso } from "../lib/time";
import { balanceAsOf, balanceAsOfSql } from "./balances";

interface ReconciliationRow {
  id: string;
  account_id: string;
  date: string;
  bank_balance_minor: number;
  computed_minor: number;
  adjustment_entry_id: string | null;
  adjustment_minor: number | null;
  user_id: string;
  created_at: string;
}

const SELECT_RECONCILIATION = `SELECT r.*, e.account_amount_minor AS adjustment_minor
  FROM reconciliations r LEFT JOIN entries e ON e.id = r.adjustment_entry_id`;

function toReconciliation(r: ReconciliationRow): Reconciliation {
  return {
    id: r.id,
    accountId: r.account_id,
    date: r.date,
    bankBalanceMinor: r.bank_balance_minor,
    computedMinor: r.computed_minor,
    adjustmentEntryId: r.adjustment_entry_id,
    adjustmentMinor: r.adjustment_minor,
    userId: r.user_id,
    createdAt: r.created_at,
  };
}

async function readReconciliation(d1: D1Database, id: string): Promise<Reconciliation | null> {
  const row = await d1
    .prepare(`${SELECT_RECONCILIATION} WHERE r.id = ?1`)
    .bind(id)
    .first<ReconciliationRow>();
  return row ? toReconciliation(row) : null;
}

export async function listReconciliations(d1: D1Database, accountId: string): Promise<Reconciliation[]> {
  const { results } = await d1
    .prepare(
      `${SELECT_RECONCILIATION} WHERE r.account_id = ?1 ORDER BY r.date DESC, r.created_at DESC, r.id DESC`,
    )
    .bind(accountId)
    .all<ReconciliationRow>();
  return results.map(toReconciliation);
}

async function balanceChanged(d1: D1Database, accountId: string, date: string): Promise<HttpError> {
  const computedMinor = (await balanceAsOf(d1, accountId, date)) ?? 0;
  return new HttpError(409, "conflict", { message: RECONCILE_CONFLICT_MESSAGE, computedMinor });
}

export type BookResult = { status: 200 | 201; reconciliation: Reconciliation };

/**
 * Records a reconciliation and, when the bank balance differs from the shown computed balance, an
 * adjustment for the gap. Everything is guarded on the computed balance as of `date` still being the
 * one the client showed:
 * - with a gap, the adjustment insert is conditional and the reconciliation references it, so a failed
 *   guard leaves a dangling reference whose foreign key aborts the whole batch;
 * - without a gap, the reconciliation insert itself is conditional.
 * Posting the same reconciliation id again returns the stored one.
 */
export async function bookReconciliation(
  d1: D1Database,
  userId: string,
  accountId: string,
  input: ReconcileCreate,
): Promise<BookResult> {
  const exists = await d1.prepare("SELECT 1 FROM accounts WHERE id = ?1").bind(accountId).first();
  if (!exists) throw new HttpError(404, "not_found");

  const gap = input.bankBalanceMinor - input.shownComputedMinor;
  const now = nowIso();
  const guard = `${balanceAsOfSql("?2", "?3")} = ?4`;
  const insertReconciliation = (adjustmentId: string | null, conditional: boolean) =>
    d1
      .prepare(
        `INSERT INTO reconciliations (id, account_id, date, bank_balance_minor, computed_minor,
           adjustment_entry_id, user_id, created_at)
         SELECT ?1, ?2, ?3, ?5, ?4, ?6, ?7, ?8 ${conditional ? `WHERE ${guard}` : ""}`,
      )
      .bind(
        input.id,
        accountId,
        input.date,
        input.shownComputedMinor,
        input.bankBalanceMinor,
        adjustmentId,
        userId,
        now,
      );

  let inserted: boolean;
  try {
    if (gap === 0) {
      const { meta } = await insertReconciliation(null, true).run();
      inserted = meta.changes > 0;
    } else {
      const adjustmentId = newId();
      // Adjustments never count in totals and carry no conversion: fixed, with a zero base value.
      const insertAdjustment = d1
        .prepare(
          `INSERT INTO entries (id, kind, date, user_id, account_id, account_amount_minor,
             base_amount_minor, fx_state, version, created_at, updated_at)
           SELECT ?5, 'adjustment', ?3, ?6, ?2, ?7, 0, 'fixed', 1, ?8, ?8 WHERE ${guard}`,
        )
        .bind(null, accountId, input.date, input.shownComputedMinor, adjustmentId, userId, gap, now);
      await d1.batch([insertAdjustment, insertReconciliation(adjustmentId, false)]);
      inserted = true;
    }
  } catch (err) {
    if (!(err instanceof Error) || !/constraint failed/i.test(err.message)) throw err;
    inserted = false;
  }

  const stored = await readReconciliation(d1, input.id);
  if (!inserted) {
    // A retry of a booking that already landed; anything else means the balance moved.
    if (stored && stored.accountId === accountId) return { status: 200, reconciliation: stored };
    if (stored)
      throw new HttpError(409, "id_conflict", { message: "A reconciliation with this id already exists" });
    throw await balanceChanged(d1, accountId, input.date);
  }
  if (!stored) throw new Error("reconciliation vanished after insert");
  return { status: 201, reconciliation: stored };
}

/** Deletes a reconciliation and its adjustment together. Already gone is success. */
export async function deleteReconciliation(d1: D1Database, id: string): Promise<void> {
  const row = await d1
    .prepare("SELECT adjustment_entry_id FROM reconciliations WHERE id = ?1")
    .bind(id)
    .first<{ adjustment_entry_id: string | null }>();
  if (!row) return;
  await d1.batch([
    d1.prepare("DELETE FROM reconciliations WHERE id = ?1").bind(id),
    d1.prepare("DELETE FROM entries WHERE id = ?1 AND kind = 'adjustment'").bind(row.adjustment_entry_id),
  ]);
}
