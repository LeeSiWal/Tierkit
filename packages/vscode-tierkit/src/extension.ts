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
 *   3. **Registers a command palette + status bar item + diagnostic Output channel.**
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
/** Diagnostic Output channel. Logs every step of auto-start so failures are debuggable. */
let outputChannel: vscode.OutputChannel | undefined;
/** Tracks the last auto-start outcome so the sidebar can render an explanation banner. */
let lastDaemonError: string | undefined;

function log(line: string): void {
  outputChannel?.appendLine(`[${new Date().toISOString()}] ${line}`);
}

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
    const body = (await res.json()) as { ok?: unknown; version?: unknown };
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
 *   3. If no workspace folder is open, can't determine cwd — surface a hint and stop.
 *   4. Otherwise start one on the configured port. If the port is busy with non-Tierkit,
 *      fall back to a free port (0).
 *
 * Every step is logged to the "Tierkit" Output channel so failures are debuggable.
 */
async function maybeStartDaemon(): Promise<void> {
  lastDaemonError = undefined;
  log("auto-start: begin");

  const config = vscode.workspace.getConfiguration("tierkit");
  if (config.get<boolean>("autoStartDaemon") === false) {
    log("auto-start: skipped — tierkit.autoStartDaemon=false");
    lastDaemonError = vscode.l10n.t("autoStart disabled: tierkit.autoStartDaemon is false");
    sidebarRef?.render();
    return;
  }

  const configured = configBaseUrl();
  log(`auto-start: probing existing daemon at ${configured}`);
  if (await isTierkitDaemonAt(configured)) {
    effectiveBaseUrl = configured;
    log(`auto-start: reusing existing daemon at ${configured}`);
    sidebarRef?.render();
    void refreshStatus();
    return;
  }

  const workspace = vscode.workspace.workspaceFolders?.[0];
  if (!workspace) {
    log("auto-start: aborted — no workspace folder open (cwd unknown)");
    lastDaemonError = vscode.l10n.t(
      "No folder is open. Tierkit needs a workspace folder to know where to read tierkit.config.json. Open a folder, then run \"Tierkit: Restart daemon\".",
    );
    void vscode.window.showInformationMessage(lastDaemonError);
    sidebarRef?.render();
    return;
  }
  log(`auto-start: cwd=${workspace.uri.fsPath}`);

  let port = 4101;
  try {
    const u = new URL(configured);
    port = Number.parseInt(u.port, 10) || 4101;
  } catch {
    /* keep default */
  }

  log(`auto-start: trying startServer({port:${port}})`);
  try {
    serverHandle = await startServer({ cwd: workspace.uri.fsPath, host: "127.0.0.1", port });
    effectiveBaseUrl = `http://127.0.0.1:${serverHandle.port}`;
    log(`auto-start: started on ${effectiveBaseUrl}`);
  } catch (err) {
    log(`auto-start: startServer({port:${port}}) failed: ${(err as Error).message}`);
    log(`auto-start: trying startServer({port:0}) (OS-assigned free port)`);
    try {
      serverHandle = await startServer({ cwd: workspace.uri.fsPath, host: "127.0.0.1", port: 0 });
      effectiveBaseUrl = `http://127.0.0.1:${serverHandle.port}`;
      log(`auto-start: started on ${effectiveBaseUrl} (fallback)`);
      void vscode.window.showInformationMessage(
        vscode.l10n.t(
          "Tierkit: port {0} was busy; started daemon on {1} instead.",
          String(port),
          String(serverHandle.port),
        ),
      );
    } catch (e2) {
      const msg = (e2 as Error).message;
      log(`auto-start: startServer({port:0}) ALSO failed: ${msg}`);
      log(`auto-start: stack: ${(e2 as Error).stack ?? "(no stack)"}`);
      lastDaemonError = vscode.l10n.t(
        "Could not auto-start the Tierkit daemon: {0}. Run \"Tierkit: Show diagnostic output\" for details.",
        msg,
      );
      void vscode.window
        .showWarningMessage(lastDaemonError, vscode.l10n.t("Open output"))
        .then((choice) => {
          if (choice) outputChannel?.show(true);
        });
      sidebarRef?.render();
      return;
    }
  }
  sidebarRef?.render();
  void refreshStatus();
}

/**
 * Sidebar webview provider. Renders the same `GUI_HTML` the daemon serves at `/`, with
 * a CSP meta + bootstrap script injected so:
 *   - inline scripts/styles execute (the GUI is single-file),
 *   - `connect-src` allows loopback fetches to the daemon,
 *   - `window.__TIERKIT_BASE_URL__` is set so the page hits the right host:port,
 *   - if auto-start failed, a banner explains the failure with a "Show output" button.
 *
 * `retainContextWhenHidden` keeps webview state when the user flips to another sidebar
 * and back. The provider also re-renders when:
 *   - `tierkit.baseUrl` changes (user reconfigures),
 *   - the auto-started daemon becomes ready (effectiveBaseUrl updates),
 *   - the user clicks "Restart daemon".
 */
class TierkitSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "tierkit.sidebar";
  private current?: vscode.WebviewView;

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.current = webviewView;
    webviewView.onDidDispose(() => {
      if (this.current === webviewView) this.current = undefined;
    });
    webviewView.webview.onDidReceiveMessage((msg) => {
      if (msg?.type === "showOutput") outputChannel?.show(true);
      else if (msg?.type === "restartDaemon") void restartDaemon();
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
    this.current.webview.html = wrapHtmlForWebview(GUI_HTML, baseUrl(), lastDaemonError);
  }
}

function wrapHtmlForWebview(html: string, base: string, errorMessage?: string): string {
  const csp =
    `<meta http-equiv="Content-Security-Policy" content="` +
    `default-src 'none'; ` +
    `style-src 'unsafe-inline'; ` +
    `script-src 'unsafe-inline'; ` +
    `connect-src http://127.0.0.1:* http://localhost:*; ` +
    `img-src data: https:; ` +
    `font-src data:;` +
    `">`;
  const errLiteral = errorMessage ? JSON.stringify(errorMessage) : "null";
  const bootstrap =
    `<script>` +
    `window.__TIERKIT_BASE_URL__ = ${JSON.stringify(base)};` +
    `window.__TIERKIT_DAEMON_ERROR__ = ${errLiteral};` +
    `window.__TIERKIT_HOST__ = "vscode";` +
    `</script>`;
  return html.replace(/<head>/i, `<head>\n${csp}\n${bootstrap}`);
}

async function restartDaemon(): Promise<void> {
  log("restart: closing existing in-process server (if any)");
  if (serverHandle) {
    try {
      await serverHandle.close();
      log("restart: existing server closed");
    } catch (err) {
      log(`restart: close failed: ${(err as Error).message}`);
    }
    serverHandle = undefined;
  }
  effectiveBaseUrl = undefined;
  lastDaemonError = undefined;
  sidebarRef?.render();
  await maybeStartDaemon();
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
  // ── Diagnostic Output channel ──
  outputChannel = vscode.window.createOutputChannel("Tierkit");
  context.subscriptions.push(outputChannel);
  log(`Tierkit extension activating — VS Code ${vscode.version}, Node ${process.version}`);
  log(`workspace folders: ${JSON.stringify((vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath))}`);

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
    vscode.commands.registerCommand("tierkit.showOutput", () => {
      outputChannel?.show(true);
    }),
    vscode.commands.registerCommand("tierkit.restartDaemon", () => {
      void restartDaemon();
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
