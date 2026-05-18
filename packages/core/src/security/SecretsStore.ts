import fs from "node:fs/promises";
import path from "node:path";

export interface SecretsStoreEntry {
  key: string;
  set: boolean;
  /** Masked preview, e.g. "sk-ant-…xyz9". Empty string when set === false. */
  masked: string;
}

export interface SecretsStoreListResult {
  entries: SecretsStoreEntry[];
}

export interface SecretsStoreListOptions {
  /**
   * Additional env-var names to include in the result even if not present in the store.
   * The Server passes the union of all `apiKeyEnv` values referenced by model profiles,
   * so the UI can show "ANTHROPIC_API_KEY: not set" rows.
   */
  knownKeys?: readonly string[];
}

export interface SecretsStore {
  list(opts?: SecretsStoreListOptions): SecretsStoreListResult;
  set(key: string, value: string): Promise<void>;
  /** Returns false if the key was set by the shell env (not by us) — caller should 4xx. */
  remove(key: string): Promise<boolean>;
  loadIntoEnv(): Promise<void>;
}

export interface CreateSecretsStoreOptions {
  /** Directory containing `secrets.json`. Usually `<projectRoot>/.tierkit`. */
  dataDir: string;
  /** Process env to read/write. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}

export function createSecretsStore(opts: CreateSecretsStoreOptions): SecretsStore {
  const env = opts.env ?? (process.env as Record<string, string | undefined>);
  const secretsPath = path.join(opts.dataDir, "secrets.json");
  const ENV_KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;

  // In-memory mirror of the on-disk file.
  let fileValues: Record<string, string> = {};
  // Keys we injected into env at loadIntoEnv() — only these may be removed from env on remove().
  const injectedKeys = new Set<string>();

  function mask(v: string): string {
    if (v.length < 12) return "…" + v.slice(-2);
    return v.slice(0, 7) + "…" + v.slice(-4);
  }

  async function readFile(): Promise<Record<string, string>> {
    try {
      const txt = await fs.readFile(secretsPath, "utf8");
      const parsed = JSON.parse(txt);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "string" && ENV_KEY_PATTERN.test(k)) out[k] = v;
      }
      return out;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw err;
    }
  }

  async function writeFileAtomic(values: Record<string, string>): Promise<void> {
    await fs.mkdir(opts.dataDir, { recursive: true });
    const tmpPath = secretsPath + ".tmp";
    try {
      await fs.writeFile(tmpPath, JSON.stringify(values, null, 2), { mode: 0o600 });
      await fs.rename(tmpPath, secretsPath);
      await fs.chmod(secretsPath, 0o600);
    } catch (err) {
      await fs.unlink(tmpPath).catch(() => {});
      throw err;
    }
  }

  async function ensureGitignore(): Promise<void> {
    const gi = path.join(opts.dataDir, ".gitignore");
    let body = "";
    try {
      body = await fs.readFile(gi, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const lines = body.split(/\r?\n/);
    if (!lines.includes("secrets.json")) {
      const next = (body && !body.endsWith("\n") ? body + "\n" : body) + "secrets.json\n";
      await fs.writeFile(gi, next);
    }
  }

  return {
    async loadIntoEnv() {
      fileValues = await readFile();
      for (const [k, v] of Object.entries(fileValues)) {
        const existing = env[k];
        if (existing === undefined || existing === "") {
          env[k] = v;
          injectedKeys.add(k);
        }
      }
    },

    list(opts2) {
      const known = new Set<string>([
        ...Object.keys(fileValues),
        ...(opts2?.knownKeys ?? []),
      ]);
      const entries: SecretsStoreEntry[] = [];
      for (const key of [...known].sort()) {
        const value = fileValues[key];
        const setInEnv = (env[key] ?? "") !== "";
        entries.push({
          key,
          set: setInEnv,
          masked: value ? mask(value) : "",
        });
      }
      return { entries };
    },

    async set(key, value) {
      if (!ENV_KEY_PATTERN.test(key)) {
        throw new Error("invalid env var name (must match /^[A-Z][A-Z0-9_]*$/)");
      }
      if (!value) throw new Error("value must be non-empty");
      const next = { ...fileValues, [key]: value };
      await writeFileAtomic(next);
      await ensureGitignore();
      fileValues = next;
      env[key] = value;
      injectedKeys.add(key);
    },

    async remove(key) {
      if (!(key in fileValues)) {
        // Not in our store. If env has it, it came from the shell — refuse.
        return false;
      }
      const next = { ...fileValues };
      delete next[key];
      fileValues = next;
      await writeFileAtomic(fileValues);
      if (injectedKeys.has(key)) {
        delete env[key];
        injectedKeys.delete(key);
      }
      return true;
    },
  };
}
