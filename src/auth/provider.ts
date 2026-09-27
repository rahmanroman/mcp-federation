import { randomBytes } from "node:crypto";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { CALLBACK_URL } from "../paths.js";
import { effectiveScope, type ServiceConfig } from "../config.js";
import * as storage from "./storage.js";

/**
 * OAuth provider for one downstream service. The SDK drives PKCE, DCR and refresh;
 * this class only persists state and reports the authorization URL.
 */
export class GatewayOAuthProvider implements OAuthClientProvider {
  private verifier?: string;
  private lastState?: string;

  constructor(
    private readonly service: string,
    private readonly cfg: ServiceConfig,
    private readonly onAuthorizationUrl: (url: URL, state: string) => void,
  ) {}

  get redirectUrl() {
    return CALLBACK_URL;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "mcp-federation",
      redirect_uris: [CALLBACK_URL],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: this.cfg.clientSecret ? "client_secret_post" : "none",
      scope: effectiveScope(this.cfg),
    };
  }

  state(): string {
    this.lastState = randomBytes(16).toString("base64url");
    return this.lastState;
  }

  // Static client from config wins; otherwise saved DCR registration; undefined → SDK runs DCR.
  clientInformation(): OAuthClientInformationMixed | undefined {
    if (this.cfg.clientId) {
      return { client_id: this.cfg.clientId, ...(this.cfg.clientSecret ? { client_secret: this.cfg.clientSecret } : {}) };
    }
    return storage.loadClient(this.service);
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    if (!this.cfg.clientId) storage.saveClient(this.service, info);
  }

  tokens(): OAuthTokens | undefined {
    return storage.loadTokens(this.service);
  }

  saveTokens(tokens: OAuthTokens): void {
    storage.saveTokens(this.service, tokens);
    if (!tokens.refresh_token && !storage.loadTokens(this.service)?.refresh_token) {
      console.warn(`[${this.service}] No refresh_token issued — re-authorization will be required when the access token expires`);
    }
  }

  redirectToAuthorization(url: URL): void {
    const state = url.searchParams.get("state") ?? this.lastState ?? "";
    this.onAuthorizationUrl(url, state);
  }

  saveCodeVerifier(v: string): void {
    this.verifier = v;
  }

  codeVerifier(): string {
    if (!this.verifier) throw new Error("No PKCE code verifier saved");
    return this.verifier;
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    if (scope === "all" || scope === "tokens") storage.deleteTokens(this.service);
    if ((scope === "all" || scope === "client") && !this.cfg.clientId) storage.deleteClient(this.service);
    if (scope === "all" || scope === "verifier") this.verifier = undefined;
  }
}
