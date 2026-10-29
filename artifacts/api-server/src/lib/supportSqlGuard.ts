/**
 * Guards for the support investigation agent's database access. The agent's
 * queries run inside a READ ONLY transaction (that's the real protection);
 * these checks reject anything that isn't a single plain read before it gets
 * there, and shape what the agent sees. A proposed data fix must be one
 * targeted UPDATE / INSERT / DELETE, applied only after the owner approves it.
 */

export const MAX_READ_ROWS = 100;
export const MAX_FIX_ROWS = 500;

type Check = { ok: true; sql: string } | { ok: false; error: string };

/** Trim, drop one trailing semicolon, and reject comments or a second statement. */
function oneStatement(input: unknown): Check {
  if (typeof input !== "string") return { ok: false, error: "sql must be text" };
  const sql = input.trim().replace(/;\s*$/, "").trim();
  if (!sql) return { ok: false, error: "sql is empty" };
  if (sql.length > 10_000) return { ok: false, error: "sql is too long" };
  if (sql.includes(";")) return { ok: false, error: "One statement only (no ';')." };
  if (/--|\/\*/.test(sql)) return { ok: false, error: "No SQL comments." };
  return { ok: true, sql };
}

const NEVER = /\b(drop|alter|truncate|grant|revoke|create|copy|call|do|vacuum|lock|listen|notify|unlisten|prepare|execute|deallocate|discard|reindex|cluster|comment|security|owner)\b/i;
const DANGEROUS_FUNCTIONS = /\b(pg_sleep\w*|pg_read\w*|pg_write\w*|pg_ls_\w*|pg_stat_file|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|lo_\w+|dblink\w*|set_config|current_setting)\s*\(/i;

/** A read query the agent may run: one SELECT or WITH … SELECT, nothing that writes. */
export function checkReadQuery(input: unknown): Check {
  const one = oneStatement(input);
  if (!one.ok) return one;
  const { sql } = one;
  if (!/^(select|with)\b/i.test(sql)) return { ok: false, error: "Only SELECT (or WITH … SELECT) queries." };
  if (/\b(insert|update|delete|merge)\b/i.test(sql)) return { ok: false, error: "Read queries can't change data." };
  if (NEVER.test(sql) || /\bset\s+(role|session|local|transaction)\b/i.test(sql)) return { ok: false, error: "That statement isn't allowed." };
  if (DANGEROUS_FUNCTIONS.test(sql)) return { ok: false, error: "That function isn't allowed." };
  return { ok: true, sql };
}

/** A data fix the owner can approve: one UPDATE / INSERT / DELETE, targeted, with an expected row count. */
export function checkFixStatement(input: unknown, expectedRows: unknown): Check & { expectedRows?: number } {
  const one = oneStatement(input);
  if (!one.ok) return one;
  const { sql } = one;
  const verb = sql.match(/^(update|insert|delete)\b/i)?.[1]?.toLowerCase();
  if (!verb) return { ok: false, error: "A data fix is one UPDATE, INSERT or DELETE." };
  if (NEVER.test(sql) || DANGEROUS_FUNCTIONS.test(sql)) return { ok: false, error: "That statement isn't allowed in a data fix." };
  if ((verb === "update" || verb === "delete") && !/\bwhere\b/i.test(sql)) return { ok: false, error: "UPDATE and DELETE need a WHERE clause." };
  const n = Number(expectedRows);
  if (!Number.isInteger(n) || n < 1 || n > MAX_FIX_ROWS) return { ok: false, error: `expected_rows must be a whole number from 1 to ${MAX_FIX_ROWS}.` };
  return { ok: true, sql, expectedRows: n };
}

const SECRET_COLUMN = /password|token|secret|hash|api_?key|stripe_.*(key|secret)|signature_data/i;

/** Hide secret columns and shorten long values before the agent sees a row. */
export function redactRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (SECRET_COLUMN.test(key) && value != null) out[key] = "[hidden]";
    else if (typeof value === "string" && value.length > 500) out[key] = `${value.slice(0, 500)}… (${value.length} chars)`;
    else if (value && typeof value === "object" && !(value instanceof Date)) {
      const text = JSON.stringify(value);
      out[key] = text.length > 1000 ? `${text.slice(0, 1000)}… (${text.length} chars)` : value;
    } else out[key] = value;
  }
  return out;
}

export const MAX_FIX_FILES = 5;
const ALLOWED_PREFIXES = ["artifacts/", "lib/", "deploy/migrations/"];
const BLOCKED = [/^\.github\//, /(^|\/)\.env/, /(^|\/)node_modules\//, /\/dist\//, /lockfile|pnpm-lock\.yaml$/i];

/** Code-fix files: at most 5, inside the app's source folders, nothing that holds secrets or CI. */
export function checkFixFiles(input: unknown): { ok: true; files: Array<{ path: string; content: string }> } | { ok: false; error: string } {
  if (!Array.isArray(input) || input.length === 0) return { ok: false, error: "files must list at least one { path, content }." };
  if (input.length > MAX_FIX_FILES) return { ok: false, error: `At most ${MAX_FIX_FILES} files.` };
  const files: Array<{ path: string; content: string }> = [];
  for (const f of input) {
    const path = typeof f?.path === "string" ? f.path.trim().replace(/^\.?\//, "") : "";
    const content = typeof f?.content === "string" ? f.content : null;
    if (!path || content === null) return { ok: false, error: "Each file needs a path and its full new content." };
    if (path.includes("..") || path.includes("\\") || path.startsWith("/")) return { ok: false, error: `Bad path: ${path}` };
    if (!ALLOWED_PREFIXES.some(p => path.startsWith(p)) || BLOCKED.some(r => r.test(path))) return { ok: false, error: `Can't change ${path}.` };
    if (content.length > 200_000) return { ok: false, error: `${path} is too large.` };
    files.push({ path, content });
  }
  return { ok: true, files };
}
