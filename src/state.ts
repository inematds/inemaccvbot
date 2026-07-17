import Database from 'better-sqlite3';

export interface TrackedJob {
  jobId: number; chatId: number; dest: string | null; destToken: string | null;
  pesquisa: boolean; transcrever: boolean; narracaoPath: string | null; lastStatus: string; createdAt: string;
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
      pesquisa INTEGER NOT NULL DEFAULT 0,
      narracao_path TEXT,
      last_status TEXT NOT NULL DEFAULT 'queued',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    // Migração leve: bancos criados antes das colunas narracao_path/transcrever existirem.
    const cols = this.db.prepare(`PRAGMA table_info(tracked_jobs)`).all() as { name: string }[];
    if (!cols.some((c) => c.name === 'narracao_path')) {
      this.db.exec(`ALTER TABLE tracked_jobs ADD COLUMN narracao_path TEXT`);
    }
    if (!cols.some((c) => c.name === 'transcrever')) {
      this.db.exec(`ALTER TABLE tracked_jobs ADD COLUMN transcrever INTEGER NOT NULL DEFAULT 0`);
    }
  }

  track(j: Omit<TrackedJob, 'lastStatus' | 'createdAt' | 'narracaoPath' | 'transcrever'>
    & { narracaoPath?: string | null; transcrever?: boolean }): void {
    this.db.prepare(`INSERT INTO tracked_jobs (job_id, chat_id, dest, dest_token, pesquisa, transcrever, narracao_path)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(job_id) DO UPDATE SET chat_id=excluded.chat_id, dest=excluded.dest,
        dest_token=excluded.dest_token, pesquisa=excluded.pesquisa, transcrever=excluded.transcrever,
        narracao_path=excluded.narracao_path`)
      .run(j.jobId, j.chatId, j.dest, j.destToken, j.pesquisa ? 1 : 0, j.transcrever ? 1 : 0, j.narracaoPath ?? null);
  }

  private static row(r: any): TrackedJob {
    return { jobId: r.job_id, chatId: r.chat_id, dest: r.dest, destToken: r.dest_token,
      pesquisa: Boolean(r.pesquisa), transcrever: Boolean(r.transcrever), narracaoPath: r.narracao_path ?? null,
      lastStatus: r.last_status, createdAt: r.created_at };
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

  /** Todos os jobs rastreados de UM chat (qualquer status), mais recentes primeiro, limitado a `limit`.
   * Usada pra responder perguntas escopadas ao chat que perguntou — nunca vaza jobs de outro chat. */
  forChat(chatId: number, limit = 20): TrackedJob[] {
    return this.db.prepare(`SELECT * FROM tracked_jobs WHERE chat_id=? ORDER BY job_id DESC LIMIT ?`)
      .all(chatId, limit).map(StateStore.row);
  }

  close(): void { this.db.close(); }
}
