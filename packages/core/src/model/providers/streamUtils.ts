/**
 * Helpers for consuming streaming HTTP responses from provider clients.
 *
 * `iterNDJSON` is the matching parser for ollama's `/api/chat?stream=true` (one JSON object
 * per line). `iterSSE` matches the OpenAI / Anthropic format (`data: <json>\n\n`,
 * terminated by `data: [DONE]`).
 *
 * Both helpers read from a Node-native ReadableStream (returned by `fetch().body`) and
 * yield parsed objects. Malformed lines are skipped silently — streaming telemetry must
 * never crash the runtime over a flaky upstream chunk.
 */
export async function* iterNDJSON<T = unknown>(
  body: ReadableStream<Uint8Array> | null,
): AsyncGenerator<T> {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (value) buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        yield JSON.parse(line) as T;
      } catch {
        // skip malformed line
      }
    }
    if (done) {
      const tail = buf.trim();
      if (tail) {
        try {
          yield JSON.parse(tail) as T;
        } catch {
          /* skip */
        }
      }
      return;
    }
  }
}

export async function* iterSSE<T = unknown>(
  body: ReadableStream<Uint8Array> | null,
): AsyncGenerator<T> {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (value) buf += decoder.decode(value, { stream: true });
    // SSE events are separated by double newlines
    let sep: number;
    while ((sep = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const dataLines = block
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim());
      for (const data of dataLines) {
        if (!data || data === "[DONE]") continue;
        try {
          yield JSON.parse(data) as T;
        } catch {
          /* skip */
        }
      }
    }
    if (done) return;
  }
}
