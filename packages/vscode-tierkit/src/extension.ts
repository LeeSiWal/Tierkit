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
import { RooAdapter } from "@tierkit/adapter-roo";
import { ClineAdapter } from "@tierkit/adapter-cline";
import { ContinueAdapter } from "@tierkit/adapter-continue";
import { createAgentRouteExtension } from "@tierkit/agent";
import { createMessageRouter } from "./messageRouter.js";

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
    serverHandle = await startServer({
      cwd: workspace.uri.fsPath,
      host: "127.0.0.1",
      port,
      adapters: { roo: new RooAdapter(), cline: new ClineAdapter(), continue: new ContinueAdapter() },
      routeExtensions: [
        // 0.4.2: no forced approve handler — the daemon route picks `auto` vs `interactive`
        // per-request from the `approvalMode` body field set by the GUI's composer dropdown.
        createAgentRouteExtension(),
      ],
    });
    effectiveBaseUrl = `http://127.0.0.1:${serverHandle.port}`;
    log(`auto-start: started on ${effectiveBaseUrl}`);
  } catch (err) {
    log(`auto-start: startServer({port:${port}}) failed: ${(err as Error).message}`);
    log(`auto-start: trying startServer({port:0}) (OS-assigned free port)`);
    try {
      serverHandle = await startServer({
        cwd: workspace.uri.fsPath,
        host: "127.0.0.1",
        port: 0,
        adapters: { roo: new RooAdapter(), cline: new ClineAdapter(), continue: new ContinueAdapter() },
        routeExtensions: [createAgentRouteExtension()],
      });
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
    const router = createMessageRouter({
      getBaseUrl: () => baseUrl(),
      fetchProxy,
      streamProxy,
      log: (line) => log(`router: ${line}`),
    });
    webviewView.onDidDispose(() => router.disposeAll());

    webviewView.webview.onDidReceiveMessage((msg) => {
      if (typeof msg?.type !== "string") return;
      if (msg.type.startsWith("tk:")) {
        void router.handle(msg, (out) => webviewView.webview.postMessage(out));
        return;
      }
      // Pre-existing message types
      if (msg.type === "showOutput") outputChannel?.show(true);
      else if (msg.type === "restartDaemon") void restartDaemon();
      else if (msg.type === "previewDiff" && typeof msg.path === "string" && typeof msg.proposed === "string") {
        void previewDiff(msg.path, msg.proposed);
      }
      else if (msg.type === "openFile" && typeof msg.path === "string") {
        void openFile(msg.path);
      }
    });
    this.render();

    const sub = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("tierkit.baseUrl")) this.render();
    });
    webviewView.onDidDispose(() => sub.dispose());
  }

  render(): void {
    if (!this.current) return;
    log(`render: baseUrl=${baseUrl()} daemonError=${lastDaemonError ?? "none"}`);
    this.current.webview.options = {
      enableScripts: true,
      localResourceRoots: [],
    };
    this.current.webview.html = wrapHtmlForWebview(GUI_HTML, baseUrl(), lastDaemonError);
  }
}

function wrapHtmlForWebview(html: string, base: string, errorMessage?: string): string {
  // CSP: webview no longer fetches the daemon directly; all data flows through
  // postMessage to the extension host. So connect-src is not needed.
  const csp =
    `<meta http-equiv="Content-Security-Policy" content="` +
    `default-src 'none'; ` +
    `style-src 'unsafe-inline'; ` +
    `script-src 'unsafe-inline'; ` +
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

/**
 * Show a side-by-side diff of an existing workspace file against the proposed new content.
 * Used by the agent panel's tool_call(apply_diff/write_file) preview button. The proposed
 * content lives in a virtual `tierkit-preview:` document so it survives until the user
 * dismisses the diff view.
 */
async function previewDiff(relPath: string, proposed: string): Promise<void> {
  const workspace = vscode.workspace.workspaceFolders?.[0];
  if (!workspace) {
    void vscode.window.showErrorMessage("Tierkit: no workspace open");
    return;
  }
  // Path traversal guard — the agent only edits inside workspace, but a malicious tool
  // arg could try to escape. Strip leading /, .. components.
  const normalized = relPath.replace(/^\/+/, "").split(/[\/\\]/).filter((p) => p !== ".." && p !== "").join("/");
  const existing = vscode.Uri.joinPath(workspace.uri, normalized);
  // Stash the proposed content on a virtual document by writing to a temp untitled.
  const proposedUri = existing.with({ scheme: "tierkit-preview", path: existing.path + ".proposed" });
  proposedContentByUri.set(proposedUri.toString(), proposed);
  try {
    await vscode.commands.executeCommand(
      "vscode.diff",
      existing,
      proposedUri,
      `Tierkit: ${normalized} (proposed)`,
      { preview: true },
    );
  } catch (err) {
    void vscode.window.showErrorMessage(`Tierkit: failed to open diff — ${(err as Error).message}`);
  }
}

const proposedContentByUri = new Map<string, string>();

class TierkitPreviewProvider implements vscode.TextDocumentContentProvider {
  provideTextDocumentContent(uri: vscode.Uri): string {
    return proposedContentByUri.get(uri.toString()) ?? "";
  }
}

async function openFile(relPath: string): Promise<void> {
  const workspace = vscode.workspace.workspaceFolders?.[0];
  if (!workspace) return;
  const normalized = relPath.replace(/^\/+/, "").split(/[\/\\]/).filter((p) => p !== ".." && p !== "").join("/");
  const uri = vscode.Uri.joinPath(workspace.uri, normalized);
  try { await vscode.window.showTextDocument(uri, { preview: true }); } catch { /* ignore */ }
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

async function fetchProxy(url: string, init: { method: string; body?: string; signal: AbortSignal }): Promise<{ ok: boolean; status: number; data: unknown }> {
  const res = await fetch(url, {
    method: init.method,
    headers: init.body !== undefined ? { "content-type": "application/json" } : {},
    body: init.body,
    signal: init.signal,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

async function* streamProxy(url: string, init: { method: string; body?: string; signal: AbortSignal }): AsyncIterable<{ data: string }> {
  const res = await fetch(url, {
    method: init.method,
    headers: init.body !== undefined ? { "content-type": "application/json" } : {},
    body: init.body,
    signal: init.signal,
  });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const r = await reader.read();
      if (r.done) break;
      buf += decoder.decode(r.value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 2);
        if (!block.startsWith("data:")) continue;
        yield { data: block.slice(5).trim() };
      }
    }
  } finally {
    try { reader.cancel(); } catch { /* ignore */ }
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
    vscode.workspace.registerTextDocumentContentProvider("tierkit-preview", new TierkitPreviewProvider()),
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

    vscode.commands.registerCommand("tierkit.addModelProfile", async () => {
      const provider = await vscode.window.showQuickPick(
        [
          { label: "ollama", description: vscode.l10n.t("Local — no API key needed (auto-launches Ollama)"), value: "ollama" },
          { label: "anthropic", description: vscode.l10n.t("Claude API — needs ANTHROPIC_API_KEY"), value: "anthropic" },
          { label: "openai", description: vscode.l10n.t("OpenAI / GPT — needs OPENAI_API_KEY (public-cloud, requires approval)"), value: "openai" },
        ],
        { placeHolder: vscode.l10n.t("Pick a provider for the new model profile") },
      );
      if (!provider) return;

      const tplByProvider: Record<string, { tier: "local-device" | "private-remote" | "public-cloud"; apiKeyEnv: string; baseUrl: string; modelExample: string; idHint: string }> = {
        ollama:    { tier: "local-device",   apiKeyEnv: "",                  baseUrl: "http://127.0.0.1:11434", modelExample: "qwen2.5-coder:7b", idHint: "localCustom" },
        anthropic: { tier: "private-remote", apiKeyEnv: "ANTHROPIC_API_KEY", baseUrl: "",                       modelExample: "claude-sonnet-4-6", idHint: "claudeCustom" },
        openai:    { tier: "public-cloud",   apiKeyEnv: "OPENAI_API_KEY",    baseUrl: "",                       modelExample: "gpt-4o", idHint: "gptCustom" },
      };
      const tpl = tplByProvider[provider.value]!;

      const id = await vscode.window.showInputBox({
        prompt: vscode.l10n.t("Profile id"),
        placeHolder: tpl.idHint,
        validateInput: (v) => (/^[A-Za-z][A-Za-z0-9_-]*$/.test(v.trim()) ? null : vscode.l10n.t("must start with a letter; letters/digits/_/- only")),
      });
      if (!id) return;

      const model = await vscode.window.showInputBox({
        prompt: vscode.l10n.t("Model name"),
        value: tpl.modelExample,
      });
      if (!model) return;

      let apiKeyEnv: string | undefined;
      if (tpl.tier !== "local-device") {
        apiKeyEnv = await vscode.window.showInputBox({
          prompt: vscode.l10n.t("API key env var"),
          value: tpl.apiKeyEnv,
        });
        if (apiKeyEnv === undefined) return;
      }

      let baseUrl: string | undefined;
      if (tpl.tier === "local-device") {
        baseUrl = await vscode.window.showInputBox({
          prompt: vscode.l10n.t("Base URL"),
          value: tpl.baseUrl,
        });
        if (baseUrl === undefined) return;
      }

      const scopePick = await vscode.window.showQuickPick(
        [
          { label: vscode.l10n.t("workspace"), description: vscode.l10n.t("this project only — ./tierkit.config.json"), value: "workspace" as const },
          { label: vscode.l10n.t("user"), description: vscode.l10n.t("all folders — ~/.tierkit/config.json"), value: "user" as const },
        ],
        { placeHolder: vscode.l10n.t("Save profile to") },
      );
      if (!scopePick) return;

      const profile: Record<string, unknown> = {
        kind: tpl.tier,
        provider: provider.value,
        model: model.trim(),
        roles: [],
      };
      if (apiKeyEnv) profile.apiKeyEnv = apiKeyEnv.trim();
      if (baseUrl) profile.baseUrl = baseUrl.trim();
      if (tpl.tier === "public-cloud") {
        profile.requiresApproval = true;
        profile.defaultMode = "review-only";
      }

      const r = await withClient((c) =>
        c.configAddProfile({ id: id.trim(), profile, scope: scopePick.value }),
      );
      if (!r) return;
      void vscode.window.showInformationMessage(
        vscode.l10n.t("Tierkit: added profile {0} ({1})", r.id, r.scope),
      );
      sidebarRef?.render();
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
