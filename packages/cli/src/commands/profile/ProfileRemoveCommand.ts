import { Command, Option } from "clipanion";
import { removeProfile, ProfileCrudError } from "@tierkit/core";
import type { CliContext } from "../../context/CliContext.js";

export class ProfileRemoveCommand extends Command<CliContext> {
  static override paths = [["profile", "remove"]];

  static override usage = Command.Usage({
    category: "Advanced",
    description: "Remove a model profile from tierkit.config.json (writes an explicit null entry to suppress bundled defaults)",
    examples: [
      ["Suppress a bundled default in the current workspace", "tierkit profile remove gpt4o"],
      ["Remove from user-level config", "tierkit profile remove myCustom --scope user"],
    ],
  });

  id = Option.String({ required: true });
  scope = Option.String("--scope", "workspace", { description: "workspace | user" });

  override async execute(): Promise<number> {
    if (this.scope !== "workspace" && this.scope !== "user") {
      this.context.stderr.write(`invalid --scope "${this.scope}". Use "workspace" or "user".\n`);
      return 1;
    }
    try {
      const r = await removeProfile({ cwd: this.context.cwd, id: this.id, scope: this.scope });
      this.context.stdout.write(`removed ${r.id} (suppressed in ${r.path})\n`);
      return 0;
    } catch (err) {
      if (err instanceof ProfileCrudError) {
        this.context.stderr.write(`${err.code}: ${err.message}\n`);
        return 1;
      }
      throw err;
    }
  }
}
