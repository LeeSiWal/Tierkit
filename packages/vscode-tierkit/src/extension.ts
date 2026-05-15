/**
 * Tierkit VS Code companion — v0.1 scaffold.
 *
 * This is a minimal extension that talks to a running `tierkit runtime` daemon via the
 * `@tierkit/client` SDK. It does **not** patch or shim other extensions (Roo/Zoo/Cline/Continue);
 * each of those can either call the same daemon directly OR call the commands we register here.
 *
 * Roadmap:
 * - v0.1 (this file): commands palette + status bar
 * - v0.2: tree view for installed plugins, session state
 * - v0.3: inline route-explain hover
 * - v0.4: bridge to Roo's CustomMode picker (when their extension API stabilizes)
 */
import * as vscode from "vscode";
import { TierkitClient, TierkitClientError } from "@tierkit/client";

let statusItem: vscode.StatusBarItem | undefined;

function makeClient(): TierkitClient {
  const config = vscode.workspace.getConfiguration("tierkit");
  return new TierkitClient({ baseUrl: config.get<string>("baseUrl") ?? "http://127.0.0.1:4101" });
}

async function withClient<T>(action: (c: TierkitClient) => Promise<T>): Promise<T | undefined> {
  try {
    return await action(makeClient());
  } catch (err) {
    if (err instanceof TierkitClientError) {
      void vscode.window.showErrorMessage(
        `Tierkit: ${err.code} — ${err.message}${err.code === "network-error" ? " (is `tierkit runtime start` running?)" : ""}`,
      );
    } else {
      void vscode.window.showErrorMessage(`Tierkit error: ${(err as Error).message}`);
    }
    return undefined;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  // ── Status bar ──
  const config = vscode.workspace.getConfiguration("tierkit");
  if (config.get<boolean>("statusBar") !== false) {
    statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusItem.text = "$(sync~spin) Tierkit";
    statusItem.tooltip = "Tierkit runtime status";
    statusItem.command = "tierkit.health";
    statusItem.show();
    context.subscriptions.push(statusItem);
    void refreshStatus();
    // Refresh every 30s as a soft heartbeat.
    const timer = setInterval(refreshStatus, 30_000);
    context.subscriptions.push({ dispose: () => clearInterval(timer) });
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("tierkit.health", async () => {
      const h = await withClient((c) => c.health());
      if (h) void vscode.window.showInformationMessage(`Tierkit runtime ${h.version} OK at ${h.cwd}`);
    }),

    vscode.commands.registerCommand("tierkit.routeExplain", async () => {
      const task = await vscode.window.showInputBox({
        prompt: "Task to explain (Tierkit route)",
        placeHolder: "rename a helper function",
      });
      if (!task) return;
      const r = await withClient((c) => c.routeExplain({ task }));
      if (!r) return;
      const out = vscode.window.createOutputChannel("Tierkit");
      out.show(true);
      out.appendLine(`Task: ${r.task}`);
      out.appendLine(`Score: ${r.decision.score}/100`);
      out.appendLine(`Tier:  ${r.decision.tier}${r.decision.profileId ? ` (${r.decision.profileId})` : ""}`);
      out.appendLine(`Mode:  ${r.decision.mode}  approval=${r.decision.requiresApproval ? "REQUIRED" : "no"}`);
      out.appendLine("Reasons:");
      for (const reason of r.decision.reasons) out.appendLine(`  - ${reason}`);
    }),

    vscode.commands.registerCommand("tierkit.routeRun", async () => {
      const task = await vscode.window.showInputBox({
        prompt: "Task to run through Tierkit",
        placeHolder: "summarize this project",
      });
      if (!task) return;
      const profile = await vscode.window.showInputBox({
        prompt: "Profile id (leave blank for auto-routing)",
        placeHolder: "localFast",
      });
      const out = vscode.window.createOutputChannel("Tierkit");
      out.show(true);
      out.appendLine(`→ tierkit route run "${task}"${profile ? ` --profile ${profile}` : ""}`);
      try {
        const client = makeClient();
        const req = profile
          ? { profileId: profile, messages: [{ role: "user" as const, content: task }] }
          : // For auto-routing through the daemon, the caller would first hit /v1/route to pick a profile.
            //   Tier-1 scaffold: surface that auto-route requires a profileId; future v0.2 can compose explain+run.
            undefined;
        if (!req) {
          out.appendLine("(auto-route via /v1/llm-call requires explicit profileId in this scaffold — pass one)");
          return;
        }
        for await (const evt of client.llmCallStream(req)) {
          if (evt.type === "delta") out.append(evt.text);
          else if (evt.type === "end") out.appendLine(`\n— ${evt.latencyMs}ms`);
          else if (evt.type === "usage") out.appendLine(`tokens: ${evt.inputTokens ?? "?"} in / ${evt.outputTokens ?? "?"} out`);
          else if (evt.type === "error") out.appendLine(`\n${evt.code}: ${evt.message}`);
        }
      } catch (err) {
        out.appendLine(`error: ${(err as Error).message}`);
      }
    }),

    vscode.commands.registerCommand("tierkit.checkCommand", async () => {
      const cmd = await vscode.window.showInputBox({ prompt: "Shell command to classify" });
      if (!cmd) return;
      const r = await withClient((c) => c.checkCommand(cmd));
      if (!r) return;
      const sev = r.severity.toUpperCase();
      const msg = `[${sev}] ${cmd}\n` + r.matched.map((m) => `  ${m.id}: ${m.description}`).join("\n");
      void vscode.window.showInformationMessage(msg, { modal: true });
    }),

    vscode.commands.registerCommand("tierkit.usage", async () => {
      const r = await withClient((c) => c.usage());
      if (!r) return;
      const out = vscode.window.createOutputChannel("Tierkit");
      out.show(true);
      out.appendLine(`Total: ${r.summary.totalCalls} calls (${r.summary.successfulCalls} ok, ${r.summary.failedCalls} fail)`);
      out.appendLine(`Tokens: ${r.summary.totalInputTokens} in / ${r.summary.totalOutputTokens} out`);
      out.appendLine(`Cost:   $${r.summary.totalCostUsd.toFixed(4)}`);
      out.appendLine("Per profile:");
      for (const [id, s] of Object.entries(r.summary.byProfile)) {
        out.appendLine(`  ${id}  ${s.calls} calls  $${s.costUsd.toFixed(4)}`);
      }
    }),

    vscode.commands.registerCommand("tierkit.sessionStatus", async () => {
      // The runtime daemon doesn't expose /v1/session yet in this scaffold; surface a hint.
      void vscode.window.showInformationMessage(
        "Tierkit: session status is currently CLI-only. Run `tierkit session status` in a terminal. A /v1/session endpoint is on the v1.x roadmap.",
      );
    }),
  );
}

async function refreshStatus(): Promise<void> {
  if (!statusItem) return;
  try {
    const client = makeClient();
    const h = await client.health();
    statusItem.text = `$(check) Tierkit ${h.version}`;
    statusItem.tooltip = `Tierkit runtime ${h.version} OK at ${h.cwd}`;
  } catch {
    statusItem.text = "$(circle-slash) Tierkit offline";
    statusItem.tooltip = "Tierkit runtime not reachable. Run `tierkit runtime start` in a terminal.";
  }
}

export function deactivate(): void {
  statusItem?.dispose();
}
