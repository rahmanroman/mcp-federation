import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { clientsPath, tokensPath } from "../paths.js";
import { readJson, writeJson } from "../fsutil.js";

export interface StoredTokens extends OAuthTokens {
  /** Epoch ms; computed from expires_in on save. */
  expires_at?: number;
}

type TokenFile = Record<string, StoredTokens>;
type ClientFile = Record<string, OAuthClientInformationMixed>;

export function loadTokens(service: string): StoredTokens | undefined {
  return readJson<TokenFile>(tokensPath(), {})[service];
}

export function saveTokens(service: string, tokens: OAuthTokens): void {
  const all = readJson<TokenFile>(tokensPath(), {});
  const prev = all[service];
  all[service] = {
    ...tokens,
    // Some servers omit refresh_token on refresh — keep the previous one.
    refresh_token: tokens.refresh_token ?? prev?.refresh_token,
    expires_at: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined,
  };
  writeJson(tokensPath(), all, true);
}

export function deleteTokens(service: string): void {
  const all = readJson<TokenFile>(tokensPath(), {});
  if (!(service in all)) return;
  delete all[service];
  writeJson(tokensPath(), all, true);
}

export function loadClient(service: string): OAuthClientInformationMixed | undefined {
  return readJson<ClientFile>(clientsPath(), {})[service];
}

export function saveClient(service: string, info: OAuthClientInformationMixed): void {
  const all = readJson<ClientFile>(clientsPath(), {});
  all[service] = info;
  writeJson(clientsPath(), all, true);
}

export function deleteClient(service: string): void {
  const all = readJson<ClientFile>(clientsPath(), {});
  if (!(service in all)) return;
  delete all[service];
  writeJson(clientsPath(), all, true);
}

export type TokenStatus = "valid" | "expired" | "no token";

export function tokenStatus(t: StoredTokens | undefined): TokenStatus {
  if (!t?.access_token) return "no token";
  if (t.expires_at && t.expires_at <= Date.now()) return "expired";
  return "valid";
}
