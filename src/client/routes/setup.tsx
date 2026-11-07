import { DEFAULT_ARGON2 } from "@shared/auth";
import { CURRENCIES, CURRENCY_CODES, type CurrencyCode, parseAmount } from "@shared/money";
import { isTimeZone, type SetupRequest, type SetupStatus } from "@shared/setup";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useState } from "react";
import { deriveKey, newSalt } from "../features/auth/derive-key";
import { meQueryKey } from "../features/auth/use-me";
import { ApiError, api } from "../lib/api";

export const Route = createFileRoute("/setup")({
  component: SetupPage,
});

const setupStatusKey = ["setup", "status"] as const;
const MIN_PASSWORD_LENGTH = 8;
const STEPS = ["token", "household", "partner1", "partner2", "account", "categories"] as const;
type Step = (typeof STEPS)[number];

type Partner = { name: string; email: string; password: string; confirm: string };
const emptyPartner: Partner = { name: "", email: "", password: "", confirm: "" };

function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** A signed amount typed by the user, e.g. "-120.50", in minor units; null when it doesn't parse. */
function parseSigned(input: string, currency: CurrencyCode): number | null {
  const trimmed = input.trim();
  const negative = trimmed.startsWith("-");
  const result = parseAmount(negative ? trimmed.slice(1) : trimmed, currency);
  if (!result.ok) return null;
  return negative ? -result.minor : result.minor;
}

/** Derives a partner's login key on this device; only the key and its new salt leave the browser. */
async function securePartner(p: Partner): Promise<SetupRequest["partners"][number]> {
  const salt = newSalt();
  return { name: p.name, email: p.email, salt, key: await deriveKey(p.password, salt, DEFAULT_ARGON2) };
}

function misconfiguredMessage(err: ApiError): string {
  const detail =
    err.body && typeof err.body === "object" && "detail" in err.body && typeof err.body.detail === "string"
      ? err.body.detail
      : "A required secret is missing or too short.";
  return `${detail}. Generate a stronger value with \`openssl rand -base64 48\`, set it as a secret on this Worker (Cloudflare dashboard → Settings → Variables and Secrets, or \`npx wrangler secret put <NAME>\`), then reload.`;
}

function submitErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 403) return "That setup token is wrong.";
    if (err.status === 404) return "This deployment is already set up.";
    if (err.status === 409) return "The two partners need different email addresses.";
    if (err.status === 422) return "Some details aren't valid. Go back and check them.";
    if (err.status === 429) return "Too many attempts. Wait a minute and try again.";
    if (err.code === "misconfigured") return misconfiguredMessage(err);
  }
  return "Something went wrong. Try again.";
}

const inputClass =
  "min-h-11 border-b border-rule bg-transparent py-2 text-lg text-fg outline-none focus:border-fg";
const primaryButton = "min-h-11 flex-1 bg-fg px-4 py-3 text-base font-medium text-bg disabled:opacity-50";
const secondaryButton = "min-h-11 border border-rule px-4 py-3 text-base text-fg disabled:opacity-50";

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is passed in as children, inside the label
    <label className="flex flex-col gap-1 text-sm text-muted">
      {label}
      {children}
      {hint && <span className="text-xs text-faint">{hint}</span>}
    </label>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-4 py-10 sm:px-6">
      <h1 className="font-numbers text-4xl font-semibold tracking-tight">Brutal Budget</h1>
      {children}
    </main>
  );
}

function SetupPage() {
  const status = useQuery({
    queryKey: setupStatusKey,
    queryFn: () => api.get<SetupStatus>("/api/setup/status"),
    retry: false,
  });

  if (status.isPending) {
    return (
      <Shell>
        <p className="mt-10 text-muted">Loading…</p>
      </Shell>
    );
  }
  if (status.isError) {
    const err = status.error;
    return (
      <Shell>
        <p role="alert" className="mt-10 text-negative">
          {err instanceof ApiError && err.code === "misconfigured"
            ? misconfiguredMessage(err)
            : "Couldn't reach the server. Reload to try again."}
        </p>
      </Shell>
    );
  }
  if (!status.data.needsSetup) {
    return (
      <Shell>
        <p className="mt-10 text-lg">This household is already set up.</p>
        <Link to="/login" className={`${primaryButton} mt-6 text-center`}>
          Log in
        </Link>
      </Shell>
    );
  }
  return <Wizard />;
}

function Wizard() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [step, setStep] = useState<Step>("token");
  const [token, setToken] = useState("");
  const [baseCurrency, setBaseCurrency] = useState<CurrencyCode>("EUR");
  const [timezone, setTimezone] = useState(browserTimeZone);
  const [partners, setPartners] = useState<[Partner, Partner]>([emptyPartner, emptyPartner]);
  const [accountName, setAccountName] = useState("");
  const [accountCurrency, setAccountCurrency] = useState<CurrencyCode | null>(null);
  const [opening, setOpening] = useState("0");
  const [addDefaultCategories, setAddDefaultCategories] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "securing" | "saving">(null);

  const index = STEPS.indexOf(step);
  const currency = accountCurrency ?? baseCurrency;

  function go(to: Step) {
    setError(null);
    setStep(to);
  }

  function updatePartner(i: 0 | 1, patch: Partial<Partner>) {
    setPartners((prev) => {
      const next: [Partner, Partner] = [prev[0], prev[1]];
      next[i] = { ...next[i], ...patch };
      return next;
    });
  }

  function validate(): string | null {
    if (step === "household" && !isTimeZone(timezone.trim())) {
      return "Unknown time zone. Use a name like Europe/Rome.";
    }
    if (step === "partner1" || step === "partner2") {
      const p = partners[step === "partner1" ? 0 : 1];
      if (p.password.length < MIN_PASSWORD_LENGTH) {
        return `Use at least ${MIN_PASSWORD_LENGTH} characters for the password.`;
      }
      if (p.password !== p.confirm) return "The passwords don't match.";
      if (step === "partner2" && p.email.trim().toLowerCase() === partners[0].email.trim().toLowerCase()) {
        return "The two partners need different email addresses.";
      }
    }
    if (step === "account" && parseSigned(opening, currency) === null) {
      return `Enter the opening balance as a number, like ${CURRENCIES[currency].exponent ? "1250.00" : "1250"}.`;
    }
    return null;
  }

  async function submit() {
    const openingMinor = parseSigned(opening, currency);
    if (openingMinor === null) return go("account");
    setError(null);
    setBusy("securing");
    try {
      // One after the other: each derivation holds tens of MiB on the device.
      const first = await securePartner(partners[0]);
      const second = await securePartner(partners[1]);
      setBusy("saving");
      const body: SetupRequest = {
        setupToken: token,
        baseCurrency,
        timezone: timezone.trim(),
        argonParams: DEFAULT_ARGON2,
        partners: [first, second],
        account: { name: accountName, currency, openingMinor },
        addDefaultCategories,
      };
      await api.post("/api/setup", body);
      await queryClient.invalidateQueries({ queryKey: meQueryKey });
      queryClient.setQueryData<SetupStatus>(setupStatusKey, { needsSetup: false });
      await router.navigate({ to: "/" });
    } catch (err) {
      setBusy(null);
      setError(submitErrorMessage(err));
      if (err instanceof ApiError && err.status === 403) setStep("token");
      if (err instanceof ApiError && err.status === 404) {
        await queryClient.invalidateQueries({ queryKey: setupStatusKey });
      }
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const problem = validate();
    if (problem) return setError(problem);
    const next = STEPS[index + 1];
    if (next) return go(next);
    void submit();
  }

  return (
    <Shell>
      <p className="mt-2 text-sm text-muted">
        First-run setup · step <span className="font-numbers">{index + 1}</span> of{" "}
        <span className="font-numbers">{STEPS.length}</span>
      </p>
      <form className="mt-8 flex flex-col gap-5" onSubmit={onSubmit}>
        {step === "token" && (
          <>
            <h2 className="text-xl font-semibold">Setup token</h2>
            <p className="text-sm text-muted">
              The SETUP_TOKEN secret you chose when deploying. It proves this deployment is yours.
            </p>
            <Field label="Setup token">
              <input
                className={`${inputClass} font-mono`}
                type="password"
                autoComplete="off"
                required
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
            </Field>
          </>
        )}

        {step === "household" && (
          <>
            <h2 className="text-xl font-semibold">Household</h2>
            <Field label="Base currency" hint="All totals are shown in this currency. It can't change later.">
              <select
                className={inputClass}
                value={baseCurrency}
                onChange={(e) => setBaseCurrency(e.target.value as CurrencyCode)}
              >
                {CURRENCY_CODES.map((code) => (
                  <option key={code} value={code}>
                    {code} · {CURRENCIES[code].name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Time zone" hint="Decides when a new day starts for the household.">
              <input
                className={inputClass}
                required
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
              />
            </Field>
          </>
        )}

        {(step === "partner1" || step === "partner2") && (
          <PartnerStep
            key={step}
            title={step === "partner1" ? "Partner 1 (you)" : "Partner 2"}
            partner={partners[step === "partner1" ? 0 : 1]}
            onChange={(patch) => updatePartner(step === "partner1" ? 0 : 1, patch)}
          />
        )}

        {step === "account" && (
          <>
            <h2 className="text-xl font-semibold">First account</h2>
            <Field label="Account name" hint="For example: Joint account, Cash, Savings.">
              <input
                className={inputClass}
                required
                maxLength={100}
                value={accountName}
                onChange={(e) => setAccountName(e.target.value)}
              />
            </Field>
            <Field label="Currency" hint="An account's currency can't change once it has entries.">
              <select
                className={inputClass}
                value={currency}
                onChange={(e) => setAccountCurrency(e.target.value as CurrencyCode)}
              >
                {CURRENCY_CODES.map((code) => (
                  <option key={code} value={code}>
                    {code} · {CURRENCIES[code].name}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label={`Opening balance (${CURRENCIES[currency].symbol})`}
              hint="Use a minus sign for a debt."
            >
              <input
                className={`${inputClass} font-numbers text-4xl`}
                inputMode="decimal"
                required
                value={opening}
                onChange={(e) => setOpening(e.target.value)}
              />
            </Field>
          </>
        )}

        {step === "categories" && (
          <>
            <h2 className="text-xl font-semibold">Categories</h2>
            <label className="flex min-h-11 items-center gap-3 text-base">
              <input
                type="checkbox"
                className="size-5 accent-fg"
                checked={addDefaultCategories}
                onChange={(e) => setAddDefaultCategories(e.target.checked)}
              />
              Add default expense and income categories
            </label>
            <p className="text-sm text-muted">You can edit, add or archive categories later.</p>
          </>
        )}

        {error && (
          <p role="alert" className="text-sm text-negative">
            {error}
          </p>
        )}

        <div className="mt-4 flex gap-3">
          {index > 0 && (
            <button
              type="button"
              className={secondaryButton}
              disabled={busy !== null}
              onClick={() => go(STEPS[index - 1] ?? "token")}
            >
              Back
            </button>
          )}
          <button type="submit" className={primaryButton} disabled={busy !== null}>
            {busy === "securing"
              ? "Securing passwords…"
              : busy === "saving"
                ? "Setting up…"
                : step === "categories"
                  ? "Finish setup"
                  : "Next"}
          </button>
        </div>
      </form>
    </Shell>
  );
}

function PartnerStep({
  title,
  partner,
  onChange,
}: {
  title: string;
  partner: Partner;
  onChange: (patch: Partial<Partner>) => void;
}) {
  return (
    <>
      <h2 className="text-xl font-semibold">{title}</h2>
      <Field label="Name">
        <input
          className={inputClass}
          required
          maxLength={100}
          autoComplete="off"
          value={partner.name}
          onChange={(e) => onChange({ name: e.target.value })}
        />
      </Field>
      <Field label="Email">
        <input
          className={inputClass}
          type="email"
          required
          autoComplete="off"
          value={partner.email}
          onChange={(e) => onChange({ email: e.target.value })}
        />
      </Field>
      <Field label="Password" hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}>
        <input
          className={inputClass}
          type="password"
          required
          autoComplete="new-password"
          value={partner.password}
          onChange={(e) => onChange({ password: e.target.value })}
        />
      </Field>
      <Field label="Repeat password">
        <input
          className={inputClass}
          type="password"
          required
          autoComplete="new-password"
          value={partner.confirm}
          onChange={(e) => onChange({ confirm: e.target.value })}
        />
      </Field>
    </>
  );
}
