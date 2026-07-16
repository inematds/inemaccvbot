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
    if (job.result_path && job.result_path.startsWith(tracked.dest)) {
      lines.push(`📦 movido para ${tracked.destToken} (${tracked.dest})`);
    } else {
      lines.push(`⚠️ ficou fora do destino ${tracked.destToken} (${tracked.dest}) — arquivo está no caminho acima`);
    }
  }
  if (tracked.briefing) lines.push(`🔎 briefing: ${tracked.briefing}`);
  lines.push(`use /enviar ${job.id} para receber o arquivo`);
  return lines.join('\n');
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
    deps.state.setStatus(t.jobId, job.status);
    try {
      if (job.status === 'done') await deps.notify(t.chatId, doneMessage(job, t));
      else if (job.status === 'failed') await deps.notify(t.chatId, failMessage(job, t));
      else if (job.status === 'canceled') await deps.notify(t.chatId, `🚫 job #${job.id} cancelado`);
    } catch (e) {
      console.error('[watcher] notify falhou:', (e as Error).message);
    }
  }
}

export function startWatcher(deps: WatcherDeps, intervalMs: number): () => void {
  const h = setInterval(() => { void tick(deps); }, intervalMs);
  return () => clearInterval(h);
}
