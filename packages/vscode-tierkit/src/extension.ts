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
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import { TierkitClient, TierkitClientError } from "@tierkit/client";
import { GUI_HTML, startServer, createSecretsStore, loadConfig, type RunningServer } from "@tierkit/core";
import { RooAdapter } from "@tierkit/adapter-roo";
import { ClineAdapter } from "@tierkit/adapter-cline";
import { ContinueAdapter } from "@tierkit/adapter-continue";
// v0.19 disabled: import { createAgentRouteExtension } from "@tierkit/agent";
import { createMessageRouter } from "./messageRouter.js";
import { isAllowedWebviewCommand } from "./webviewCommandAllowlist.js";
import { readGatewayModeFromConfig, withGatewayMode } from "./gatewayModeConfig.js";
import { controlBaseUrlFromConfiguredBaseUrl } from "./gatewayControlUrl.js";

let statusItem: vscode.StatusBarItem | undefined;
let serverHandle: RunningServer | undefined;
/** Set when we successfully start (or detect) a daemon. Overrides config-derived baseUrl. */
let effectiveBaseUrl: string | undefined;
let sidebarRef: TierkitSidebarProvider | undefined;
/** Diagnostic Output channel. Logs every step of auto-start so failures are debuggable. */
let outputChannel: vscode.OutputChannel | undefined;
/** v0.20.7: absolute path to the bundled Tierkit CLI shipped inside the .vsix
 * (<context.extensionPath>/cli/index.js). Surfaced to the daemon at startup. */
let bundledCliPath: string | undefined;
/** v0.20.7: VS Code's Electron binary, capable of running JS as Node when
 * spawned with ELECTRON_RUN_AS_NODE=1. Always reachable since the user
 * already has VS Code installed. */
let electronExecPath: string | undefined;
/** v0.21.10: singleton "main editor" panel, opened via tierkit.openInPanel
 * for users who prefer the full editor area over the cramped sidebar
 * (mobile / tablet / Codespaces in a narrow window). */
let mainPanel: vscode.WebviewPanel | undefined;

interface BundledSample {
  id: string;
  name: string;
  description: string;
  freedom: string;
  /** Absolute path passed verbatim to `POST /v1/plugins/install`. */
  path: string;
}
/** Cached at activation. Empty array if `@tierkit/plugin-superpowers` isn't installed. */
let bundledSamples: BundledSample[] = [];

/**
 * Resolve the on-disk path of bundled sample plugins and read each child directory's
 * `tierkit.plugin.json` to expose sample metadata to the GUI.
 *
 * Two source paths are tried in order:
 *   1. `<extensionRoot>/samples/` — populated by `scripts/copy-samples.mjs` at build
 *      time. This is the path that exists inside the published .vsix.
 *   2. `@tierkit/plugin-superpowers/plugins/` via `createRequire.resolve` — only works
 *      when the extension runs from the monorepo (dev mode), since the .vsix doesn't
 *      ship node_modules.
 *
 * Failure is non-fatal: if neither path works, the Install dropdown is empty and the
 * GUI's "From path" input still works.
 */
async function loadBundledSamples(): Promise<BundledSample[]> {
  // Candidate 1: bundled samples copied into the extension folder. dist/extension.js
  // sits one level deep under the extension root, so the samples dir is `../samples`.
  const bundledPath = path.resolve(__dirname, "..", "samples");
  let pluginsRoot: string | undefined;
  try {
    const s = await fs.stat(bundledPath);
    if (s.isDirectory()) pluginsRoot = bundledPath;
  } catch {
    // Not present — fall through to the dev-mode candidate.
  }

  // Candidate 2: dev mode — resolve through node_modules / pnpm workspace links.
  if (!pluginsRoot) {
    try {
      const req = createRequire(import.meta.url);
      const pkgPath = req.resolve("@tierkit/plugin-superpowers/package.json");
      pluginsRoot = path.join(path.dirname(pkgPath), "plugins");
    } catch (err) {
      log(`bundled-samples: could not resolve via require either: ${(err as Error).message}`);
      return [];
    }
  }

  try {
    const dirs = await fs.readdir(pluginsRoot, { withFileTypes: true });
    const out: BundledSample[] = [];
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const manifestPath = path.join(pluginsRoot, d.name, "tierkit.plugin.json");
      try {
        const raw = await fs.readFile(manifestPath, "utf8");
        const parsed = JSON.parse(raw) as {
          id?: string;
          name?: string;
          description?: string;
          freedom?: { level?: string };
        };
        out.push({
          id: parsed.id ?? d.name,
          name: parsed.name ?? d.name,
          description: parsed.description ?? "",
          freedom: parsed.freedom?.level ?? "",
          path: path.join(pluginsRoot, d.name),
        });
      } catch {
        // Skip malformed sample dirs silently — the goal is graceful UI, not validation.
      }
    }
    log(`bundled-samples: source=${pluginsRoot}, count=${out.length}`);
    return out.sort((a, b) => a.id.localeCompare(b.id));
  } catch (err) {
    log(`bundled-samples: readdir failed at ${pluginsRoot}: ${(err as Error).message}`);
    return [];
  }
}
/** Tracks the last auto-start outcome so the sidebar can render an explanation banner. */
let lastDaemonError: string | undefined;

function log(line: string): void {
  outputChannel?.appendLine(`[${new Date().toISOString()}] ${line}`);
}

/**
 * v0.19.2: hand a compressed brief / digest / pack to Claude Code.
 *
 * Findings from inspecting `anthropic.claude-code` 2.1.145 source:
 *   - `claude-vscode.newConversation` IGNORES its arguments and just opens
 *     a fresh empty chat — calling it actively DESTROYS the user's
 *     current conversation context. Do not use it for handoff.
 *   - `claude-vscode.insertAtMention` only inserts the active editor's
 *     filename as @-mention; it does not accept arbitrary text either.
 *   - There is no public command that programmatically inserts text into
 *     the chat input. The webview is sealed.
 *
 * So the only honest handoff is:
 *   1. Copy text to system clipboard (always).
 *   2. Try `claude-vscode.focus` to bring the input into focus.
 *   3. Toast the user with the next step (Cmd+V on Mac, Ctrl+V elsewhere).
 *
 * If Anthropic later exposes a `setInput(text)` style command, swap step 2
 * for that and skip the Cmd+V hint. The Tierkit side won't need to change
 * since we already centralize this in one function.
 */
async function sendToClaudeCode(text: string): Promise<void> {
  if (!text || text.length === 0) {
    void vscode.window.showWarningMessage("Tierkit: nothing to send (empty result).");
    return;
  }

  // Step 1 — clipboard, always.
  try {
    await vscode.env.clipboard.writeText(text);
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Tierkit: failed to copy to clipboard — ${(err as Error).message}`,
    );
    return;
  }

  // Step 2 — focus the Claude Code input. Best-effort; the toast adapts.
  let focused = false;
  try {
    await vscode.commands.executeCommand("claude-vscode.focus");
    focused = true;
  } catch {
    /* extension not installed or focus refused */
  }

  // Step 3 — toast. Use platform-appropriate paste hint.
  const isMac = process.platform === "darwin";
  const paste = isMac ? "⌘V" : "Ctrl+V";
  if (focused) {
    void vscode.window.showInformationMessage(
      `Tierkit: copied → Claude Code input focused. Press ${paste} to paste.`,
    );
  } else {
    void vscode.window.showInformationMessage(
      `Tierkit: copied to clipboard. Open Claude Code and press ${paste} to paste.`,
    );
  }
}

/**
 * v0.20.1: ask the user to reload the VS Code window. Used after the
 * connect flow finishes registering Tierkit as a Claude Code MCP server —
 * Claude Code only re-reads MCP config at window startup, so a reload is
 * the only way to make the new server show up without restarting the IDE
 * by hand.
 *
 * We never silent-reload (would clobber the user's other workspaces and
 * unsaved editor state). The user must click "Reload now".
 */
async function promptReloadWindow(reason: string): Promise<void> {
  const choice = await vscode.window.showInformationMessage(
    `Tierkit: ${reason}\n\nVS Code window must reload so Claude Code picks up the new MCP server. Reload now?`,
    { modal: true },
    "Reload now",
    "Later",
  );
  if (choice === "Reload now") {
    await vscode.commands.executeCommand("workbench.action.reloadWindow");
  }
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
 * Probe `${url}/v1/health` and return the daemon's reported version. Null when the URL
 * doesn't respond with a Tierkit-shaped health payload (so the caller can treat that as
 * "no daemon here"). Used by maybeStartDaemon to decide whether to adopt an existing
 * daemon or start a fresh one.
 */
/**
 * v0.21.10: open Tierkit's full UI as a webview panel in the main editor
 * area (vs the sidebar). Same HTML, same daemon, same message router — just
 * a roomier surface. Singleton: if a panel is already open, focus it.
 */
function openTierkitPanel(context: vscode.ExtensionContext): void {
  if (mainPanel) {
    try { mainPanel.reveal(vscode.ViewColumn.Active); return; }
    catch { /* panel was disposed; fall through to create */ mainPanel = undefined; }
  }
  mainPanel = vscode.window.createWebviewPanel(
    "tierkit.panel",
    "Tierkit",
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [],
    },
  );
  mainPanel.iconPath = vscode.Uri.joinPath(vscode.Uri.file(context.extensionPath), "media", "tierkit.svg");
  mainPanel.webview.html = wrapHtmlForWebview(GUI_HTML, baseUrl(), lastDaemonError);

  // Wire the same router used by the sidebar so chat / fetch / streams work
  // identically. The panel and sidebar are independent webviews — each has
  // its own router instance — but they share daemon state, so opening both
  // at once is fine.
  const fetchProxyLocal = (url: string, init: { method: string; body?: string; signal: AbortSignal }) => fetchProxy(url, init);
  const streamProxyLocal = (url: string, init: { method: string; body?: string; signal: AbortSignal }) => streamProxy(url, init);
  const router = createMessageRouter({
    getBaseUrl: () => baseUrl(),
    fetchProxy: fetchProxyLocal,
    streamProxy: streamProxyLocal,
    log: (line) => log(`panel-router: ${line}`),
  });
  mainPanel.onDidDispose(() => {
    router.disposeAll();
    mainPanel = undefined;
  });
  mainPanel.webview.onDidReceiveMessage((msg) => {
    if (typeof msg?.type !== "string") return;
    if (msg.type === "tk:claude-code" && typeof msg.text === "string") {
      void sendToClaudeCode(msg.text);
      return;
    }
    if (msg.type === "tk:reload-vscode" && typeof msg.reason === "string") {
      void promptReloadWindow(msg.reason);
      return;
    }
    if (msg.type === "tk:open-path" && typeof msg.path === "string") {
      void openAbsoluteOrRelativePath(msg.path);
      return;
    }
    // v0.21.10: re-opening the panel from within the panel just re-focuses it.
    if (msg.type === "tk:open-panel") {
      try { mainPanel?.reveal(vscode.ViewColumn.Active); } catch { /* */ }
      return;
    }
    // Phase 1: webview-dispatched VS Code commands (allowlisted).
    if (msg.type === "tk:cmd" && isAllowedWebviewCommand(msg.command)) {
      void vscode.commands.executeCommand(msg.command);
      return;
    }
    if (msg.type.startsWith("tk:")) {
      void router.handle(msg, (out) => mainPanel?.webview.postMessage(out));
      return;
    }
    if (msg.type === "showOutput") outputChannel?.show(true);
    else if (msg.type === "restartDaemon") void restartDaemon();
    else if (msg.type === "previewDiff" && typeof msg.path === "string" && typeof msg.proposed === "string") {
      void previewDiff(msg.path, msg.proposed);
    } else if (msg.type === "openFile" && typeof msg.path === "string") {
      void openFile(msg.path);
    }
  });
}

/**
 * v0.20.7: Tell the running daemon about the paths it needs to wire up Claude
 * Code MCP correctly. Sent once after the daemon comes up (or after a restart);
 * the daemon stores them in memory and uses them on every POST /v1/claude-code/connect.
 *
 * Without this, the daemon would write `"command": "tierkit"` into the MCP
 * entry and Claude Code would fail to spawn it on machines that don't have
 * `tierkit` on the GUI-process PATH (which is most machines).
 *
 * Failure is non-fatal — the connect flow falls back to global-tierkit lookup
 * and surfaces a clear diagnostic if that also fails.
 */
async function registerHostInfoWithDaemon(): Promise<void> {
  if (!bundledCliPath || !electronExecPath) return;
  const base = baseUrl();
  try {
    const res = await fetch(`${base}/v1/claude-code/host-info`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cliPath: bundledCliPath,
        nodeBinary: electronExecPath,
      }),
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) {
      log(`host-info: daemon returned ${res.status}`);
      return;
    }
    log(`host-info: registered cliPath=${bundledCliPath} nodeBinary=${electronExecPath}`);
  } catch (err) {
    log(`host-info: failed to register — ${(err as Error).message}`);
  }
}

async function probeTierkitDaemonAt(url: string): Promise<{ version: string } | null> {
  try {
    const res = await fetch(`${url}/v1/health`, { signal: AbortSignal.timeout(800) });
    if (!res.ok) return null;
    const body = (await res.json()) as { ok?: unknown; version?: unknown };
    if (!body?.ok || typeof body?.version !== "string") return null;
    return { version: body.version };
  } catch {
    return null;
  }
}

/** The @tierkit/core version we ship with — used to decide whether to adopt an existing daemon. */
function expectedDaemonVersion(): string {
  try {
    const req = createRequire(import.meta.url);
    const corePkg = req("@tierkit/core/package.json") as { version?: string };
    if (typeof corePkg.version === "string") return corePkg.version;
  } catch {
    /* fall through */
  }
  return "unknown";
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
/** Build the bootstrap-plugins list for the first run. Every bundled sample gets
 * installed, but only `superpowers-guided` (or the first sample as a fallback) is
 * marked autoEnable. The rest sit installed-but-disabled so the user can flip them
 * on later from the sidebar. */
function buildBootstrapPlugins(): Array<{ path: string; autoEnable: boolean }> {
  const first = bundledSamples[0];
  if (!first) return [];
  const guidedId = bundledSamples.find((s) => s.id === "superpowers-guided")?.id ?? first.id;
  return bundledSamples.map((s) => ({
    path: s.path,
    autoEnable: s.id === guidedId,
  }));
}

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
  const existing = await probeTierkitDaemonAt(configured);
  const expected = expectedDaemonVersion();
  if (existing) {
    // Reuse only when versions match. A stale daemon (from a previous extension session or
    // a `tierkit runtime start` CLI in another terminal) at the configured port will
    // silently shadow new endpoints (PATCH /v1/config/profile, /v1/secrets, /v1/plugins/
    // generate, …) and the user thinks "nothing works". Better to skip the old daemon
    // and start a fresh one on an OS-assigned port — the webview's effectiveBaseUrl
    // points to the new one so the user always gets the version they installed.
    if (existing.version === expected || expected === "unknown") {
      effectiveBaseUrl = configured;
      log(`auto-start: reusing existing daemon at ${configured} (version ${existing.version})`);
      sidebarRef?.render();
      void refreshStatus();
      return;
    }
    log(
      `auto-start: existing daemon at ${configured} is v${existing.version} but extension shipped with v${expected} — ` +
        `NOT adopting; will start a fresh daemon on a free port instead.`,
    );
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

  // Load bundled samples now so we can pass them as bootstrap plugins to startServer.
  // (Until this completes, the GUI also has nothing to render in its Install dropdown.)
  bundledSamples = await loadBundledSamples();
  log(`bundled-samples: loaded ${bundledSamples.length} (${bundledSamples.map((s) => s.id).join(", ")})`);
  const bootstrapPlugins = buildBootstrapPlugins();
  const bootstrapOpt = bootstrapPlugins.length > 0 ? { bootstrapPlugins } : {};
  log(`bootstrap: ${bootstrapPlugins.map((b) => b.path.split("/").pop() + (b.autoEnable ? "*" : "")).join(", ") || "(none — bundled samples missing)"}`);

  // Wire secrets store so /v1/secrets endpoints work in the extension's daemon. Without
  // this, POST /v1/secrets returns 501 and the GUI's API-key paste flow silently fails.
  let secretsStore: ReturnType<typeof createSecretsStore> | undefined;
  try {
    const cfg = await loadConfig(workspace.uri.fsPath);
    const dataDir = path.join(workspace.uri.fsPath, cfg.config.runtime.dataDir);
    await fs.mkdir(dataDir, { recursive: true });
    secretsStore = createSecretsStore({ dataDir });
    await secretsStore.loadIntoEnv();
    log(`secrets: store ready at ${dataDir}/secrets.json`);
  } catch (e) {
    log(`secrets: failed to initialize (${(e as Error).message}) — /v1/secrets will return 501`);
  }

  log(`auto-start: trying startServer({port:${port}})`);
  try {
    serverHandle = await startServer({
      cwd: workspace.uri.fsPath,
      host: "127.0.0.1",
      port,
      adapters: { roo: new RooAdapter(), cline: new ClineAdapter(), continue: new ContinueAdapter() },
      // v0.19: agent route extension (POST /v1/agent/run, /v1/agent/approval)
      // disabled. The Chat tab no longer runs the agent loop — it's a thin shell
      // around the v0.18 digest pipeline. Re-add `createAgentRouteExtension()`
      // here to bring the agent endpoints back.
      routeExtensions: [],
      ...(secretsStore ? { secrets: secretsStore } : {}),
      ...bootstrapOpt,
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
        routeExtensions: [],
        ...(secretsStore ? { secrets: secretsStore } : {}),
        ...bootstrapOpt,
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
 *   - the webview never fetches the daemon directly; all data flows through
 *     postMessage to this extension host, which proxies via fetchProxy/streamProxy
 *     (works in both VS Code Desktop and code-server),
 *   - `window.__TIERKIT_HOST__ = "vscode"` is set so the GUI's transport adapter
 *     picks the postMessage backend instead of direct fetch,
 *   - `window.__TIERKIT_BASE_URL__` is set (debug/UI display only — not consumed by transport in vscode mode),
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
      // v0.19.1: route to Claude Code's chat input. The Tierkit Compressor's
      // entire point is to feed Claude Code, so this is the primary user flow.
      if (msg.type === "tk:claude-code" && typeof msg.text === "string") {
        void sendToClaudeCode(msg.text);
        return;
      }
      // v0.20.1: ask the user to reload the VS Code window so Claude Code
      // picks up the freshly-registered MCP server. There is no public Claude
      // Code command to refresh MCP at runtime, so window reload is the only
      // honest path. We never reload silently.
      if (msg.type === "tk:reload-vscode" && typeof msg.reason === "string") {
        void promptReloadWindow(msg.reason);
        return;
      }
      // v0.20.2: open an arbitrary file path (absolute or workspace-relative)
      // in a VS Code editor tab. Used by the Settings card's "Reveal config"
      // buttons so the user can SEE the MCP entry we just wrote.
      if (msg.type === "tk:open-path" && typeof msg.path === "string") {
        void openAbsoluteOrRelativePath(msg.path);
        return;
      }
      // v0.21.10: webview-triggered "open in main editor" command.
      if (msg.type === "tk:open-panel") {
        void vscode.commands.executeCommand("tierkit.openInPanel");
        return;
      }
      // Phase 1: webview-dispatched VS Code commands (allowlisted).
      if (msg.type === "tk:cmd" && isAllowedWebviewCommand(msg.command)) {
        void vscode.commands.executeCommand(msg.command);
        return;
      }
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
    // Bundled samples discovered at activation. GUI's Install dropdown reads this.
    `window.__TIERKIT_SAMPLES__ = ${JSON.stringify(bundledSamples)};` +
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

/** Open a file by absolute path (e.g. ~/.claude.json) or workspace-relative
 * path (e.g. .mcp.json). The webview can't access the filesystem directly,
 * so this is the channel for "let the user inspect what we just wrote".
 */
async function openAbsoluteOrRelativePath(p: string): Promise<void> {
  // Resolve ~ ourselves — vscode.Uri.file doesn't expand it.
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const expanded = p.startsWith("~") && home ? home + p.slice(1) : p;
  let uri: vscode.Uri;
  if (expanded.startsWith("/") || /^[A-Za-z]:[\\/]/.test(expanded)) {
    uri = vscode.Uri.file(expanded);
  } else {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace) return;
    uri = vscode.Uri.joinPath(workspace.uri, expanded);
  }
  try {
    await vscode.window.showTextDocument(uri, { preview: true });
  } catch (err) {
    void vscode.window.showWarningMessage(
      `Tierkit: could not open ${expanded} — ${(err as Error).message}`,
    );
  }
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
  await registerHostInfoWithDaemon();
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

  // v0.20.7: remember the bundled-CLI path + Electron path so the daemon can
  // use them when wiring up Claude Code MCP. Saved here at activate-time
  // because context.extensionPath isn't reachable from the daemon directly.
  bundledCliPath = path.join(context.extensionPath, "cli", "index.js");
  electronExecPath = process.execPath;
  log(`bundled CLI: ${bundledCliPath}`);
  log(`electron exec: ${electronExecPath}`);

  // ── Auto-start the daemon in-process. Bundled samples are loaded inside
  //     maybeStartDaemon (before startServer) so they can feed into the
  //     bootstrapPlugin option. Fire-and-forget; render() is called from inside. ──
  void maybeStartDaemon().then(async () => {
    sidebarRef?.render();
    // After daemon is up, register host info so /v1/claude-code/connect can
    // build MCP entries that target our bundled CLI via Electron-as-Node.
    await registerHostInfoWithDaemon();
  });

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
    // v0.21.10: open the full Tierkit UI as a webview panel in the main editor
    // area instead of the cramped sidebar. Particularly useful on tablets /
    // small-window setups where the sidebar is too narrow for chat. Each
    // invocation either focuses the existing panel (singleton per window) or
    // opens a fresh one. Panel mode and sidebar mode coexist — both connect
    // to the same daemon and share localStorage.
    vscode.commands.registerCommand("tierkit.openInPanel", () => {
      openTierkitPanel(context);
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

    // Phase 1: toggle gateway mode — discriminated reachability, no-fallback-after-PATCH.
    vscode.commands.registerCommand("tierkit.toggleGatewayMode", async () => {
      const workspace = vscode.workspace.workspaceFolders?.[0];
      if (!workspace) {
        void vscode.window.showWarningMessage(vscode.l10n.t("Open a folder first."));
        return;
      }
      const configuredBaseUrl =
        vscode.workspace.getConfiguration("tierkit").get<string>("baseUrl") ?? "http://127.0.0.1:4101";
      const controlBaseUrl = controlBaseUrlFromConfiguredBaseUrl(configuredBaseUrl);
      const cfgPath = path.join(workspace.uri.fsPath, "tierkit.config.json");

      // Discriminated reachability — corrections 30 & 23.
      type Reach =
        | { kind: "reachable"; gatewayMode: "off" | "on" }
        | { kind: "transport-failure" }
        | { kind: "rejected"; status: number; detail: string };

      const probeDaemon = async (): Promise<Reach> => {
        let res: Response;
        try {
          res = await fetch(`${controlBaseUrl}/v1/gateway/status`);
        } catch {
          return { kind: "transport-failure" };
        }
        if (!res.ok) {
          const detail = await res.text().catch(() => "");
          return { kind: "rejected", status: res.status, detail };
        }
        let body: { gatewayMode?: unknown };
        try { body = (await res.json()) as { gatewayMode?: unknown }; }
        catch (err) { return { kind: "rejected", status: res.status, detail: (err as Error).message }; }
        if (body.gatewayMode !== "on" && body.gatewayMode !== "off") {
          return { kind: "rejected", status: res.status, detail: "Gateway status response contained an invalid gatewayMode." };
        }
        return { kind: "reachable", gatewayMode: body.gatewayMode };
      };

      const reach = await probeDaemon();

      if (reach.kind === "rejected") {
        void vscode.window.showErrorMessage(
          vscode.l10n.t("Tierkit daemon rejected the gateway status request.") +
            (reach.detail ? ` ${reach.detail}` : ""),
        );
        return;
      }

      if (reach.kind === "transport-failure") {
        // Pre-mutation transport failure → offline file fallback is allowed (correction 23).
        let cfg: Record<string, unknown>;
        try {
          cfg = JSON.parse(await fs.readFile(cfgPath, "utf8")) as Record<string, unknown>;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            cfg = { version: "0.1" };
          } else {
            void vscode.window.showErrorMessage(`tierkit.config.json: ${(err as Error).message}`);
            return;
          }
        }
        let current: "off" | "on";
        try {
          current = readGatewayModeFromConfig(cfg);
        } catch {
          void vscode.window.showErrorMessage(
            vscode.l10n.t("tierkit.config.json runtime.gatewayMode has an invalid value. Fix it manually and re-toggle."),
          );
          return;
        }
        const next: "off" | "on" = current === "on" ? "off" : "on";
        const updated = withGatewayMode(cfg, next);
        const tmp = `${cfgPath}.tmp-${process.pid}-${Date.now()}`;
        await fs.writeFile(tmp, JSON.stringify(updated, null, 2) + "\n");
        await fs.rename(tmp, cfgPath);
        void vscode.commands.executeCommand("tierkit.restartDaemon");
        void vscode.window.showInformationMessage(
          next === "on"
            ? vscode.l10n.t("Gateway: on (offline file fallback applied; daemon will pick this up on restart).")
            : vscode.l10n.t("Gateway: off (offline file fallback applied)."),
        );
        sidebarRef?.render();
        return;
      }

      // reach.kind === "reachable" — daemon owns the write from here on.
      const next: "off" | "on" = reach.gatewayMode === "on" ? "off" : "on";

      let patchRes: Response;
      try {
        patchRes = await fetch(`${controlBaseUrl}/v1/config/runtime`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ gatewayMode: next }),
        });
      } catch {
        // correction 31: PATCH attempted, response lost. Daemon may have already
        // committed. NEVER auto-fallback — show indeterminate-state error.
        void vscode.window.showErrorMessage(
          vscode.l10n.t("The gateway update request did not complete cleanly. Check the current status (sidebar) before trying again."),
        );
        sidebarRef?.render();
        return;
      }

      if (!patchRes.ok) {
        const detail = await patchRes.text().catch(() => "");
        void vscode.window.showErrorMessage(
          vscode.l10n.t("Tierkit daemon rejected the gateway mode update.") +
            (detail ? ` ${detail}` : ""),
        );
        return;
      }

      void vscode.window.showInformationMessage(
        next === "on"
          ? vscode.l10n.t("Gateway: on. Use 'Launch Claude Code through Tierkit' to start a routed session.")
          : vscode.l10n.t("Gateway: off."),
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
