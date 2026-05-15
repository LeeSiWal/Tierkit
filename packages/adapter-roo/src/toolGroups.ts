import type { PermissionFlags } from "@tierkit/core";

/**
 * Roo Code's permission groups assignable to a custom mode.
 * `browser` and `mcp` are kept here for forward compatibility — v0.1 plugins typically
 * declare only read/edit/search/command tools, but a plugin author can opt-in.
 */
export const ROO_GROUPS = ["read", "edit", "browser", "command", "mcp"] as const;
export type RooGroup = (typeof ROO_GROUPS)[number];

/** Map Tierkit free-form tool tokens to Roo groups. Unknown tools are dropped. */
const TOOL_TO_GROUP: Record<string, RooGroup> = {
  read: "read",
  search: "read",
  grep: "read",
  list: "read",
  edit: "edit",
  write: "edit",
  patch: "edit",
  apply_diff: "edit",
  browser: "browser",
  browse: "browser",
  command: "command",
  run: "command",
  terminal: "command",
  shell: "command",
  exec: "command",
  mcp: "mcp",
};

export interface MapToolsResult {
  groups: RooGroup[];
  /** Tool tokens we recognized but dropped due to insufficient plugin permissions. */
  droppedByPermission: { tool: string; group: RooGroup; reason: string }[];
  /** Tool tokens we did not recognize at all. */
  unknown: string[];
}

/**
 * Translate Tierkit mode tools into Roo groups, filtering out groups the plugin's
 * permissions don't grant. We never "upgrade" a permission — if a plugin didn't request
 * `runCommands`, we will not emit the `command` group even if the mode listed `terminal`.
 */
export function mapToolsToGroups(tools: string[], perms: PermissionFlags): MapToolsResult {
  const set = new Set<RooGroup>();
  const unknown: string[] = [];
  for (const raw of tools) {
    const group = TOOL_TO_GROUP[raw.toLowerCase()];
    if (group) set.add(group);
    else unknown.push(raw);
  }

  const droppedByPermission: MapToolsResult["droppedByPermission"] = [];
  const filter = (group: RooGroup, granted: boolean, tool: string, reason: string) => {
    if (set.has(group) && !granted) {
      set.delete(group);
      droppedByPermission.push({ tool, group, reason });
    }
  };
  filter("edit", perms.editFiles, "edit", "plugin manifest does not grant editFiles");
  filter("command", perms.runCommands, "command", "plugin manifest does not grant runCommands");
  filter("mcp", perms.registerMcp, "mcp", "plugin manifest does not grant registerMcp");
  filter("browser", perms.useNetwork, "browser", "plugin manifest does not grant useNetwork");

  // Default: always include "read" if the plugin grants readFiles and no tools were listed.
  if (set.size === 0 && perms.readFiles) {
    set.add("read");
  }

  return { groups: [...set], droppedByPermission, unknown };
}
