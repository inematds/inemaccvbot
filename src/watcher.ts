import path from 'node:path';
import type { MkiJob } from './queue-client.js';
import type { StateStore, TrackedJob } from './state.js';

export interface WatcherDeps {
  jobs: () => Promise<MkiJob[]>;
  state: StateStore;
  notify: (chatId: number, text: string) => Promise<void>;
}

export function doneMessage(job: MkiJob, tracked: TrackedJob): string {
  const lines = [`✅ vídeo #${job.id} pronto (${job.skill})`, `📄 ${job.result_path ?? '(sem caminho)'}`];
  if (tracked.dest) {
    if (job.result_path && isInsideDest(job.result_path, tracked.dest)) {
      lines.push(`📦 movido para ${tracked.destToken} (${tracked.dest})`);
    } else {
      lines.push(`⚠️ ficou fora do destino ${tracked.destToken} (${tracked.dest}) — arquivo está no caminho acima`);
    }
  }
  if (tracked.briefing) lines.push(`🔎 briefing: ${tracked.briefing}`);
  lines.push(`use /enviar ${job.id} para receber o arquivo`);
  return lines.join('\n');
}

function isInsideDest(resultPath: string, dest: string): boolean {
  const rel = path.relative(dest, resultPath);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function failMessage(job: MkiJob, tracked: TrackedJob): string {
  const err = (job.error ?? 'sem detalhe').slice(0, 500);
  return [`❌ vídeo #${job.id} falhou (${job.skill})`, `motivo: ${err}`, `detalhe completo: /status ${job.id}`].join('\n');
}

export async function tick(deps: WatcherDeps): Promise<void> {
  const pending = deps.state.pending();
  if (!pending.length) return;
  let all: MkiJob[];
  try { all = await deps.jobs(); } catch (e) {
    console.error('[watcher] poll falhou:', (e as Error).message);
    return;
  }
  const byId = new Map(all.map((j) => [j.id, j]));
  for (const t of pending) {
    const job = byId.get(t.jobId);
    if (!job || job.status === t.lastStatus) continue;

    const terminalMessage = job.status === 'done' ? doneMessage(job, t)
      : job.status === 'failed' ? failMessage(job, t)
      : job.status === 'canceled' ? `🚫 job #${job.id} cancelado`
      : null;

    if (terminalMessage === null) {
      // Transição não-terminal (ex.: queued -> running): nada a notificar, nada a perder.
      deps.state.setStatus(t.jobId, job.status);
      continue;
    }

    try {
      await deps.notify(t.chatId, terminalMessage);
      // Só persiste o status terminal DEPOIS do notify ter sucesso, senão o job
      // some de pending() e a notificação nunca é reentregue.
      deps.state.setStatus(t.jobId, job.status);
    } catch (e) {
      console.error('[watcher] notify falhou:', (e as Error).message);
    }
  }
}

export function startWatcher(deps: WatcherDeps, intervalMs: number): () => void {
  const h = setInterval(() => { void tick(deps); }, intervalMs);
  return () => clearInterval(h);
}
