-- Exports the old Brutal Budget (Laravel) expenses as a CSV file this app can import.
-- See docs/migrating-from-brutal-budget.md for how to run it and what happens to each field.
--
-- MySQL / MariaDB version. The SQLite version is at the bottom of this file (commented out).
--
-- 1. Set the id of your household's team (SELECT id, name FROM teams;).
-- 2. Set the output path. The MySQL server writes the file, so it must be a path the server can
--    write to (see `SHOW VARIABLES LIKE 'secure_file_priv';`) and the file must not exist yet.
--    If you can't write files on the server, remove the INTO OUTFILE clause and export the
--    result grid as CSV from a database tool instead (keep the header row).

SET @team_id = 1;

SELECT `date`, `type`, amount, currency, account_amount, account, category, subcategory, project,
       partner, notes, icon
FROM (
  -- The header row, sorted first.
  SELECT 0 AS sort_group, '' AS sort_date, 0 AS sort_id,
         'date' AS `date`, 'type' AS `type`, 'amount' AS amount, 'currency' AS currency,
         'account_amount' AS account_amount, 'account' AS account, 'category' AS category,
         'subcategory' AS subcategory, 'project' AS project, 'partner' AS partner,
         'notes' AS notes, 'icon' AS icon
  UNION ALL
  SELECT 1, DATE_FORMAT(e.`date`, '%Y-%m-%d'), e.id,
         DATE_FORMAT(e.`date`, '%Y-%m-%d'),
         -- The old app only tracked expenses.
         'expense',
         -- Amounts were stored as integer cents (x100) for every currency, JPY and ISK included.
         -- Currencies without decimals are rounded to whole units.
         CASE
           WHEN cur.code IN ('JPY', 'ISK') THEN CAST(ROUND(e.amount / 100) AS CHAR)
           ELSE CAST(CAST(e.amount / 100 AS DECIMAL(15, 2)) AS CHAR)
         END,
         cur.code,
         -- No account amounts or accounts in the old app: you pick the account in the import preview.
         '',
         '',
         cat.name,
         -- Old categories had no subcategories.
         '',
         COALESCE(p.name, ''),
         u.email,
         COALESCE(e.notes, ''),
         -- Tabler icon names carry over unchanged.
         COALESCE(cat.icon, '')
  FROM expenses e
  JOIN currencies cur ON cur.id = e.currency_id
  JOIN categories cat ON cat.id = e.category_id
  JOIN users u ON u.id = e.user_id
  LEFT JOIN projects p ON p.id = e.project_id
  WHERE e.team_id = @team_id
) AS export_rows
ORDER BY sort_group, sort_date, sort_id
INTO OUTFILE '/tmp/brutal-budget-expenses.csv'
  CHARACTER SET utf8mb4
  FIELDS TERMINATED BY ',' OPTIONALLY ENCLOSED BY '"' ESCAPED BY '"'
  LINES TERMINATED BY '\n';

-- ---------------------------------------------------------------------------------------------
-- SQLite version. Run it with the sqlite3 shell, which writes the header row itself:
--
--   sqlite3 -header -csv database/database.sqlite < export.sql > brutal-budget-expenses.csv
--
-- after copying the query below (without the leading "-- ") into export.sql and setting the
-- team id in the WHERE clause.
--
-- SELECT
--   strftime('%Y-%m-%d', e.date) AS date,
--   'expense' AS type,
--   CASE
--     WHEN cur.code IN ('JPY', 'ISK') THEN CAST(ROUND(e.amount / 100.0) AS INTEGER)
--     ELSE printf('%.2f', e.amount / 100.0)
--   END AS amount,
--   cur.code AS currency,
--   '' AS account_amount,
--   '' AS account,
--   cat.name AS category,
--   '' AS subcategory,
--   COALESCE(p.name, '') AS project,
--   u.email AS partner,
--   COALESCE(e.notes, '') AS notes,
--   COALESCE(cat.icon, '') AS icon
-- FROM expenses e
-- JOIN currencies cur ON cur.id = e.currency_id
-- JOIN categories cat ON cat.id = e.category_id
-- JOIN users u ON u.id = e.user_id
-- LEFT JOIN projects p ON p.id = e.project_id
-- WHERE e.team_id = 1
-- ORDER BY e.date, e.id;
