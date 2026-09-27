import { effectivePort, loadConfig } from "./config.js";
import { Gateway } from "./gateway/server.js";
import { enableNotifications } from "./notify.js";
import { configPath } from "./paths.js";

export interface StartOptions {
  port?: number;
  notify?: boolean;
}

export async function startGateway(opts: StartOptions = {}): Promise<Gateway> {
  const cfg = loadConfig();
  const names = Object.keys(cfg.services);
  if (names.length === 0) {
    throw new Error(`No services configured. Add one with: mcp-federation add <name> <url>  (config: ${configPath()})`);
  }
  enableNotifications(opts.notify ?? cfg.notify ?? false);

  const port = effectivePort(cfg, opts.port);
  const gateway = new Gateway(cfg, port);

  // Non-blocking start: every service settles into connected / pending_auth / error, then we listen.
  await Promise.all(gateway.services.map((s) => s.start()));
  gateway.registry.rebuild();
  await gateway.listen();

  const pending = gateway.services.filter((s) => s.state !== "connected").length;
  const suffix = pending ? ` (${pending} service${pending > 1 ? "s" : ""} not connected yet)` : "";
  console.log(`\nGateway ready on http://127.0.0.1:${port}/mcp${suffix}\n`);
  return gateway;
}
