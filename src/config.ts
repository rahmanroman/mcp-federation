import { configPath, DEFAULT_PORT, DEFAULT_SCOPE } from "./paths.js";
import { readJson, writeJson } from "./fsutil.js";

export interface ServiceConfig {
  url: string;
  scope?: string;
  clientId?: string;
  clientSecret?: string;
  toolPrefix?: string;
  eager?: boolean;
  description?: string;
}

export interface Config {
  port?: number;
  notify?: boolean;
  lazy?: boolean;
  services: Record<string, ServiceConfig>;
}

const NAME_RE = /^[a-zA-Z0-9_-]+$/;

export function loadConfig(): Config {
  const cfg = readJson<Config>(configPath(), { services: {} });
  cfg.services ??= {};
  for (const [name, svc] of Object.entries(cfg.services)) {
    if (!NAME_RE.test(name)) throw new Error(`config.json: invalid service name "${name}" (allowed: letters, digits, _ -)`);
    if (!svc?.url) throw new Error(`config.json: service "${name}" has no url`);
    new URL(svc.url); // throws on invalid url
  }
  return cfg;
}

export function saveConfig(cfg: Config): void {
  writeJson(configPath(), cfg);
}

export const effectiveScope = (svc: ServiceConfig) => svc.scope ?? DEFAULT_SCOPE;
export const effectivePort = (cfg: Config, override?: number) => override ?? cfg.port ?? DEFAULT_PORT;
export const isValidServiceName = (name: string) => NAME_RE.test(name);
