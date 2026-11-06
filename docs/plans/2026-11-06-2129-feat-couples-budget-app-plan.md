---
title: Brutal Budget Next - Plan
type: feat
date: 2026-11-06
topic: couples-budget-app
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-brainstorm
execution: code
---

# Brutal Budget Next - Plan

## Goal Capsule

- **Objective:** A couple can run their household finances on their own free Cloudflare deployment of an open-source app. They log every expense and income by hand, see each month's money in and out by category, and keep every account balance in line with the bank.
- **Means:** A rebuild of Brutal Budget (`../brutal-budget`, Laravel/Inertia/Vue) on a stack that runs entirely on Cloudflare services, carrying over its useful features and adding income, accounts and subcategories.
- **Product authority:** This Product Contract. Choices recorded under Key Decisions as `session-settled` are not reopened during planning.
- **Open blockers:** None. Items under Outstanding Questions are deferred to planning.

---

## Product Contract

### Summary

Brutal Budget Next is an open-source expense and income tracker for exactly two people who share a household. Each couple deploys their own copy to their own Cloudflare account. The app opens on the current month, and accounts with balances, transfers and reconciliation sit one screen away. It installs as a PWA on phones, works fully in a desktop browser, and ships every listed capability in v1.

### Problem Frame

The two users already track every shared expense by hand in Brutal Budget, and they value that "brutal" habit of facing every expense. The current app has three problems.

It is a Laravel/PHP app, so it can't run fully on Cloudflare. It's built as a multi-tenant SaaS with teams, invitations, public sign-up, onboarding and API tokens, which is more machinery than one couple needs. It also can't answer two questions a household asks: how much came in versus went out this month, and whether the money in each real account matches the app.

Income, accounts and nested categories aren't there, so the app covers only half of the household's money picture. The switch has to be complete on day one, since the couple won't run two apps side by side.

### Actors

- A1. Partner: one of the two household members. Both partners have identical rights and see all data.
- A2. Deployer: the person who sets up a copy on a Cloudflare account, usually one of the partners. The deployer may also be someone outside this household who found the open-source project.

### Key Decisions

- **One deployment per couple, with no public sign-up.** (session-settled: user-directed, chosen over a hosted multi-household service and over "self-host now, hosted later": avoids running a service and removes teams, invitations and onboarding.) Governs R1, R2, R3.
- **Shared household view only.** (session-settled: user-directed, chosen over balances with settle-up and over private per-person entries: the couple wants one combined picture, not a ledger of who owes whom.) Governs R4, R5.
- **Month-first app with accounts underneath.** (session-settled: user-directed, chosen over an accounts-first ledger and over adding category budgets: keeps the daily log-and-see-the-month loop fast.) Governs R6, R7.
- **Accounts have balances, transfers and reconciliation.** (session-settled: user-directed, chosen over accounts as plain labels and over balances without reconciliation: manual entry drifts, so the app has to show and correct the drift.) Governs R17–R21.
- **Reconciliation gaps are booked as adjustments that stay out of stats.** (session-settled: user-directed, chosen over booking an "Unreconciled" expense or income and over deciding case by case: categories and statistics never fill up with unknown entries.) Governs R20, R21.
- **One currency per account; foreign amounts are pre-converted and editable.** (session-settled: user-directed, chosen over conversion that can't be edited and over multi-currency wallet accounts: lets the entry match what the bank actually charged.) Governs R23, R24.
- **Household totals use the rate fixed on each entry's date.** (session-settled: user-directed, chosen over re-converting at today's rate: past months never change.) Governs R25.
- **Online only.** (session-settled: user-directed, chosen over offline capture with sync and over fully offline-first: least complexity.) The app shell may load offline but does not accept entries. Governs R30.
- **Generic CSV import instead of a dedicated migration.** (session-settled: user-directed, chosen over a one-off import from the old app's database and over starting fresh: anyone can use it, and the couple's history comes in through a CSV export.) Governs R28, R29.
- **Everything ships in v1.** (session-settled: user-directed: the couple switches only when the new app covers everything listed here.)
- **Stack: one Cloudflare Worker serving a Hono API and a React + Vite single-page app as static assets, with D1 as the database and a Cron Trigger for daily exchange rates.** (session-settled: user-directed, chosen over a Vue single-page app, Nuxt on Workers, and other full-stack frameworks: the larger React ecosystem and contributor pool for an open-source project, the user is fluent in React, and server-side rendering adds nothing to a private app behind a login.) Planning picks the libraries inside this shape. Governs R3, R22, R30.
- **One always-visible add button opens a single right-side drawer, with a type switch inside.** (session-settled: user-directed, chosen over a speed-dial menu and over an expense-only button: an expense stays one tap, as in the old app.) Governs R7, R31, R32.
- **Smart defaults in the drawer, with no default category.** (session-settled: user-approved, chosen over a fixed default account per partner and over remembering the last category: speed without silent mis-categorising.) Governs R33.
- **Keep the old navigation: top bar on desktop, hamburger on mobile.** (session-settled: user-directed, chosen over a bottom tab bar with a floating button and over a centre "+" tab: least change from what the couple already uses.) Governs R35.
- **Numbers-first visual style.** (session-settled: user-directed, chosen over a neo-brutalist look and over a calm, rounded default: the "brutal" honesty comes from starkness and big readable numbers, not decoration.) Governs R37.
- **Category icons stay Tabler line icons, not emojis.** (session-settled: user-directed, chosen over native, bundled colour and monochrome emojis: line icons fit the numbers-first style, look the same on every device, and old categories carry over directly.) Governs R39.
- **Two levels of categories, with separate category sets for expenses and income.** Two levels covers the needs that came up ("Food > Groceries") without building a tree editor. Expense and income categories mean different things. Governs R9, R10.

### Requirements

**Household and access**

- R1. A copy of the app serves one household with exactly two partner logins. There is no public sign-up, and no third login can be created.
- R2. The two logins are created during first-run setup of a fresh deployment. After setup, the setup path is closed.
- R3. A deployer can deploy and run the app on Cloudflare services alone, within the free tier for normal household use, by following the README without changing code. The project is published as open source.
- R4. Both partners see and can change all data: every entry, account, category, project and setting.
- R5. Every expense and income records which partner it belongs to, and lists and totals can be filtered by partner.

**Month view and entries**

- R6. The home screen shows the selected month: total income, total expenses, the net result, totals by category with subcategory breakdown, and the month's entries grouped by date. The user can step to previous and next months.
- R7. An add button is always visible on every screen: a round floating button at the bottom right on mobile, and a "+ Add" button in the top bar on desktop. One tap or click opens the entry drawer (R31) ready for an expense.
- R8. An expense or income records amount, currency, date, account, category or subcategory, partner, optional project, and optional notes. It can be edited and deleted, and swipe-to-delete works on touch devices.
- R9. Categories have a name, icon and colour, and each can have subcategories. An entry can sit on a category or on one of its subcategories, and subcategory totals roll up into their parent.
- R10. Expense categories and income categories are separate sets.
- R40. A subcategory always uses its parent's colour and has its own icon, which defaults to the parent's icon.
- R11. Each category has a detail page showing its monthly totals over time and its entries.
- R12. Projects are colour-coded tags, such as "Japan trip", that can be applied to both expenses and income. Each project has a page with its total and entries across categories.

**Statistics**

- R13. A statistics view shows the selected year by month: income, expenses and net, plus a per-category breakdown, equivalent at least to what the old dashboard and statistics pages show.
- R14. Statistics, month totals and category totals exclude transfers (R19) and balance adjustments (R20).
- R15. All household totals and statistics are shown in one household base currency, chosen at setup.
- R16. Each partner can set a personal secondary display currency and switch totals to it, as the old app allows. This is display only and uses the current rate.

**Accounts**

- R17. The household can create accounts, such as a joint current account, a personal card, cash or savings. Each account has a name, one currency and an opening balance. Accounts can be archived but not hard-deleted while entries refer to them.
- R18. The accounts screen shows every account's current balance and history. The balance is the opening balance plus income, minus expenses, plus or minus transfers and adjustments.
- R19. A transfer moves money between two accounts. It records the amount that left one account and the amount that arrived in the other, and those differ when the currencies differ (per R23).
- R20. Reconciling an account means entering the real bank balance on a date. The app shows the difference from its computed balance and can book the gap as a balance adjustment on that account.
- R21. A balance adjustment changes only that account's balance. It shows in the account's history, marked as an adjustment, and appears in no income, expense, category, project or statistics total.

**Currency**

- R22. Entries and accounts support at least the 14 currencies of the old app (EUR, USD, GBP, JPY, CAD, AUD, CHF, CNY, INR, BRL, DKK, NOK, SEK, ISK), and the app keeps daily exchange rates up to date automatically.
- R23. When an entry's or transfer's currency differs from its account's currency, the amount in the account's currency is pre-filled at that date's rate, and the user can overwrite it with what the bank actually charged.
- R24. A foreign-currency entry keeps both its original amount and currency and the amount booked to the account, and the entry list shows both.
- R25. Each entry's value in the base currency is fixed using the rate for the entry's date, so totals for past periods don't change when rates move later.

**Import**

- R26. The README documents the CSV format the app accepts.
- R27. A partner can upload a CSV of expenses and income. Before anything is saved, the app shows a preview with row-level errors.
- R28. During import, the user chooses the target account for rows that name none. Categories, subcategories and projects named in the file are matched to existing ones by name, or created.
- R29. Importing the same file twice does not silently duplicate entries.

**Interface**

- R31. One entry drawer handles creating, editing and deleting expenses, income and transfers. It slides in from the right, fills the screen on mobile and is a side panel on desktop. Tapping an existing entry opens it in the same drawer.
- R32. A segmented control at the top of the drawer switches between Expense, Income and Transfer, and the drawer opens on Expense. Switching changes the fields: Income uses income categories (R10), and Transfer shows a from-account, a to-account and a second amount when the currencies differ (R19).
- R33. When the drawer opens for a new entry, the amount field has focus (the numeric keyboard on mobile), and fields are prefilled with partner = the logged-in partner, date = today, account = the last account this partner used for that entry type, and currency = that account's currency. Category has no default: the partner's most-used categories show as one-tap chips above the full list. Project and notes sit under a "More" fold.
- R34. On desktop, a keyboard shortcut opens the drawer for a new entry, and Enter saves.
- R35. Navigation follows the old app: a top bar on desktop with Month, Accounts, Statistics, Categories, Projects and Settings, and a hamburger menu with the same items on mobile.
- R36. Reconciliation (R20) starts from an account's screen, not from the add button.
- R37. The visual style is numbers-first: near-monochrome and editorial, with generous whitespace, large tabular-figure numbers, and thin rules rather than heavy cards. The only colours are user-chosen category colours and red/green for the net result.
- R38. The app supports light and dark mode, follows the system setting by default, and has a manual override in Settings.
- R39. Category icons come from the same icon set as the old app (Tabler), so existing categories and icon names in imported files carry over unchanged.

**Platform**

- R30. The app is an installable PWA on iOS and Android, and works fully in current desktop browsers with a layout that uses the wider screen. With no connection, it shows an offline state instead of accepting entries.

### Key Flows

- F1. First-run setup
  - **Trigger:** A deployer opens a fresh deployment.
  - **Actors:** A2, A1
  - **Steps:** Choose the household base currency, create two partner logins, and create at least one account with an opening balance. Default expense and income categories are offered and can be edited later.
  - **Outcome:** The app opens on the current month, and setup can't be reached again.
  - **Covered by:** R1, R2, R15, R17
- F2. Log an expense abroad
  - **Trigger:** A partner pays ¥3,000 with the EUR joint card.
  - **Actors:** A1
  - **Steps:** Tap add, enter ¥3,000 and pick the joint account, category and partner. The account amount pre-fills at that day's rate, and the partner overwrites it with the bank's charge. Save.
  - **Outcome:** The entry shows both amounts, the joint account's balance drops by the bank's charge, and the month totals include it at the rate fixed on its date.
  - **Covered by:** R7, R8, R23, R24, R25
- F3. Reconcile an account
  - **Trigger:** A partner checks the bank app and sees a different balance from the app's.
  - **Actors:** A1
  - **Steps:** Open the account, choose reconcile, and enter the bank balance. The app shows the gap. The partner either goes and adds the missing entries, or books the remaining gap as an adjustment.
  - **Outcome:** The account balance matches the bank, and no category or statistics total has changed.
  - **Covered by:** R20, R21, R14
- F4. Bring history over from the old app
  - **Trigger:** The couple switches from Brutal Budget.
  - **Actors:** A1
  - **Steps:** Export the old data to the documented CSV format, upload it, review the preview, pick the target account for rows without one, and confirm.
  - **Outcome:** Past months appear in the month view and statistics with the old categories, projects and currencies.
  - **Covered by:** R26–R29

### Acceptance Examples

- AE1. **Covers R19, R14.** **Given** a joint EUR account and a DKK savings account, **when** a partner transfers €500 that arrives as 3,725 kr, **then** joint drops €500, savings rises 3,725 kr, and the month's income and expense totals are unchanged.
- AE2. **Covers R20, R21.** **Given** the joint account shows €2,410 and the bank shows €2,385, **when** the partner books the €25 gap as an adjustment, **then** joint shows €2,385, the adjustment appears in the joint history, and the month's expenses do not grow by €25.
- AE3. **Covers R25.** **Given** a USD 100 expense in March 2026, booked when 1 USD = €0.92, **when** the rate later moves to €0.85, **then** March 2026's totals still count it as €92.
- AE4. **Covers R9.** **Given** "Food" with subcategories "Groceries" and "Restaurants", **when** €40 is logged on Groceries and €10 directly on Food, **then** the month view shows Food €50, split into Groceries €40 and €10 on Food itself.
- AE5. **Covers R1, R2.** **Given** a deployment where setup is finished, **when** anyone opens the setup or sign-up path, **then** no new login can be created.
- AE6. **Covers R30.** **Given** a partner's phone has no signal, **when** they open the installed app and try to add an expense, **then** the app says it is offline and the entry is not silently lost or half-saved.
- AE7. **Covers R29.** **Given** a CSV that was already imported, **when** it is uploaded again, **then** the preview flags the rows as already imported and does not add duplicates by default.

### Success Criteria

- The couple stops using the old Brutal Budget within the first week of switching, with their history imported.
- Someone who has never seen the code deploys their own copy on a free Cloudflare account by following the README.
- On a phone, logging an everyday expense in the base currency takes no longer than in the old app.

### Scope Boundaries

**Deferred for later**

- Recurring or scheduled entries, such as salary and rent. This is the most likely first request after v1.
- Monthly category budgets with "remaining" amounts.
- Offline entry with later sync.
- Data export, beyond what is needed to move history in.

**Outside this product's identity**

- Bank connections or automatic transaction import. Every expense is typed by hand, which is the point of "brutal".
- Splitting expenses, balances between partners, and settling up.
- Private per-partner entries or accounts hidden from the other partner.
- More than two users, teams, invitations, public sign-up, and hosting many households on one deployment.

**Dropped from the old app**

- Push notifications, the regular/one-off expense flag, the onboarding checklist, API tokens, and team management.

### Dependencies / Assumptions

- A free exchange-rate source with daily rates for the R22 currencies, including historical dates for back-dated entries, can be called from Cloudflare.
- Cloudflare's free tier covers one household's data and traffic. This is an assumption to check during planning against the chosen storage and compute products.
- The old app has no CSV export (confirmed: no export or CSV code in `../brutal-budget/app` or its routes). Moving the couple's history needs a one-off query against the old database that writes the R26 format, outside the new app.

### Outstanding Questions

**Deferred to Planning**

- Which login method the two partners use (password, passkey, email link or Cloudflare Access), as long as R1 and R2 hold and a non-technical deployer can set it up.
- The exact CSV columns and how R29 detects duplicates.
- Which open-source license to publish under. The partners choose; this doesn't block planning.
- Which exchange-rate provider to use (Frankfurter, which serves ECB rates, is the leading candidate: free, needs no key, has historical rates and covers all R22 currencies), and how missing rates for a date are handled.

### Sources / Research

- Old app: `../brutal-budget`, Laravel 12, Jetstream teams, Inertia and Vue.
  - Data model: `../brutal-budget/database/migrations/2025_01_28_203318_create_expenses_table.php` (expense fields), `..._create_categories_table.php` (name, icon, colour), `..._create_projects_table.php`.
  - Currencies and rates: `../brutal-budget/database/migrations/0000_01_01_000000_create_currency_table.php`, `../brutal-budget/app/Console/Commands/LoadExchangeRates.php`.
  - Secondary display currency: `../brutal-budget/app/Models/User.php` (`secondary_currency_id`).
  - Screens to match or improve: `../brutal-budget/resources/js/Pages/Dashboard`, `.../Expenses`, `.../Categories`, `.../Projects`, `.../Statistics`.
