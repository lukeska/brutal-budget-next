import type { MeResponse } from "@shared/auth";
import { CURRENCIES, CURRENCY_CODES } from "@shared/money";
import type { SettingsResponse, ThemeChoice } from "@shared/schemas/settings";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate, useRouterState } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useState } from "react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Page } from "../../components/ui/page";
import { Segmented } from "../../components/ui/segmented";
import { Select } from "../../components/ui/select";
import { toast } from "../../components/ui/toast";
import { meQueryKey, useMe } from "../../features/auth/use-me";
import {
  changeEmail,
  changePassword,
  resetPartnerPassword,
  settingsQueryKey,
  temporaryPassword,
  useSettings,
  useUpdateProfile,
} from "../../features/settings/api";
import { ApiError } from "../../lib/api";
import { setTheme } from "../../lib/theme";

export const Route = createFileRoute("/settings/")({
  component: SettingsPage,
});

const MIN_PASSWORD = 8;

const THEME_OPTIONS = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
] as const;

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return "Your current password is wrong.";
    if (err.status === 409) return "That email is already used by your partner.";
    if (err.status === 429) return "Too many attempts. Wait a few minutes and try again.";
    if (err.status === 422) return "Check the values and try again.";
  }
  return "Something went wrong. Try again.";
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: "long" });
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4 border-b border-rule pb-8">
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Label className="flex flex-col gap-1">
      {label}
      {children}
    </Label>
  );
}

function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="text-sm text-negative">
      {message}
    </p>
  );
}

function PasswordForm({ email, onDone }: { email: string; onDone: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (next.length < MIN_PASSWORD)
      return setError(`The new password needs at least ${MIN_PASSWORD} characters.`);
    if (next !== confirm) return setError("The new passwords don't match.");
    setBusy(true);
    setError(null);
    try {
      await changePassword(email, current, next);
      setCurrent("");
      setNext("");
      setConfirm("");
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form aria-label="Change password" className="flex max-w-sm flex-col gap-4" onSubmit={onSubmit}>
      <Field label="Current password">
        <Input
          type="password"
          autoComplete="current-password"
          required
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
        />
      </Field>
      <Field label="New password">
        <Input
          type="password"
          autoComplete="new-password"
          required
          minLength={MIN_PASSWORD}
          value={next}
          onChange={(e) => setNext(e.target.value)}
        />
      </Field>
      <Field label="Confirm new password">
        <Input
          type="password"
          autoComplete="new-password"
          required
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
      </Field>
      <FormError message={error} />
      <Button type="submit" disabled={busy} className="self-start">
        {busy ? "Saving…" : "Change password"}
      </Button>
    </form>
  );
}

function ForcedPasswordChange({ me }: { me: MeResponse }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const by = me.passwordResetBy?.name;
  const at = me.passwordResetAt;

  async function onDone() {
    await queryClient.invalidateQueries({ queryKey: meQueryKey });
    toast("Password changed.");
    await navigate({ to: "/" });
  }

  return (
    <Page title="Choose a new password">
      <div className="flex flex-col gap-6">
        <p role="status" className="max-w-prose">
          {by && at
            ? `Your password was reset by ${by} on ${formatDate(at)}. Choose a new password to continue.`
            : "Choose a new password to continue."}
        </p>
        <PasswordForm email={me.email} onDone={onDone} />
      </div>
    </Page>
  );
}

function ProfileSection({ settings }: { settings: SettingsResponse }) {
  const queryClient = useQueryClient();
  const update = useUpdateProfile();
  const [name, setName] = useState(settings.me.name);
  const [email, setEmail] = useState(settings.me.email);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function onSaveName(event: FormEvent) {
    event.preventDefault();
    update.mutate({ name }, { onSuccess: () => toast("Name saved.") });
  }

  async function onChangeEmail(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await changeEmail(settings.me.email, password, email);
      setPassword("");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: settingsQueryKey }),
        queryClient.invalidateQueries({ queryKey: meQueryKey }),
      ]);
      toast("Email changed.");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="Profile">
      <form aria-label="Name" className="flex max-w-sm flex-col gap-4" onSubmit={onSaveName}>
        <Field label="Name">
          <Input required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Button
          type="submit"
          variant="outline"
          className="self-start"
          disabled={update.isPending || name.trim() === settings.me.name}
        >
          Save name
        </Button>
      </form>
      <form aria-label="Change email" className="flex max-w-sm flex-col gap-4" onSubmit={onChangeEmail}>
        <Field label="Email">
          <Input
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        {email.trim().toLowerCase() !== settings.me.email && (
          <Field label="Current password">
            <Input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
        )}
        <FormError message={error} />
        <Button
          type="submit"
          variant="outline"
          className="self-start"
          disabled={busy || email.trim().toLowerCase() === settings.me.email}
        >
          {busy ? "Saving…" : "Change email"}
        </Button>
      </form>
    </Section>
  );
}

function DisplaySection({ settings }: { settings: SettingsResponse }) {
  const update = useUpdateProfile();
  const [theme, setThemeChoice] = useState<ThemeChoice>(settings.me.theme);
  const options = CURRENCY_CODES.filter((code) => code !== settings.household.baseCurrency);

  function onTheme(next: ThemeChoice) {
    setThemeChoice(next);
    setTheme(next);
    update.mutate({ theme: next });
  }

  return (
    <Section title="Display">
      <div className="max-w-sm">
        <Field label="Secondary currency">
          <Select
            value={settings.me.secondaryCurrency ?? ""}
            disabled={update.isPending}
            onChange={(e) => {
              const value = e.target.value;
              update.mutate({ secondaryCurrency: value === "" ? null : (value as (typeof options)[number]) });
            }}
          >
            <option value="">None</option>
            {options.map((code) => (
              <option key={code} value={code}>
                {code} · {CURRENCIES[code].name}
              </option>
            ))}
          </Select>
        </Field>
        <p className="mt-2 text-sm text-faint">Totals can switch to it, converted at the latest rate.</p>
      </div>
      <div className="flex max-w-sm flex-col gap-1">
        <span className="text-sm text-muted">Theme</span>
        <Segmented aria-label="Theme" options={THEME_OPTIONS} value={theme} onChange={onTheme} />
      </div>
    </Section>
  );
}

function PartnerSection({ settings }: { settings: SettingsResponse }) {
  const partner = settings.partner;
  const [password, setPassword] = useState("");
  const [temporary, setTemporary] = useState(() => temporaryPassword());
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!partner) return null;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await resetPartnerPassword(settings.me.email, password, temporary);
      setPassword("");
      setDone(temporary);
      setTemporary(temporaryPassword());
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="Partner">
      <form
        aria-label={`Reset ${partner.name}'s password`}
        className="flex max-w-sm flex-col gap-4"
        onSubmit={onSubmit}
      >
        <p className="text-sm text-muted">
          Sets a temporary password for {partner.name} and signs them out everywhere. They choose a new one at
          their next login.
        </p>
        <div className="flex flex-col gap-1">
          <span className="text-sm text-muted">Temporary password</span>
          <span className="font-numbers text-lg">{temporary}</span>
        </div>
        <Field label="Your current password">
          <Input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <FormError message={error} />
        {done && (
          <p role="status" className="text-sm">
            Done. Give {partner.name} the temporary password <span className="font-numbers">{done}</span>.
          </p>
        )}
        <Button type="submit" variant="danger" className="self-start border border-negative" disabled={busy}>
          {busy ? "Resetting…" : `Reset ${partner.name}'s password`}
        </Button>
      </form>
    </Section>
  );
}

function HouseholdSection({ settings }: { settings: SettingsResponse }) {
  const { baseCurrency, timezone } = settings.household;
  return (
    <Section title="Household">
      <dl className="grid max-w-sm grid-cols-[auto_1fr] gap-x-6 gap-y-2">
        <dt className="text-sm text-muted">Base currency</dt>
        <dd className="font-numbers">{baseCurrency}</dd>
        <dt className="text-sm text-muted">Time zone</dt>
        <dd>{timezone}</dd>
      </dl>
      <p className="max-w-prose text-sm text-faint">
        These were fixed at setup. Changing them would rewrite the value of every past entry, so they can't be
        edited.
      </p>
    </Section>
  );
}

function isForced(search: unknown, me: MeResponse | null | undefined): boolean {
  const flag = (search as Record<string, unknown> | undefined)?.["force-password"];
  return flag === 1 || flag === "1" || flag === true || me?.mustChangePassword === true;
}

export function SettingsPage() {
  const search = useRouterState({ select: (s) => s.location.search });
  const me = useMe();
  const forced = isForced(search, me.data);
  const settings = useSettings(!forced);

  if (forced) {
    return me.data ? <ForcedPasswordChange me={me.data} /> : <Page title="Settings">{null}</Page>;
  }
  if (!settings.data || !me.data) {
    return (
      <Page title="Settings">
        {settings.isError ? <FormError message="Couldn't load settings." /> : null}
      </Page>
    );
  }
  const email = me.data.email;
  return (
    <Page title="Settings">
      <div className="flex flex-col gap-8">
        <ProfileSection key={settings.data.me.email} settings={settings.data} />
        <Section title="Password">
          <PasswordForm email={email} onDone={() => toast("Password changed.")} />
        </Section>
        <DisplaySection settings={settings.data} />
        <PartnerSection settings={settings.data} />
        <HouseholdSection settings={settings.data} />
      </div>
    </Page>
  );
}
