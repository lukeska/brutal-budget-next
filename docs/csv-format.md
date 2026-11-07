# CSV import format

Brutal Budget imports expenses and income from a CSV file (**Import** page, `/import`). The file is
read in your browser. Before anything is saved you see a preview: rows with errors (with their row
numbers), rows that were already imported, and the categories, subcategories and projects that will
be created.

## File rules

- UTF-8 text, with or without a byte-order mark (BOM). Excel's "CSV UTF-8" works.
- Comma-separated, with `"` quotes around values that contain commas, quotes or line breaks
  (a quote inside a quoted value is written twice: `""`).
- **A header row is required.** Column names are matched ignoring case and surrounding spaces, and
  a space or hyphen counts as `_` (`Account Amount` = `account_amount`). Column order doesn't matter,
  and unknown columns are ignored.
- Row numbers in error messages count the header as row 1, as a spreadsheet shows them.
- Empty lines are skipped.

## Columns

| Column | Required | Format |
|---|---|---|
| `date` | yes | `YYYY-MM-DD`, e.g. `2026-03-14`. No other date format is accepted. |
| `type` | yes | `expense` or `income`. `transfer` is refused: add transfers in the app. |
| `amount` | yes | Positive number with a decimal point, e.g. `12.50`. No thousands separators, no currency symbol, no minus sign. At most as many decimals as the currency has: none for JPY and ISK, two for the others. |
| `currency` | yes | Three-letter code of the amount: EUR, USD, GBP, JPY, CAD, AUD, CHF, CNY, INR, BRL, DKK, NOK, SEK or ISK. |
| `account_amount` | no | What the account was actually charged, in the **account's** currency, when it differs from `currency` (e.g. the euros your card was charged for a dollar purchase). Ignored when the currencies match. When it is empty, the amount is converted at that day's exchange rate. |
| `account` | no | Name of one of your existing accounts. Each distinct name in the file, and "no account", is matched to an account in the preview. Import never creates accounts. |
| `category` | yes | Category name. Matched to an existing category of the same type (expense or income) ignoring case and extra spaces, or created. |
| `subcategory` | no | Subcategory name under `category`. Matched the same way, or created. |
| `project` | no | Project name. Matched ignoring case, or created. |
| `partner` | yes | Who the entry belongs to: the partner's email address or name. Each distinct value is matched to one of the two partners in the preview (matching emails and names are picked automatically). |
| `notes` | no | Free text, at most 500 characters. |
| `icon` | no | A [Tabler icon](https://tabler.io/icons) component name such as `IconCoffee`, used only when the row creates a new category. Unknown names fall back to `IconTag`. |

A new category gets the next colour from the palette; a new subcategory uses its parent's colour.
You can change both afterwards.

## Example

```csv
date,type,amount,currency,account_amount,account,category,subcategory,project,partner,notes,icon
2026-03-01,income,2450.00,EUR,,Joint,Salary,,,alice@example.com,March salary,IconCash
2026-03-02,expense,64.30,EUR,,Joint,Food,Groceries,,bob@example.com,Weekly shop,IconShoppingCart
2026-03-02,expense,3.20,EUR,,Joint,Food,Coffee,,Alice,,
2026-03-02,expense,3.20,EUR,,Joint,Food,Coffee,,Alice,,
2026-03-14,expense,1800,JPY,11.05,Card,Travel,,Japan trip,bob@example.com,"Ramen, Shinjuku",IconPlaneTilt
2026-03-15,expense,25.00,USD,,Card,Travel,,Japan trip,Bob,Airport bus,
```

The two identical coffees on 2 March are both imported: identical rows are told apart by their
position among identical rows in the file.

## Importing the same file twice

Every row gets a fingerprint from its date, type, amount, currency, the account it was matched to,
its category and subcategory, its notes (ignoring case and extra spaces) and its position among
identical rows. Rows whose fingerprint is already stored are shown as **already imported** and are
never added again, so uploading a file twice, or a file that overlaps an earlier one, doesn't
create duplicates.

Changing a row's date, amount, category or notes in the file makes it a new row. Editing an
imported entry in the app doesn't change its fingerprint, so re-importing the original file still
skips it.

## Errors and undo

- Rows with errors are listed with their row numbers. To import the rest, tick **Skip invalid
  rows**; otherwise fix the file and upload it again.
- Each import is recorded in the import history on the Import page. **Undo** deletes every entry
  that import created, after showing how many of them were edited since or fall on or before a
  reconciliation. Categories and projects it created are kept.
