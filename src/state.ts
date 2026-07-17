import Database from 'better-sqlite3';

/** Duas filas independentes (daemons `mkivideos`/`mkitexto`) — ids são por-DB, então um job só
 * é identificado sem ambiguidade pelo PAR (queue, jobId), nunca só pelo jobId. */
export type Queue = 'video' | 'texto';

export interface TrackedJob {
  queue: Queue; jobId: number; chatId: number; dest: string | null; destToken: string | null;
  pesquisa: boolean; transcrever: boolean; narracaoPath: string | null; lastStatus: string; createdAt: string;
  /** Só relevante pra jobs `reel` com `dest` setado: false (default) = watcher COPIA o resultado
   * pra `dest` mantendo o original; true = watcher MOVE. Ignorado por qualquer outra skill. */
  mover: boolean;
}

const CREATE_TABLE_SQL = `CREATE TABLE IF NOT EXISTS tracked_jobs (
  queue TEXT NOT NULL,
  job_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  dest TEXT,
  dest_token TEXT,
  pesquisa INTEGER NOT NULL DEFAULT 0,
  transcrever INTEGER NOT NULL DEFAULT 0,
  narracao_path TEXT,
  mover INTEGER NOT NULL DEFAULT 0,
  last_status TEXT NOT NULL DEFAULT 'queued',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (queue, job_id)
)`;

export class StateStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.exec(CREATE_TABLE_SQL);
    // Migração: bancos criados antes da coluna `queue` existir tinham job_id como PK sozinho —
    // não dá pra alterar a PK composta com ALTER TABLE no SQLite, e como esta tabela é só um
    // cache de rastreamento (nunca fonte de verdade — a fila real vive no daemon mkivideos),
    // recriar limpo é seguro e mais simples que uma migração de dados.
    let cols = this.db.prepare(`PRAGMA table_info(tracked_jobs)`).all() as { name: string }[];
    if (!cols.some((c) => c.name === 'queue')) {
      this.db.exec(`DROP TABLE tracked_jobs`);
      this.db.exec(CREATE_TABLE_SQL);
      cols = this.db.prepare(`PRAGMA table_info(tracked_jobs)`).all() as { name: string }[];
    }
    // Migração aditiva pra bancos que já tinham `queue` mas não `mover` (coluna nova) — ALTER TABLE
    // ADD COLUMN é seguro aqui (sem PK envolvida, sem perda de dado), ao contrário do caso acima.
    if (!cols.some((c) => c.name === 'mover')) {
      this.db.exec(`ALTER TABLE tracked_jobs ADD COLUMN mover INTEGER NOT NULL DEFAULT 0`);
    }
  }

  track(j: Omit<TrackedJob, 'lastStatus' | 'createdAt' | 'narracaoPath' | 'transcrever' | 'mover'>
    & { narracaoPath?: string | null; transcrever?: boolean; mover?: boolean }): void {
    this.db.prepare(`INSERT INTO tracked_jobs (queue, job_id, chat_id, dest, dest_token, pesquisa, transcrever, narracao_path, mover)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(queue, job_id) DO UPDATE SET chat_id=excluded.chat_id, dest=excluded.dest,
        dest_token=excluded.dest_token, pesquisa=excluded.pesquisa, transcrever=excluded.transcrever,
        narracao_path=excluded.narracao_path, mover=excluded.mover`)
      .run(j.queue, j.jobId, j.chatId, j.dest, j.destToken, j.pesquisa ? 1 : 0, j.transcrever ? 1 : 0, j.narracaoPath ?? null, j.mover ? 1 : 0);
  }

  private static row(r: any): TrackedJob {
    return { queue: r.queue, jobId: r.job_id, chatId: r.chat_id, dest: r.dest, destToken: r.dest_token,
      pesquisa: Boolean(r.pesquisa), transcrever: Boolean(r.transcrever), narracaoPath: r.narracao_path ?? null,
      mover: Boolean(r.mover), lastStatus: r.last_status, createdAt: r.created_at };
  }

  pending(): TrackedJob[] {
    return this.db.prepare(`SELECT * FROM tracked_jobs WHERE last_status IN ('queued','running') ORDER BY queue, job_id`)
      .all().map(StateStore.row);
  }

  setStatus(queue: Queue, jobId: number, status: string): void {
    this.db.prepare(`UPDATE tracked_jobs SET last_status=? WHERE queue=? AND job_id=?`).run(status, queue, jobId);
  }

  get(queue: Queue, jobId: number): TrackedJob | undefined {
    const r = this.db.prepare(`SELECT * FROM tracked_jobs WHERE queue=? AND job_id=?`).get(queue, jobId);
    return r ? StateStore.row(r) : undefined;
  }

  /** Todos os jobs rastreados de UM chat (qualquer status, qualquer fila), mais recentes primeiro,
   * limitado a `limit`. Usada pra responder perguntas escopadas ao chat que perguntou (nunca vaza
   * jobs de outro chat) e pra resolver um id NU (`resolveJobArg`, jobref.ts) contra as duas filas. */
  forChat(chatId: number, limit = 20): TrackedJob[] {
    return this.db.prepare(`SELECT * FROM tracked_jobs WHERE chat_id=? ORDER BY job_id DESC LIMIT ?`)
      .all(chatId, limit).map(StateStore.row);
  }

  close(): void { this.db.close(); }
}
