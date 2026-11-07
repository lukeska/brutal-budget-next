import type { ArgonParams, SaltResponse } from "@shared/auth";
import type { ProfilePatch, SettingsResponse } from "@shared/schemas/settings";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { deriveKey, newSalt } from "../auth/derive-key";
import { meQueryKey } from "../auth/use-me";

export const settingsQueryKey = ["settings"] as const;

export function useSettings(enabled = true) {
  return useQuery({
    queryKey: settingsQueryKey,
    queryFn: () => api.get<SettingsResponse>("/api/settings"),
    enabled,
  });
}

export function useUpdateProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: ProfilePatch) => api.patch<SettingsResponse>("/api/settings/profile", patch),
    onSuccess: (data) => {
      queryClient.setQueryData(settingsQueryKey, data);
      void queryClient.invalidateQueries({ queryKey: meQueryKey });
    },
  });
}

/** Derives the signed-in partner's current key from their password, plus the household parameters. */
async function currentKeyFor(email: string, password: string): Promise<{ key: string; params: ArgonParams }> {
  const { salt, params } = await api.post<SaltResponse>("/api/auth/salt", { email });
  return { key: await deriveKey(password, salt, params), params };
}

export async function changeEmail(myEmail: string, currentPassword: string, email: string) {
  const { key } = await currentKeyFor(myEmail, currentPassword);
  return api.post<{ ok: true; email: string }>("/api/settings/email", { currentKey: key, email });
}

export async function changePassword(myEmail: string, currentPassword: string, newPassword: string) {
  const { key, params } = await currentKeyFor(myEmail, currentPassword);
  const salt = newSalt();
  const newVerifierKey = await deriveKey(newPassword, salt, params);
  return api.post("/api/auth/password", { currentKey: key, newSalt: salt, newVerifierKey });
}

export async function resetPartnerPassword(myEmail: string, currentPassword: string, temporary: string) {
  const { key, params } = await currentKeyFor(myEmail, currentPassword);
  const partnerNewSalt = newSalt();
  const partnerNewKey = await deriveKey(temporary, partnerNewSalt, params);
  return api.post("/api/auth/password/reset-partner", { currentKey: key, partnerNewSalt, partnerNewKey });
}

/** A readable temporary password (no look-alike characters) to pass on to the partner. */
export function temporaryPassword(length = 12): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  // Rejection sampling keeps every character equally likely.
  const limit = 256 - (256 % alphabet.length);
  let out = "";
  while (out.length < length) {
    for (const b of crypto.getRandomValues(new Uint8Array(length))) {
      if (b < limit && out.length < length) out += alphabet[b % alphabet.length];
    }
  }
  return out;
}
