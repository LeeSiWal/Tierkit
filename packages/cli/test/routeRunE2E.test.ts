import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Writable } from "node:stream";
import { buildCli } from "../src/cli.js";
import type { CliContext } from "../src/context/CliContext.js";

class StringSink extends Writable {
  chunks: Buffer[] = [];
  override _write(chunk: Buffer, _enc: unknown, cb: (err?: Error | null) => void): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    cb();
  }
  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

function makeContext(cwd: string): { context: CliContext; stdout: StringSink; stderr: StringSink } {
  const stdout = new StringSink();
  const stderr = new StringSink();
  return {
    context: {
      stdin: process.stdin,
      stdout,
      stderr,
      env: process.env as Record<string, string>,
      colorDepth: 1,
      cwd,
    },
    stdout,
    stderr,
  };
}

interface MockServer {
  url: string;
  close(): Promise<void>;
}

function startMockOllamaStream(text: string): Promise<MockServer> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      // Accept any path; respond with NDJSON stream.
      res.setHeader("content-type", "application/x-ndjson");
      const chunks = text.match(/.{1,3}/g) ?? [text];
      for (const c of chunks) {
        res.write(JSON.stringify({ message: { content: c }, done: false }) + "\n");
      }
      res.write(JSON.stringify({ done: true, prompt_eval_count: 4, eval_count: chunks.length }) + "\n");
      res.end();
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r, j) => server.close((err) => (err ? j(err) : r()))),
      });
    });
  });
}

async function makeProject(modelBaseUrl: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-routerun-e2e-"));
  await fs.mkdir(path.join(root, ".tierkit"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".tierkit", "plugins.json"),
    JSON.stringify({ version: "0.1", plugins: [] }),
  );
  await fs.writeFile(
    path.join(root, "tierkit.config.json"),
    JSON.stringify({
      version: "0.1",
      modelProfiles: {
        localFast: {
          kind: "local-device",
          provider: "ollama",
          baseUrl: modelBaseUrl,
          model: "qwen",
        },
      },
    }),
  );
  return root;
}

describe("CLI e2e: tierkit route run", () => {
  let root: string;
  let mock: MockServer | undefined;
  afterEach(async () => {
    if (mock) await mock.close();
    mock = undefined;
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it("streams deltas and prints the header + token totals", async () => {
    mock = await startMockOllamaStream("Hello world");
    root = await makeProject(mock.url);
    const cli = buildCli();
    const ctx = makeContext(root);
    expect(await cli.run(["route", "run", "say hi"], ctx.context)).toBe(0);
    const out = ctx.stdout.text();
    expect(out).toContain("[local-device] localFast (ollama/qwen, mode=execute)");
    expect(out).toContain("Hello world");
    // token summary line at the end (note the en-dash)
    expect(out).toMatch(/—\s+\d+ in \/ \d+ out/);
  });

  it("--no-stream defers printing until the end", async () => {
    mock = await startMockOllamaStream("buffered output");
    root = await makeProject(mock.url);
    const cli = buildCli();
    const ctx = makeContext(root);
    expect(await cli.run(["route", "run", "buffer please", "--no-stream"], ctx.context)).toBe(0);
    expect(ctx.stdout.text()).toContain("buffered output");
  });

  it("rejects unknown --mode", async () => {
    mock = await startMockOllamaStream("x");
    root = await makeProject(mock.url);
    const cli = buildCli();
    const ctx = makeContext(root);
    expect(await cli.run(["route", "run", "x", "--mode", "weird"], ctx.context)).toBe(1);
    expect(ctx.stderr.text()).toContain("invalid --mode");
  });

  it("--profile forces a profile and emits 'forced' in the routing reasons", async () => {
    mock = await startMockOllamaStream("ok");
    root = await makeProject(mock.url);
    const cli = buildCli();
    const ctx = makeContext(root);
    expect(await cli.run(["route", "run", "x", "--profile", "localFast"], ctx.context)).toBe(0);
    expect(ctx.stdout.text()).toContain("localFast");
  });
});
