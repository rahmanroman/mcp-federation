import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { DownstreamService } from "../downstreams/service.js";
import type { ToolEntry } from "./registry.js";

export const GATEWAY_INFO = "gateway_info";
export const GATEWAY_CALL = "gateway_call";

export function gatewayInfoTool(services: DownstreamService[]): Tool {
  const names = services.map((s) => s.name);
  const width = Math.max(0, ...names.map((n) => n.length));
  const lines = services.map((s) => `- ${s.name.padEnd(width)}${s.summary ? ` — ${s.summary}` : ""}`);
  return {
    name: GATEWAY_INFO,
    description:
      `MCP gateway to corporate services.\n\n` +
      `Tools of a service are hidden until you activate it: call ${GATEWAY_INFO} with the service name.\n` +
      `It returns the service's tools, and they then become available to you directly.\n` +
      `Tool descriptions are prefixed with [service] to show their origin.\n` +
      `If activated tools do not appear, call ${GATEWAY_INFO} with include_schemas=true and use ${GATEWAY_CALL}.\n\n` +
      `Available services:\n${lines.join("\n")}`,
    inputSchema: {
      type: "object",
      properties: {
        service: { type: "string", enum: names },
        include_schemas: { type: "boolean", description: "Include full input schemas (for use with gateway_call)" },
      },
      required: ["service"],
    },
  };
}

export const gatewayCallTool: Tool = {
  name: GATEWAY_CALL,
  description:
    `Call a tool of an activated service by name. Use only if the tool listed by ${GATEWAY_INFO} is not available to you directly.`,
  inputSchema: {
    type: "object",
    properties: {
      tool: { type: "string", description: `Tool name, as returned by ${GATEWAY_INFO}` },
      arguments: { type: "object" },
    },
    required: ["tool"],
  },
};

export function describeScope(svc: DownstreamService, entries: ToolEntry[], includeSchemas: boolean): string {
  const reason = svc.unavailableReason();
  const header = reason ? `${reason}\n\n` : "";
  if (entries.length === 0) return `${header}Service "${svc.name}" has no tools available yet.`;
  const body = entries
    .map((e) => {
      const line = `- ${e.tool.name}: ${e.tool.description ?? ""}`;
      return includeSchemas ? `${line}\n  inputSchema: ${JSON.stringify(e.tool.inputSchema)}` : line;
    })
    .join("\n");
  return `${header}Service "${svc.name}" activated. Tools:\n${body}`;
}
