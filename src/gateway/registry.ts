import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { DownstreamService } from "../downstreams/service.js";

export interface ToolEntry {
  scope: string;
  originalName: string;
  /** Exposed tool: prefixed name, [scope]-prefixed description. */
  tool: Tool;
}

const TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Global registry shared by all sessions. Rebuilt whenever any service's tool list changes;
 * collisions are resolved by config order (services earlier in config.json win).
 */
export class ToolRegistry {
  private byName = new Map<string, ToolEntry>();
  private byScope = new Map<string, ToolEntry[]>();
  private warned = new Set<string>();

  constructor(private readonly services: DownstreamService[]) {}

  rebuild(): void {
    this.byName.clear();
    this.byScope.clear();
    for (const svc of this.services) {
      const entries: ToolEntry[] = [];
      for (const t of svc.tools) {
        const name = (svc.cfg.toolPrefix ?? "") + t.name;
        if (!TOOL_NAME_RE.test(name)) {
          this.warnOnce(`invalid:${svc.name}:${name}`, `[gateway] WARNING: tool "${name}" from ${svc.name} has an invalid name (must match ${TOOL_NAME_RE}) — skipped`);
          continue;
        }
        const existing = this.byName.get(name);
        if (existing) {
          this.warnOnce(
            `dup:${name}:${svc.name}`,
            `[gateway] WARNING: tool "${name}" exists in both ${existing.scope} and ${svc.name} — ${existing.scope} wins (config order). Set "toolPrefix" for one of them.`,
          );
          continue;
        }
        const entry: ToolEntry = {
          scope: svc.name,
          originalName: t.name,
          tool: { ...t, name, description: `[${svc.name}] ${t.description ?? ""}`.trimEnd() },
        };
        this.byName.set(name, entry);
        entries.push(entry);
      }
      this.byScope.set(svc.name, entries);
    }
  }

  get(name: string): ToolEntry | undefined {
    return this.byName.get(name);
  }

  forScope(scope: string): ToolEntry[] {
    return this.byScope.get(scope) ?? [];
  }

  private warnOnce(key: string, msg: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    console.warn(msg);
  }
}
