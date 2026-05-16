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
      var res = await fetch(buildUrl(path), makeInit(init));
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
  var vscode = (typeof acquireVsCodeApi === 'function') ? acquireVsCodeApi() : null;
  if (!vscode) {
    return {
      request: async function () { throw new Error('acquireVsCodeApi unavailable'); },
      stream: async function* () { throw new Error('acquireVsCodeApi unavailable'); },
    };
  }
  var nextId = 1;
  var pending = new Map(); // id -> { resolve, reject } | { stream handlers }

  window.addEventListener('message', function (e) {
    var msg = e.data;
    if (!msg || typeof msg !== 'object') return;
    var entry = pending.get(msg.id);
    if (!entry) return;
    if (msg.type === 'tk:res') {
      pending.delete(msg.id);
      entry.resolve({ ok: msg.ok, status: msg.status, data: msg.data });
    } else if (msg.type === 'tk:err') {
      pending.delete(msg.id);
      entry.reject(new Error(msg.message || 'tk:err'));
    } else if (msg.type === 'tk:chunk') {
      if (entry.onChunk) entry.onChunk(msg.data);
    } else if (msg.type === 'tk:done') {
      pending.delete(msg.id);
      if (entry.onDone) entry.onDone(msg.reason || 'eof', msg.error);
    }
  });

  function allocId() { return nextId++; }

  return {
    request: function (path, init) {
      var id = allocId();
      var i = init || {};
      return new Promise(function (resolve, reject) {
        pending.set(id, { resolve: resolve, reject: reject });
        if (i.signal) {
          if (i.signal.aborted) {
            pending.delete(id);
            reject(new Error('aborted'));
            return;
          }
          i.signal.addEventListener('abort', function () {
            if (pending.has(id)) {
              pending.delete(id);
              try { vscode.postMessage({ type: 'tk:abort', id: id }); } catch (e) {}
              reject(new Error('aborted'));
            }
          });
        }
        try {
          vscode.postMessage({
            type: 'tk:req', id: id,
            method: (i.method || 'GET').toUpperCase(),
            path: path,
            body: i.body,
          });
        } catch (e) {
          pending.delete(id);
          reject(e);
        }
      });
    },
    stream: async function* (path, init) {
      var id = allocId();
      var i = init || {};
      var queue = [];
      var waiter = null;
      var ended = false;
      var error = null;

      pending.set(id, {
        onChunk: function (data) {
          if (waiter) { var w = waiter; waiter = null; w({ value: { data: data }, done: false }); }
          else queue.push({ value: { data: data }, done: false });
        },
        onDone: function (reason, errMsg) {
          ended = true;
          if (errMsg && reason !== 'eof') error = new Error(errMsg);
          if (waiter) {
            var w = waiter; waiter = null;
            if (error) w(Promise.reject(error));
            else w({ value: undefined, done: true });
          }
        },
        resolve: function () {}, reject: function (e) { error = e; ended = true; if (waiter) { var w = waiter; waiter = null; w(Promise.reject(e)); } },
      });

      var abortHandler = null;
      if (i.signal) {
        if (i.signal.aborted) {
          pending.delete(id);
          return;
        }
        abortHandler = function () {
          try { vscode.postMessage({ type: 'tk:abort', id: id }); } catch (e) {}
        };
        i.signal.addEventListener('abort', abortHandler);
      }

      try {
        vscode.postMessage({
          type: 'tk:stream', id: id,
          method: (i.method || 'POST').toUpperCase(),
          path: path,
          body: i.body,
        });
      } catch (e) {
        pending.delete(id);
        throw e;
      }

      try {
        while (true) {
          if (queue.length > 0) {
            var item = queue.shift();
            if (item.done) return;
            yield item.value;
            continue;
          }
          if (ended) {
            if (error) throw error;
            return;
          }
          var next = await new Promise(function (resolve) { waiter = resolve; });
          if (next && next.done) return;
          if (next && next.value) yield next.value;
        }
      } finally {
        pending.delete(id);
        if (abortHandler && i.signal) i.signal.removeEventListener('abort', abortHandler);
      }
    },
  };
}
`;
