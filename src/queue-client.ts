import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';

const pExecFile = promisify(execFile);

export interface MkiJob {
  id: number; skill: string; input: string; opts: string | null;
  status: 'queued' | 'running' | 'done' | 'failed' | 'canceled';
  result_path: string | null; error: string | null;
  started_at?: number | null; finished_at?: number | null;
}

export type ExecFn = (args: string[]) => Promise<string>;

export function parseAddOutput(out: string): number | null {
  const m = out.match(/enfileirado #(\d+)/);
  return m ? Number(m[1]) : null;
}

const VALID_STATUSES = new Set(['queued', 'running', 'done', 'failed', 'canceled']);

/**
 * Parseia a saída de `mkivideos status <id>` (cmdStatus): campos separados por ' · ',
 * primeiro campo `#<id> [<status>] <skill>`. Parsing defensivo: qualquer formato
 * inesperado devolve undefined (nunca inventa um status terminal falso).
 */
export function parseStatusOutput(out: string): MkiJob | undefined {
  const parts = out.trim().split(' · ');
  const head = parts[0]?.match(/^#(\d+)\s*\[(\w+)\]\s*(.+)$/);
  if (!head) return undefined;
  const status = head[2];
  if (!VALID_STATUSES.has(status)) return undefined;
  let result_path: string | null = null;
  let error: string | null = null;
  for (const p of parts.slice(1)) {
    if (p.startsWith('resultado=')) result_path = p.slice('resultado='.length);
    else if (p.startsWith('erro=')) error = p.slice('erro='.length);
  }
  return {
    id: Number(head[1]), skill: head[3], input: '', opts: null,
    status: status as MkiJob['status'], result_path, error,
    started_at: null, finished_at: null,
  };
}

export class QueueClient {
  private exec: ExecFn;
  private fetchFn: typeof fetch;

  constructor(
    private cfg: { mkiDir: string; mkiDb: string; dashUrl: string; dashToken: string },
    execFn?: ExecFn,
    fetchFn: typeof fetch = fetch,
  ) {
    this.fetchFn = fetchFn;
    this.exec = execFn ?? (async (args) => {
      const { stdout } = await pExecFile('node', [join(this.cfg.mkiDir, 'dist', 'cli.js'), ...args], {
        env: { ...process.env, MKIVIDEOS_DB: this.cfg.mkiDb },
        timeout: 60_000,
      });
      return stdout.trim();
    });
  }

  async add(args: string[]): Promise<number> {
    const out = await this.exec(args);
    const id = parseAddOutput(out);
    if (id === null) throw new Error(`mkivideos add falhou: ${out}`);
    return id;
  }

  private api(path: string): string {
    return `${this.cfg.dashUrl}${path}?token=${this.cfg.dashToken}`;
  }

  async jobs(): Promise<MkiJob[]> {
    const r = await this.fetchFn(this.api('/api/video-jobs'));
    if (!r.ok) throw new Error(`api video-jobs: HTTP ${r.status}`);
    const d = (await r.json()) as { jobs: MkiJob[] };
    return d.jobs;
  }

  /**
   * Busca UM job pelo `mkivideos status <id>` (via CLI, sem o cap de 50 da API/lista).
   * Usada como fallback quando um job pendente saiu da janela de /api/video-jobs.
   * Parsing defensivo: resposta não reconhecida → undefined ("ainda desconhecido, tenta de novo").
   */
  async jobById(id: number): Promise<MkiJob | undefined> {
    let out: string;
    try { out = await this.status(id); } catch { return undefined; }
    const job = parseStatusOutput(out);
    if (!job || job.id !== id) return undefined;
    return job;
  }

  /** `mkivideos refazer <id>` → clona o payload num novo job queued; devolve o novo id.
   * Reusa `parseAddOutput` (a saída também começa com "enfileirado #<id>"). */
  async refazer(id: number): Promise<number> {
    const out = await this.exec(['refazer', String(id)]);
    const newId = parseAddOutput(out);
    if (newId === null) throw new Error(`mkivideos refazer falhou: ${out}`);
    return newId;
  }

  fila(): Promise<string> { return this.exec(['fila']); }
  stats(): Promise<string> { return this.exec(['stats']); }
  status(id: number): Promise<string> { return this.exec(['status', String(id)]); }
  cancel(id: number): Promise<string> { return this.exec(['cancelar', String(id)]); }
  getPath(id: number): Promise<string> { return this.exec(['get', String(id)]); }

  async ping(): Promise<boolean> {
    try {
      const r = await this.fetchFn(this.api('/api/stats'));
      return r.ok;
    } catch { return false; }
  }
}
