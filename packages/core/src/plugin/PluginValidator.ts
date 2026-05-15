import { z } from "zod";
import { PluginManifestSchema, type PluginManifest } from "./PluginManifest.js";

export type IssueSeverity = "error" | "warning";

export interface ValidationIssue {
  severity: IssueSeverity;
  path: string;
  message: string;
}

export interface ValidationOk {
  ok: true;
  manifest: PluginManifest;
  warnings: ValidationIssue[];
}

export interface ValidationFail {
  ok: false;
  issues: ValidationIssue[];
}

export type ValidationResult = ValidationOk | ValidationFail;

export interface ValidatorOptions {
  /** Treat warnings as errors. */
  strict?: boolean;
}

export function validatePluginManifest(
  raw: unknown,
  options: ValidatorOptions = {},
): ValidationResult {
  const parsed = PluginManifestSchema.safeParse(raw);

  if (!parsed.success) {
    return {
      ok: false,
      issues: zodIssues(parsed.error).map((i) => ({ ...i, severity: "error" })),
    };
  }

  const manifest = parsed.data;
  const warnings = collectWarnings(manifest);

  if (options.strict && warnings.length > 0) {
    return {
      ok: false,
      issues: warnings.map((w) => ({ ...w, severity: "error" })),
    };
  }

  return { ok: true, manifest, warnings };
}

function zodIssues(error: z.ZodError): { path: string; message: string }[] {
  return error.issues.map((issue) => ({
    path: issue.path.length === 0 ? "(root)" : issue.path.join("."),
    message: issue.message,
  }));
}

function collectWarnings(manifest: PluginManifest): ValidationIssue[] {
  const warnings: ValidationIssue[] = [];

  if (manifest.permissions.usePublicCloudModel && !manifest.permissions.usePrivateRemoteModel) {
    warnings.push({
      severity: "warning",
      path: "permissions",
      message:
        "plugin requests usePublicCloudModel but not usePrivateRemoteModel; Tierkit prefers private-remote before public-cloud.",
    });
  }

  if (manifest.permissions.registerMcp) {
    warnings.push({
      severity: "warning",
      path: "permissions.registerMcp",
      message:
        "plugin requests registerMcp; MCP server registration always requires user approval at install time.",
    });
  }

  if (manifest.permissions.runCommands && manifest.freedom.level === "free") {
    warnings.push({
      severity: "warning",
      path: "permissions.runCommands",
      message: 'freedom level "free" grants runCommands with no workflow constraints; reconsider freedom level.',
    });
  }

  if (
    manifest.modelPolicy?.publicCloudRequiresApproval === false ||
    manifest.modelPolicy?.publicCloudDefaultMode === "execute"
  ) {
    warnings.push({
      severity: "warning",
      path: "modelPolicy",
      message:
        "modelPolicy weakens Tierkit defaults for public-cloud; this will be flagged during install consent.",
    });
  }

  if (
    manifest.components.commands.length === 0 &&
    manifest.components.modes.length === 0 &&
    manifest.components.rules.length === 0 &&
    manifest.components.workflows.length === 0 &&
    manifest.components.hooks.length === 0 &&
    !manifest.components.mcpServers
  ) {
    warnings.push({
      severity: "warning",
      path: "components",
      message: "plugin defines no components; it will be a no-op when exported.",
    });
  }

  return warnings;
}
