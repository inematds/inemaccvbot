import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';

const pExecFile = promisify(execFile);

export interface MkiJob {
  id: number; skill: string; input: string; opts: string | null;
  status: 'queued' | 'running' | 'done' | 'failed' | 'canceled';
  result_path: string | null; error: string | null;
}

export type ExecFn = (args: string[]) => Promise<string>;

export function parseAddOutput(out: string): number | null {
  const m = out.match(/enfileirado #(\d+)/);
  return m ? Number(m[1]) : null;
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

  async job(id: number): Promise<MkiJob | undefined> {
    return (await this.jobs()).find((j) => j.id === id);
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
