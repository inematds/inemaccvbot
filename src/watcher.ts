import path from 'node:path';
import type { MkiJob } from './queue-client.js';
import type { StateStore, TrackedJob } from './state.js';

export interface WatcherDeps {
  jobs: () => Promise<MkiJob[]>;
  state: StateStore;
  notify: (chatId: number, text: string) => Promise<void>;
  /** Fallback quando um job pendente saiu da janela de 50 de `jobs()` (finding 4). Opcional. */
  jobById?: (id: number) => Promise<MkiJob | undefined>;
}

/** `14m` / `1h2m` / `45s` — null se algum timestamp faltar (nunca inventa duração). */
export function formatDuration(startedAt?: number | null, finishedAt?: number | null): string | null {
  if (startedAt == null || finishedAt == null) return null;
  const totalSeconds = finishedAt - startedAt;
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return null;
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

export function doneMessage(job: MkiJob, tracked: TrackedJob): string {
  const lines = [`✅ vídeo #${job.id} pronto (${job.skill})`, `📄 ${job.result_path ?? '(sem caminho)'}`];
  const duration = formatDuration(job.started_at, job.finished_at);
  if (duration) lines.push(`⏱ duração: ${duration}`);
  if (tracked.dest) {
    if (job.result_path && isInsideDest(job.result_path, tracked.dest)) {
      lines.push(`📦 movido para ${tracked.destToken} (${tracked.dest})`);
    } else {
      lines.push(`⚠️ ficou fora do destino ${tracked.destToken} (${tracked.dest}) — arquivo está no caminho acima`);
    }
  }
  if (tracked.pesquisa) lines.push('🔎 com pesquisa');
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
    let job = byId.get(t.jobId);
    if (!job && deps.jobById) {
      // Job caiu fora da janela de 50 de jobs() (ex.: várias linhas numa mensagem só
      // empurraram jobs mais velhos pra fora) — busca individual em vez de pular,
      // senão o job fica pending() pra sempre e nunca notifica.
      try { job = await deps.jobById(t.jobId); } catch (e) {
        console.error('[watcher] jobById falhou:', (e as Error).message);
      }
    }
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
