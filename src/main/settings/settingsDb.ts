import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import sqlite3 from "sqlite3";

import type { SettingsStorageInfo } from "../../shared/settings";

type Database = sqlite3.Database;

let dbPromise: Promise<Database> | null = null;

export function getSettingsStorageInfo(): SettingsStorageInfo {
  const packagedAppDir =
    process.env.PORTABLE_EXECUTABLE_DIR ?? path.dirname(process.execPath);
  const dataDir = app.isPackaged
    ? path.join(packagedAppDir, "data")
    : path.join(process.cwd(), "data");

  return {
    dataDir,
    dbPath: path.join(dataDir, "midi-studio.sqlite3")
  };
}

export async function getSettingsDb(): Promise<Database> {
  if (!dbPromise) {
    dbPromise = openSettingsDb();
  }

  return dbPromise;
}

export async function readSettingValue(key: string): Promise<string | null> {
  const db = await getSettingsDb();
  const row = await get<{ value: string }>(
    db,
    "SELECT value FROM user_settings WHERE key = ?",
    [key]
  );

  return row?.value ?? null;
}

export async function writeSettingValue(key: string, value: string): Promise<void> {
  const db = await getSettingsDb();
  await run(
    db,
    `INSERT INTO user_settings (key, value, updated_at)
     VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = CURRENT_TIMESTAMP`,
    [key, value]
  );
}

async function openSettingsDb(): Promise<Database> {
  const storage = getSettingsStorageInfo();
  fs.mkdirSync(storage.dataDir, { recursive: true });

  const sqlite = sqlite3.verbose();
  const db = await new Promise<Database>((resolve, reject) => {
    const database = new sqlite.Database(storage.dbPath, (error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(database);
    });
  });

  await initializeSchema(db);
  return db;
}

async function initializeSchema(db: Database): Promise<void> {
  await run(
    db,
    `CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`
  );
  await run(
    db,
    `CREATE TABLE IF NOT EXISTS user_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`
  );
  await run(
    db,
    `INSERT INTO app_meta (key, value)
     VALUES ('schema_version', '1')
     ON CONFLICT(key) DO NOTHING`
  );
}

function run(db: Database, sql: string, params: unknown[] = []): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run(sql, params, (error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function get<T>(db: Database, sql: string, params: unknown[] = []): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row: T | undefined) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(row);
    });
  });
}
