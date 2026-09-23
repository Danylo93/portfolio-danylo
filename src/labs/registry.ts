import type { Tool } from "./types";

const tools = new Map<string, Tool>();

/** Registers a CLI tool. Tool modules call this at import time. */
export const registerTool = (tool: Tool) => {
  tools.set(tool.name, tool);
  for (const a of tool.aliases ?? []) tools.set(a, tool);
};

export const getTool = (name: string) => tools.get(name);

export const allTools = () => Array.from(new Set(tools.values()));

export const toolNames = () => Array.from(tools.keys());
