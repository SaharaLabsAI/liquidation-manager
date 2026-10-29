// Persistent state: one JSON document split into namespaces (one per module), written atomically (temp file + rename).
// bigints round-trip through {"$bigint": "<decimal>"}.
import {mkdirSync, readFileSync, renameSync, writeFileSync, existsSync} from "node:fs";
import {dirname} from "node:path";

export interface Store {
  /** Returns the namespace value, or `fallback` if absent. Mutating the returned object requires a `set`. */
  get<T>(namespace: string, fallback: T): T;
  set<T>(namespace: string, value: T): void;
  /** Writes the document to disk if anything changed since the last save. */
  save(): void;
}

function replacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? {$bigint: value.toString()} : value;
}

function reviver(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length === 1 && keys[0] === "$bigint" && typeof record.$bigint === "string") return BigInt(record.$bigint);
  }
  return value;
}

export function serializeState(data: unknown): string {
  return JSON.stringify(data, replacer, 2);
}

export function deserializeState(text: string): unknown {
  return JSON.parse(text, reviver);
}

/** File-backed store. `path` undefined gives an in-memory store (tests, `check`). */
export function createStore(path?: string): Store {
  let data: Record<string, unknown> = {};
  if (path && existsSync(path)) data = deserializeState(readFileSync(path, "utf8")) as Record<string, unknown>;
  let dirty = false;
  return {
    get<T>(namespace: string, fallback: T): T {
      return namespace in data ? (structuredClone(data[namespace]) as T) : fallback;
    },
    set<T>(namespace: string, value: T): void {
      data[namespace] = structuredClone(value);
      dirty = true;
    },
    save(): void {
      if (!path || !dirty) return;
      mkdirSync(dirname(path), {recursive: true});
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, serializeState(data));
      renameSync(tmp, path);
      dirty = false;
    },
  };
}
