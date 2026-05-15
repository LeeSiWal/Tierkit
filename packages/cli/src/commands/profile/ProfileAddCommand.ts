import { Command, Option } from "clipanion";
import { addProfile, ProfileCrudError } from "@tierkit/core";
import type { CliContext } from "../../context/CliContext.js";

const VALID_TIERS = ["local-device", "private-remote", "public-cloud"] as const;
type Tier = (typeof VALID_TIERS)[number];

export class ProfileAddCommand extends Command<CliContext> {
  static override paths = [["profile", "add"]];

  static override usage = Command.Usage({
    category: "Profile",
    description: "Add a model profile to tierkit.config.json (workspace) or ~/.tierkit/config.json (user)",
    examples: [
      ["Add a local Ollama coder profile", "tierkit profile add localCoder --provider ollama --model qwen2.5-coder:7b"],
      ["Add an Anthropic profile", "tierkit profile add claudeSonnet --provider anthropic --model claude-sonnet-4-6 --apiKeyEnv ANTHROPIC_API_KEY"],
      ["Save to user-level config", "tierkit profile add myKey --provider openai --model gpt-4o --apiKeyEnv OPENAI_API_KEY --scope user"],
    ],
  });

  id = Option.String({ required: true });
  provider = Option.String("--provider", { description: "ollama | openai | anthropic" });
  model = Option.String("--model", { description: "Model name (e.g., claude-sonnet-4-6, qwen2.5-coder:7b)" });
  tier = Option.String("--tier", { description: VALID_TIERS.join(" | ") + " (auto-inferred from provider if omitted)" });
  apiKeyEnv = Option.String("--apiKeyEnv", { description: "Env var name that holds the API key (remote tiers only)" });
  baseUrl = Option.String("--baseUrl", { description: "Custom base URL (e.g., http://127.0.0.1:11434 for Ollama)" });
  scope = Option.String("--scope", "workspace", { description: "workspace | user" });

  private inferTier(provider: string | undefined): Tier {
    if (provider === "ollama") return "local-device";
    if (provider === "anthropic") return "private-remote";
    if (provider === "openai") return "public-cloud";
    return "private-remote";
  }

  override async execute(): Promise<number> {
    if (!this.provider) {
      this.context.stderr.write("--provider is required (ollama | openai | anthropic)\n");
      return 1;
    }
    if (!this.model) {
      this.context.stderr.write("--model is required\n");
      return 1;
    }
    const tier = (this.tier as Tier | undefined) ?? this.inferTier(this.provider);
    if (!VALID_TIERS.includes(tier)) {
      this.context.stderr.write(`invalid --tier "${tier}". Use one of: ${VALID_TIERS.join(", ")}\n`);
      return 1;
    }
    if (this.scope !== "workspace" && this.scope !== "user") {
      this.context.stderr.write(`invalid --scope "${this.scope}". Use "workspace" or "user".\n`);
      return 1;
    }

    const profile: Record<string, unknown> = {
      kind: tier,
      provider: this.provider,
      model: this.model,
      roles: [],
    };
    if (this.apiKeyEnv) profile.apiKeyEnv = this.apiKeyEnv;
    if (this.baseUrl) profile.baseUrl = this.baseUrl;
    if (tier === "public-cloud") {
      profile.requiresApproval = true;
      profile.defaultMode = "review-only";
    }

    try {
      const r = await addProfile({
        cwd: this.context.cwd,
        id: this.id,
        profile: profile as never,
        scope: this.scope,
      });
      this.context.stdout.write(`added ${r.id} → ${r.path}\n`);
      return 0;
    } catch (err) {
      if (err instanceof ProfileCrudError) {
        this.context.stderr.write(`${err.code}: ${err.message}\n`);
        return 1;
      }
      if (err && typeof err === "object" && "issues" in (err as Record<string, unknown>)) {
        this.context.stderr.write(`invalid profile: ${(err as Error).message}\n`);
        return 1;
      }
      throw err;
    }
  }
}
