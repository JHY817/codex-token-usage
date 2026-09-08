import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export function defaultDataDir() {
  return process.env.CODEX_USAGE_INSIGHTS_DATA_DIR
    ?? path.join(homedir(), ".codex", "token-usage-insights");
}

export class SnapshotStore {
  constructor(dataDir = defaultDataDir()) {
    mkdirSync(dataDir, { recursive: true });
    this.databasePath = path.join(dataDir, "usage.sqlite");
    this.database = new DatabaseSync(this.databasePath);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS usage_snapshots (
        id INTEGER PRIMARY KEY,
        range_key TEXT NOT NULL,
        period_start TEXT NOT NULL,
        period_end TEXT NOT NULL,
        generated_at TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        UNIQUE(range_key, period_start, period_end)
      );
      CREATE INDEX IF NOT EXISTS idx_usage_snapshots_latest
        ON usage_snapshots(range_key, generated_at DESC);
      CREATE TABLE IF NOT EXISTS rollout_file_index (
        file_path TEXT PRIMARY KEY,
        file_size INTEGER NOT NULL,
        file_mtime_ms REAL NOT NULL,
        indexed_at TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_rollout_file_index_mtime
        ON rollout_file_index(file_mtime_ms);
    `);
    this.upsert = this.database.prepare(`
      INSERT INTO usage_snapshots (
        range_key, period_start, period_end, generated_at, payload_json
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(range_key, period_start, period_end)
      DO UPDATE SET generated_at = excluded.generated_at, payload_json = excluded.payload_json
    `);
    this.latest = this.database.prepare(`
      SELECT payload_json FROM usage_snapshots
      WHERE range_key = ?
      ORDER BY generated_at DESC
      LIMIT 1
    `);
    this.rolloutIndexList = this.database.prepare(`
      SELECT file_path, file_size, file_mtime_ms, indexed_at, payload_json
      FROM rollout_file_index
      ORDER BY file_path ASC
    `);
    this.rolloutIndexUpsert = this.database.prepare(`
      INSERT INTO rollout_file_index (
        file_path, file_size, file_mtime_ms, indexed_at, payload_json
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(file_path)
      DO UPDATE SET
        file_size = excluded.file_size,
        file_mtime_ms = excluded.file_mtime_ms,
        indexed_at = excluded.indexed_at,
        payload_json = excluded.payload_json
    `);
    this.rolloutIndexDelete = this.database.prepare(`
      DELETE FROM rollout_file_index WHERE file_path = ?
    `);
  }

  save(dashboard) {
    this.upsert.run(
      dashboard.range,
      dashboard.periodStart,
      dashboard.periodEnd,
      dashboard.generatedAt,
      JSON.stringify(dashboard),
    );
    return dashboard;
  }

  loadLatest(range) {
    const row = this.latest.get(range);
    if (!row) return null;
    try {
      return JSON.parse(row.payload_json);
    } catch {
      return null;
    }
  }

  /**
   * Return only the persisted, privacy-safe aggregate for each rollout file.
   * The payload deliberately contains no prompt, response, or full cwd.
   */
  listRolloutIndex() {
    return this.rolloutIndexList.all();
  }

  saveRolloutIndex(entries, currentPaths = [], removePaths = []) {
    const now = new Date().toISOString();
    const keep = new Set(currentPaths);
    const explicitlyRemoved = new Set(removePaths);
    const stale = this.rolloutIndexList.all()
      .map((row) => row.file_path)
      .filter((filePath) => !keep.has(filePath) || explicitlyRemoved.has(filePath));

    this.database.exec("BEGIN");
    try {
      for (const entry of entries) {
        this.rolloutIndexUpsert.run(
          entry.filePath,
          entry.fileSize,
          entry.fileMtimeMs,
          now,
          JSON.stringify(entry.payload),
        );
      }
      for (const filePath of stale) this.rolloutIndexDelete.run(filePath);
      this.database.exec("COMMIT");
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Preserve the original write error.
      }
      throw error;
    }
  }

  close() {
    this.database.close();
  }
}
