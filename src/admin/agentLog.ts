import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

/**
 * Append-only status log backing the admin console's Agent Feed.
 * "run_*" kinds bracket an operator-triggered run (see
 * outreachRunner.ts) sharing one runId so the UI can group them; plain
 * "status" entries aren't part of any run.
 */
export type AgentLogKind = "status" | "run_started" | "run_completed" | "run_failed";

export interface AgentLogEntry {
  id: string;
  kind: AgentLogKind;
  runId: string | null;
  message: string;
  createdAt: string;
}

interface AgentLogRow {
  id: string;
  kind: AgentLogKind;
  run_id: string | null;
  message: string;
  created_at: string;
}

function rowToEntry(row: AgentLogRow): AgentLogEntry {
  return { id: row.id, kind: row.kind, runId: row.run_id, message: row.message, createdAt: row.created_at };
}

export class AgentLogStore {
  constructor(private readonly db: Database.Database) {}

  append(kind: AgentLogKind, message: string, runId: string | null = null): AgentLogEntry {
    const entry: AgentLogEntry = { id: randomUUID(), kind, runId, message, createdAt: new Date().toISOString() };
    this.db
      .prepare(`INSERT INTO agent_log (id, kind, run_id, message, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(entry.id, entry.kind, entry.runId, entry.message, entry.createdAt);
    return entry;
  }

  /** Oldest-first — the feed reads top-to-bottom like a real log. */
  recent(limit: number): AgentLogEntry[] {
    const rows = this.db
      .prepare<[number], AgentLogRow>(`SELECT * FROM agent_log ORDER BY created_at DESC LIMIT ?`)
      .all(limit);
    return rows.reverse().map(rowToEntry);
  }
}
