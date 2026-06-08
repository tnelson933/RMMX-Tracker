import Database from "better-sqlite3";
import path from "path";

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;
  const dbFile = path.resolve(process.env.SQLITE_FILE ?? "./race_data.db");
  _db = new Database(dbFile);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  return _db;
}

export function parseBool(v: number | null | undefined): boolean {
  return v === 1;
}

export function parseJsonArr<T = unknown>(v: string | null | undefined): T[] {
  if (!v) return [];
  try {
    return JSON.parse(v) as T[];
  } catch {
    return [];
  }
}

export function parseJson<T>(v: string | null | undefined, fallback: T): T {
  if (!v) return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}
