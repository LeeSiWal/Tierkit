/**
 * Transport adapter source, embedded as JS inside GUI_HTML. Two modes:
 *
 *   - HTTP (default): direct fetch / ReadableStream — used when the GUI is loaded
 *     in a regular browser pointed at the daemon (e.g. http://127.0.0.1:4101/).
 *   - VsCode: postMessage RPC over `acquireVsCodeApi()` — used when GUI_HTML is
 *     embedded in a VS Code webview (Desktop OR code-server). The extension host
 *     proxies the actual daemon calls. Avoids browser sandbox issues with loopback
 *     fetches from a remote webview.
 *
 * We ship this as a string (single source of truth) and inline it into GUI_HTML.
 * Unit tests evaluate the string with `new Function(...)` and exercise the factories.
 */
export const TRANSPORT_INLINE_JS = `
function createHttpTransport(base) {
  function buildUrl(path) { return (base || '') + path; }
  function makeInit(init) {
    var i = init || {};
    var headers = {};
    var body = undefined;
    if (i.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(i.body);
    }
    return {
      method: (i.method || 'GET').toUpperCase(),
      headers: headers,
      body: body,
      signal: i.signal,
    };
  }
  return {
    request: async function (path, init) {
      var res = await fetch(buildUrl(path), makeInit(init));
      var data = await res.json().catch(function () { return {}; });
      return { ok: res.ok, status: res.status, data: data };
    },
    stream: async function* (path, init) {
      var i = init || {};
      var fetchInit = {
        method: (i.method || 'GET').toUpperCase(),
        headers: i.body !== undefined ? { 'content-type': 'application/json' } : {},
        body: i.body !== undefined ? JSON.stringify(i.body) : undefined,
        signal: i.signal,
      };
      var res = await fetch(buildUrl(path), fetchInit);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buf = '';
      try {
        while (true) {
          var r = await reader.read();
          if (r.done) break;
          buf += decoder.decode(r.value, { stream: true });
          var idx;
          while ((idx = buf.indexOf('\\n\\n')) >= 0) {
            var block = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 2);
            if (block.indexOf('data:') !== 0) continue;
            yield { data: block.slice(5).trim() };
          }
        }
      } finally {
        try { reader.cancel(); } catch (e) {}
      }
    },
  };
}

function createVsCodeTransport() {
  return {
    request: async function () { throw new Error('vscode transport not implemented'); },
    stream: async function* () { throw new Error('vscode transport not implemented'); },
  };
}
`;
