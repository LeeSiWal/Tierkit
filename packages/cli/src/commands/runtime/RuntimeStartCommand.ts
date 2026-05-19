import { Command, Option } from "clipanion";
import { startRuntime, RuntimeError } from "@tierkit/core";
import type { CliContext } from "../../context/CliContext.js";

export class RuntimeStartCommand extends Command<CliContext> {
  static override paths = [["runtime", "start"]];

  static override usage = Command.Usage({
    category: "Diagnostics",
    description: "Start the Tierkit runtime daemon (foreground)",
    examples: [
      ["Start with config defaults", "tierkit runtime start"],
      ["Override port", "tierkit runtime start --port 4200"],
    ],
  });

  port = Option.String("--port", { description: "TCP port to bind. Defaults to config runtime.port (4101)." });
  host = Option.String("--host", { description: "Bind address. Defaults to config runtime.host (127.0.0.1). Never use a non-loopback address without authentication." });

  override async execute(): Promise<number> {
    try {
      const result = await startRuntime({
        cwd: this.context.cwd,
        ...(this.port !== undefined ? { port: Number.parseInt(this.port, 10) } : {}),
        ...(this.host !== undefined ? { host: this.host } : {}),
      });
      this.context.stdout.write(`Tierkit runtime started\n`);
      this.context.stdout.write(`  pid       ${result.pid}\n`);
      this.context.stdout.write(`  bound     ${result.host}:${result.port}\n`);
      this.context.stdout.write(`  base url  ${result.baseUrl}\n`);
      this.context.stdout.write(`  data dir  ${result.dataDir}\n`);
      this.context.stdout.write(`\nPress Ctrl+C to stop.\n`);

      await new Promise<void>((resolve) => {
        const shutdown = async (): Promise<void> => {
          this.context.stdout.write(`\nShutting down...\n`);
          await result.server.close();
          resolve();
        };
        process.once("SIGINT", shutdown);
        process.once("SIGTERM", shutdown);
      });
      return 0;
    } catch (err) {
      if (err instanceof RuntimeError) {
        this.context.stderr.write(`${err.code}: ${err.message}\n`);
        return 1;
      }
      throw err;
    }
  }
}
