/**
 * Tierkit VS Code companion.
 *
 * What this extension does:
 *   1. **Auto-starts the runtime daemon in-process.** No separate `tierkit runtime start`
 *      terminal needed — the extension host (Node.js) calls `startServer()` from
 *      `@tierkit/core` directly. The daemon shares the extension host's lifetime: it dies
 *      when VS Code closes. If a Tierkit daemon is already reachable at the configured URL
 *      (e.g. the user is running one in a terminal), we use that one and don't start a
 *      duplicate. Behavior controlled by the `tierkit.autoStartDaemon` setting.
 *   2. **Renders the dashboard in a sidebar webview.** The HTML is `GUI_HTML` from
 *      `@tierkit/core`, the same page the daemon serves at `/`. CSP injection allows
 *      loopback fetches; `window.__TIERKIT_BASE_URL__` is set so the page knows where to
 *      hit the daemon.
 *   3. **Registers a command palette + status bar item.**
 *
 * It does **not** patch or shim Roo / Zoo / Cline / Continue. Those extensions either
 * call the same daemon directly via `@tierkit/client`, or they don't get Tierkit's policy.
 */
import * as vscode from "vscode";
import { TierkitClient, TierkitClientError } from "@tierkit/client";
import { GUI_HTML, startServer, type RunningServer } from "@tierkit/core";

let statusItem: vscode.StatusBarItem | undefined;
let serverHandle: RunningServer | undefined;
/** Set when we successfully start (or detect) a daemon. Overrides config-derived baseUrl. */
let effectiveBaseUrl: string | undefined;
let sidebarRef: TierkitSidebarProvider | undefined;

function configBaseUrl(): string {
  const config = vscode.workspace.getConfiguration("tierkit");
  return config.get<string>("baseUrl") ?? "http://127.0.0.1:4101";
}

function baseUrl(): string {
  return effectiveBaseUrl ?? configBaseUrl();
}

function makeClient(): TierkitClient {
  return new TierkitClient({ baseUrl: baseUrl() });
}

/**
 * Probe `${url}/v1/health`. Returns true only if a Tierkit-shaped response comes back —
 * that protects against accidentally adopting some unrelated service on the same port.
 */
async function isTierkitDaemonAt(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/v1/health`, { signal: AbortSignal.timeout(800) });
    if (!res.ok) return false;
    const body = await res.json();
    return Boolean(body?.ok && typeof body?.version === "string");
  } catch {
    return false;
  }
}

/**
 * Auto-start the daemon in-process. Fires-and-forgets (the rest of `activate()` doesn't
 * block on it). When the daemon is ready, re-renders the sidebar so the webview picks up
 * the actual base URL.
 *
 * Order of operations:
 *   1. Honor `tierkit.autoStartDaemon: false` — bail out.
 *   2. If a daemon is already at the configured baseUrl, use it.
 *   3. Otherwise start one on the configured port. If the port is busy with non-Tierkit,
 *      fall back to a free port (0) and notify the user.
 *   4. If no workspace folder is open, can't determine cwd — surface a hint and stop.
 */
async function maybeStartDaemon(): Promise<void> {
  const config = vscode.workspace.getConfiguration("tierkit");
  if (config.get<boolean>("autoStartDaemon") === false) return;

  const configured = configBaseUrl();
  if (await isTierkitDaemonAt(configured)) {
    effectiveBaseUrl = configured;
    sidebarRef?.render();
    return;
  }

  const workspace = vscode.workspace.workspaceFolders?.[0];
  if (!workspace) {
    void vscode.window.showInformationMessage(
      vscode.l10n.t("Tierkit: Open a folder to auto-start the runtime, or start it from a terminal with `tierkit runtime start`."),
    );
    return;
  }

  let port = 4101;
  try {
    const u = new URL(configured);
    port = Number.parseInt(u.port, 10) || 4101;
  } catch {
    /* keep default */
  }

  try {
    serverHandle = await startServer({ cwd: workspace.uri.fsPath, host: "127.0.0.1", port });
    effectiveBaseUrl = `http://127.0.0.1:${serverHandle.port}`;
  } catch {
    // Port likely taken by something else. Try a free one.
    try {
      serverHandle = await startServer({ cwd: workspace.uri.fsPath, host: "127.0.0.1", port: 0 });
      effectiveBaseUrl = `http://127.0.0.1:${serverHandle.port}`;
      void vscode.window.showInformationMessage(
        vscode.l10n.t(
          "Tierkit: port {0} was busy; started daemon on {1} instead.",
          String(port),
          String(serverHandle.port),
        ),
      );
    } catch (e2) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t(
          "Tierkit could not auto-start daemon ({0}). Run `tierkit runtime start` in a terminal.",
          (e2 as Error).message,
        ),
      );
      return;
    }
  }
  sidebarRef?.render();
}

/**
 * Sidebar webview provider. Renders the same `GUI_HTML` the daemon serves at `/`, with
 * a CSP meta + bootstrap script injected so:
 *   - inline scripts/styles execute (the GUI is single-file),
 *   - `connect-src` allows loopback fetches to the daemon,
 *   - `window.__TIERKIT_BASE_URL__` is set so the page hits the right host:port.
 *
 * `retainContextWhenHidden` keeps webview state when the user flips to another sidebar
 * and back. The provider also re-renders when:
 *   - `tierkit.baseUrl` changes (user reconfigures),
 *   - the auto-started daemon becomes ready (effectiveBaseUrl updates).
 */
class TierkitSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "tierkit.sidebar";
  private current?: vscode.WebviewView;

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.current = webviewView;
    webviewView.onDidDispose(() => {
      if (this.current === webviewView) this.current = undefined;
    });
    this.render();

    const sub = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("tierkit.baseUrl")) this.render();
    });
    webviewView.onDidDispose(() => sub.dispose());
  }

  render(): void {
    if (!this.current) return;
    this.current.webview.options = { enableScripts: true, localResourceRoots: [] };
    this.current.webview.html = wrapHtmlForWebview(GUI_HTML, baseUrl());
  }
}

function wrapHtmlForWebview(html: string, base: string): string {
  const csp =
    `<meta http-equiv="Content-Security-Policy" content="` +
    `default-src 'none'; ` +
    `style-src 'unsafe-inline'; ` +
    `script-src 'unsafe-inline'; ` +
    `connect-src http://127.0.0.1:* http://localhost:*; ` +
    `img-src data: https:; ` +
    `font-src data:;` +
    `">`;
  const bootstrap = `<script>window.__TIERKIT_BASE_URL__ = ${JSON.stringify(base)};</script>`;
  return html.replace(/<head>/i, `<head>\n${csp}\n${bootstrap}`);
}

async function withClient<T>(action: (c: TierkitClient) => Promise<T>): Promise<T | undefined> {
  try {
    return await action(makeClient());
  } catch (err) {
    if (err instanceof TierkitClientError) {
      void vscode.window.showErrorMessage(
        vscode.l10n.t("Tierkit: {0} — {1}", err.code, err.message),
      );
    } else {
      void vscode.window.showErrorMessage(`Tierkit error: ${(err as Error).message}`);
    }
    return undefined;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  // ── Auto-start the daemon in-process (fire and forget). ──
  void maybeStartDaemon();

  // ── Sidebar dashboard webview ──
  sidebarRef = new TierkitSidebarProvider();
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(TierkitSidebarProvider.viewType, sidebarRef, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("tierkit.focusSidebar", () => {
      void vscode.commands.executeCommand("workbench.view.extension.tierkit");
    }),
  );

  // ── Status bar ──
  const config = vscode.workspace.getConfiguration("tierkit");
  if (config.get<boolean>("statusBar") !== false) {
    statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusItem.text = "$(sync~spin) Tierkit";
    statusItem.tooltip = vscode.l10n.t("Tierkit runtime status");
    statusItem.command = "tierkit.health";
    statusItem.show();
    context.subscriptions.push(statusItem);
    void refreshStatus();
    const timer = setInterval(refreshStatus, 30_000);
    context.subscriptions.push({ dispose: () => clearInterval(timer) });
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("tierkit.health", async () => {
      const h = await withClient((c) => c.health());
      if (h)
        void vscode.window.showInformationMessage(
          vscode.l10n.t("Tierkit runtime {0} OK at {1}", h.version, h.cwd),
        );
    }),

    vscode.commands.registerCommand("tierkit.routeExplain", async () => {
      const task = await vscode.window.showInputBox({
        prompt: vscode.l10n.t("Task to explain (Tierkit route)"),
        placeHolder: vscode.l10n.t("rename a helper function"),
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
        prompt: vscode.l10n.t("Task to run through Tierkit"),
        placeHolder: vscode.l10n.t("summarize this project"),
      });
      if (!task) return;
      const profile = await vscode.window.showInputBox({
        prompt: vscode.l10n.t("Profile id (leave blank for auto-routing)"),
        placeHolder: "localFast",
      });
      const out = vscode.window.createOutputChannel("Tierkit");
      out.show(true);
      out.appendLine(`→ tierkit route run "${task}"${profile ? ` --profile ${profile}` : ""}`);
      try {
        const client = makeClient();
        if (!profile) {
          out.appendLine(vscode.l10n.t("(auto-route via /v1/llm-call requires explicit profileId in this scaffold — pass one)"));
          return;
        }
        const req = { profileId: profile, messages: [{ role: "user" as const, content: task }] };
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
      const cmd = await vscode.window.showInputBox({ prompt: vscode.l10n.t("Shell command to classify") });
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
      const r = await withClient((c) => c.session());
      if (!r) return;
      if (!r.session) {
        void vscode.window.showInformationMessage(
          vscode.l10n.t("Tierkit: no current session (freedom={0}). Open the Tierkit sidebar to start one.", r.freedom),
        );
        return;
      }
      void vscode.window.showInformationMessage(
        vscode.l10n.t(
          "Tierkit session {0} — state={1}{2} — open the Tierkit sidebar for full controls.",
          r.session.id.slice(0, 8),
          r.session.state,
          r.session.planApproved ? ", plan ✓" : "",
        ),
      );
      await vscode.commands.executeCommand("tierkit.focusSidebar");
    }),
  );
}

async function refreshStatus(): Promise<void> {
  if (!statusItem) return;
  try {
    const client = makeClient();
    const h = await client.health();
    statusItem.text = `$(check) Tierkit ${h.version}`;
    statusItem.tooltip = vscode.l10n.t("Tierkit runtime {0} OK at {1}", h.version, h.cwd);
  } catch {
    statusItem.text = "$(circle-slash) Tierkit";
    statusItem.tooltip = vscode.l10n.t("Tierkit runtime not reachable. Open a folder, or run `tierkit runtime start` in a terminal.");
  }
}

export function deactivate(): void {
  statusItem?.dispose();
  // Close our in-process daemon if we started it (no-op if user is running one in a terminal).
  serverHandle?.close().catch(() => {
    /* ignore — VS Code is shutting down anyway */
  });
}
