import Database from 'better-sqlite3';

export interface TrackedJob {
  jobId: number; chatId: number; dest: string | null; destToken: string | null;
  briefing: string | null; lastStatus: string; createdAt: string;
}

export class StateStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.exec(`CREATE TABLE IF NOT EXISTS tracked_jobs (
      job_id INTEGER PRIMARY KEY,
      chat_id INTEGER NOT NULL,
      dest TEXT,
      dest_token TEXT,
      briefing TEXT,
      last_status TEXT NOT NULL DEFAULT 'queued',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
  }

  track(j: Omit<TrackedJob, 'lastStatus' | 'createdAt'>): void {
    this.db.prepare(`INSERT INTO tracked_jobs (job_id, chat_id, dest, dest_token, briefing)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(job_id) DO UPDATE SET chat_id=excluded.chat_id, dest=excluded.dest,
        dest_token=excluded.dest_token, briefing=excluded.briefing`)
      .run(j.jobId, j.chatId, j.dest, j.destToken, j.briefing);
  }

  private static row(r: any): TrackedJob {
    return { jobId: r.job_id, chatId: r.chat_id, dest: r.dest, destToken: r.dest_token,
      briefing: r.briefing, lastStatus: r.last_status, createdAt: r.created_at };
  }

  pending(): TrackedJob[] {
    return this.db.prepare(`SELECT * FROM tracked_jobs WHERE last_status IN ('queued','running') ORDER BY job_id`)
      .all().map(StateStore.row);
  }

  setStatus(jobId: number, status: string): void {
    this.db.prepare(`UPDATE tracked_jobs SET last_status=? WHERE job_id=?`).run(status, jobId);
  }

  get(jobId: number): TrackedJob | undefined {
    const r = this.db.prepare(`SELECT * FROM tracked_jobs WHERE job_id=?`).get(jobId);
    return r ? StateStore.row(r) : undefined;
  }

  close(): void { this.db.close(); }
}
