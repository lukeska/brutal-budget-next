# Moving your history from the old Brutal Budget

The old Brutal Budget (Laravel) has no export, so this repository ships a SQL query that turns its
expenses into the [CSV import format](csv-format.md):
[`scripts/export-from-brutal-budget.sql`](../scripts/export-from-brutal-budget.sql).

## Before you start

1. Finish setup in the new app and create your accounts (for example "Joint" in EUR). Import never
   creates accounts.
2. Make sure both partners exist in the new app with the **same email addresses** they used in the
   old one, so rows are matched to the right person automatically. (You can also match them by
   hand in the preview.)
3. Find your team id in the old database: `SELECT id, name FROM teams;`.

## Export

The old app ran on SQLite by default (`DB_CONNECTION=sqlite`, file `database/database.sqlite`) but
could be pointed at MySQL or MariaDB. Check `DB_CONNECTION` in the old app's `.env`.

### MySQL or MariaDB

Edit the two settings at the top of the script (`@team_id` and the `INTO OUTFILE` path), then:

```sh
mysql -u <user> -p <database> < scripts/export-from-brutal-budget.sql
```

The server writes the file, so the path must be allowed by `secure_file_priv` and your user needs
the `FILE` privilege. If that's not possible (common on managed hosting), delete the
`INTO OUTFILE ...` clause, run the query in a database tool such as TablePlus, DBeaver or
phpMyAdmin, and export the result as CSV (UTF-8, comma-separated, with the header row; the query
already returns the header as its first row, so turn off the tool's own header if it adds one).

### SQLite

The SQLite version of the query is at the bottom of the script, commented out. The differences
from MySQL are only the functions used:

| MySQL | SQLite |
|---|---|
| `DATE_FORMAT(e.date, '%Y-%m-%d')` | `strftime('%Y-%m-%d', e.date)` |
| `CAST(CAST(e.amount / 100 AS DECIMAL(15, 2)) AS CHAR)` | `printf('%.2f', e.amount / 100.0)` (divide by `100.0`, or SQLite does integer division) |
| `ROUND(e.amount / 100)` | `CAST(ROUND(e.amount / 100.0) AS INTEGER)` |
| `INTO OUTFILE ...` and a header `UNION` | `sqlite3 -header -csv` writes the header and CSV quoting |

Copy that block into a file without the leading `-- `, set the team id in its `WHERE` clause, and
run:

```sh
sqlite3 -header -csv database/database.sqlite < export.sql > brutal-budget-expenses.csv
```

## What carries over

| Old app | CSV column | Notes |
|---|---|---|
| `expenses.date` | `date` | The day part only. Dates were stored in the old app's time zone (UTC unless `APP_TIMEZONE` was set). |
| — | `type` | Always `expense`: the old app had no income. |
| `expenses.amount` | `amount` | Stored as integer cents (×100) **for every currency**, so it is divided by 100. JPY and ISK were stored ×100 too, and since they have no decimals they are rounded to whole units (`150000` → `1500` yen). |
| `currencies.code` | `currency` | Same 14 currencies in both apps. |
| — | `account_amount` | Empty. Foreign-currency expenses are converted to the account's currency at each day's exchange rate during import. |
| — | `account` | Empty. In the preview, choose the account for "Rows with no account" (e.g. Joint). |
| `categories.name` | `category` | Old categories were single-level, so `subcategory` is empty. You can add subcategories and move entries afterwards. |
| `categories.icon` | `icon` | Tabler icon names carry over unchanged. |
| `projects.name` | `project` | Created in the new app if missing. |
| `users.email` | `partner` | Matched to the partner with the same email. |
| `expenses.notes` | `notes` | |
| `expenses.is_regular` | — | Dropped: the new app has no regular/one-off flag. |

Category colours are not exported: new categories get colours from the palette, which you can
change afterwards.

## Import

1. Open **Import** in the new app and choose the CSV file.
2. Pick the account for "Rows with no account", check the partner matches, and click
   **Check for duplicates**.
3. Review the preview: the number of new rows, any rows with errors (with row numbers), and the
   categories and projects that will be created. Old expenses with a zero or negative amount, if
   any, show up as errors; tick **Skip invalid rows** to import the rest.
4. Click **Import**. Exchange rates for the file's dates are fetched first (in 90-day steps), then
   the rows are saved in chunks with a progress bar.

Running the export and import again later is safe: rows already imported are recognised and
skipped. If something looks wrong, **Undo** in the import history deletes everything that import
added.
