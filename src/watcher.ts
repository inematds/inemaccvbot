import path from 'node:path';
import { existsSync, mkdirSync, copyFileSync, unlinkSync } from 'node:fs';
import type { MkiJob } from './queue-client.js';
import type { StateStore, TrackedJob, Queue } from './state.js';
import { formatJobRef } from './jobref.js';
import { consoleLogger, type Logger } from './log.js';

export interface QueueSource {
  queue: Queue;
  jobs: () => Promise<MkiJob[]>;
  /** Fallback quando um job pendente saiu da janela de 50 de `jobs()` (finding 4). Opcional. */
  jobById?: (id: number) => Promise<MkiJob | undefined>;
}

export interface WatcherDeps {
  /** Uma fonte por fila (vídeo/texto) — o watcher só consulta jobs() de UMA fila com jobs
   * pendentes na fila correspondente, nunca cruza (um jobId do vídeo nunca é buscado no texto). */
  queues: QueueSource[];
  state: StateStore;
  notify: (chatId: number, text: string) => Promise<void>;
  /** Entrega a narração salva pelo agente de render (texto curto inline ou arquivo). Opcional —
   * quando ausente, `tick` segue funcionando normalmente (só não entrega narração). */
  sendNarration?: (chatId: number, path: string) => Promise<void>;
  log?: Logger;
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

/** Resultado da cópia/movimentação feita pelo WATCHER pra jobs `reel` (nunca `--pasta` — ver
 * skills.ts). `ok:false` nunca é silencioso: `doneMessage` sempre relata a falha mantendo o
 * caminho original, nunca afirmando sucesso que não aconteceu. */
export interface ReelDestOutcome { mode: 'copy' | 'move'; ok: boolean; error?: string }

/**
 * Copia (default) ou move (`mover`=true) `resultPath` pra dentro de `destDir`. Idempotente pro caso
 * de MOVE: se uma tick anterior já moveu o arquivo (notify falhou depois, então a tick rodou de
 * novo) — original sumiu mas o destino já existe — trata como sucesso sem tentar de novo.
 */
export function applyReelDest(resultPath: string, destDir: string, mover: boolean): ReelDestOutcome {
  const mode: ReelDestOutcome['mode'] = mover ? 'move' : 'copy';
  const target = path.join(destDir, path.basename(resultPath));
  try {
    if (mover && !existsSync(resultPath) && existsSync(target)) return { mode, ok: true };
    mkdirSync(destDir, { recursive: true });
    copyFileSync(resultPath, target);
    if (mover) unlinkSync(resultPath);
    return { mode, ok: true };
  } catch (e) {
    return { mode, ok: false, error: (e as Error).message };
  }
}

/** `narrationAvailable` só é relevante quando `tracked.narracaoPath` está setado — indica se o
 * arquivo de narração existe no disco (o watcher checa isso no momento do tick, antes de chamar
 * esta função pura). Sem isso, nunca afirma que a narração foi entregue.
 * `reelOutcome` (só pra jobs `reel` com destino): resultado real da cópia/movimentação feita pelo
 * watcher — quando presente, substitui a lógica legada de "ficou dentro/fora do destino" (que
 * assume que `--pasta` já moveu o arquivo, o que NUNCA acontece pra `reel`). */
export function doneMessage(job: MkiJob, tracked: TrackedJob, narrationAvailable?: boolean, reelOutcome?: ReelDestOutcome): string {
  const ref = formatJobRef({ queue: tracked.queue, jobId: job.id });
  const lines = [`✅ ${ref} pronto (${job.skill})`, `📄 ${job.result_path ?? '(sem caminho)'}`];
  const duration = formatDuration(job.started_at, job.finished_at);
  if (duration) lines.push(`⏱ duração: ${duration}`);
  if (reelOutcome) {
    if (reelOutcome.ok) {
      lines.push(reelOutcome.mode === 'move'
        ? `📦 movido para ${tracked.destToken} (${tracked.dest})`
        : `📋 copiado para ${tracked.destToken} (${tracked.dest})`);
    } else {
      const verbo = reelOutcome.mode === 'move' ? 'mover' : 'copiar';
      lines.push(`⚠️ falha ao ${verbo} para ${tracked.destToken} (${tracked.dest}): ${reelOutcome.error} — arquivo original em ${job.result_path ?? '(sem caminho)'}`);
    }
  } else if (tracked.dest) {
    if (job.result_path && isInsideDest(job.result_path, tracked.dest)) {
      lines.push(`📦 movido para ${tracked.destToken} (${tracked.dest})`);
    } else {
      lines.push(`⚠️ ficou fora do destino ${tracked.destToken} (${tracked.dest}) — arquivo está no caminho acima`);
    }
  }
  if (tracked.pesquisa) lines.push('🔎 com pesquisa');
  if (tracked.transcrever) lines.push('🎙️ com transcrição pedida');
  if (tracked.narracaoPath) {
    lines.push(narrationAvailable
      ? '📝 narração em texto: enviando a seguir'
      : '⚠️ narração em texto pedida, mas o agente não gerou o arquivo — nada foi entregue');
  }
  lines.push(`use /enviar ${ref} para receber o arquivo`);
  return lines.join('\n');
}

function isInsideDest(resultPath: string, dest: string): boolean {
  const rel = path.relative(dest, resultPath);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function failMessage(job: MkiJob, tracked: TrackedJob): string {
  const ref = formatJobRef({ queue: tracked.queue, jobId: job.id });
  const err = (job.error ?? 'sem detalhe').slice(0, 500);
  return [`❌ ${ref} falhou (${job.skill})`, `motivo: ${err}`, `detalhe completo: /status ${ref}`].join('\n');
}

export async function tick(deps: WatcherDeps): Promise<void> {
  const log = deps.log ?? consoleLogger();
  const pending = deps.state.pending();
  if (!pending.length) return;

  const pendingByQueue = new Map<Queue, TrackedJob[]>();
  for (const t of pending) {
    const list = pendingByQueue.get(t.queue);
    if (list) list.push(t); else pendingByQueue.set(t.queue, [t]);
  }

  for (const src of deps.queues) {
    const list = pendingByQueue.get(src.queue);
    if (!list || !list.length) continue;

    let all: MkiJob[];
    try { all = await src.jobs(); } catch (e) {
      log.error(`[watcher] poll falhou (${src.queue}): ${(e as Error).message}`);
      continue;
    }
    const byId = new Map(all.map((j) => [j.id, j]));

    for (const t of list) {
      let job = byId.get(t.jobId);
      if (!job && src.jobById) {
        // Job caiu fora da janela de 50 de jobs() (ex.: várias linhas numa mensagem só
        // empurraram jobs mais velhos pra fora) — busca individual em vez de pular,
        // senão o job fica pending() pra sempre e nunca notifica.
        try { job = await src.jobById(t.jobId); } catch (e) {
          log.error(`[watcher] jobById falhou (${src.queue}): ${(e as Error).message}`);
        }
      }
      if (!job || job.status === t.lastStatus) continue;

      const narrationAvailable = job.status === 'done' && t.narracaoPath ? existsSync(t.narracaoPath) : undefined;
      // `reel`/`reelinematds` nunca usam `--pasta` (skills.ts) — se um destino foi pedido, é O
      // WATCHER quem copia (default) ou move (`mover`) o resultado, só quando o job efetivamente
      // terminou 'done'.
      let reelOutcome: ReelDestOutcome | undefined;
      if (job.status === 'done' && (job.skill === 'reel' || job.skill === 'reelinematds') && t.dest) {
        reelOutcome = job.result_path
          ? applyReelDest(job.result_path, t.dest, t.mover)
          : { mode: t.mover ? 'move' : 'copy', ok: false, error: 'job sem result_path' };
      }
      const ref = formatJobRef({ queue: t.queue, jobId: job.id });
      const terminalMessage = job.status === 'done' ? doneMessage(job, t, narrationAvailable, reelOutcome)
        : job.status === 'failed' ? failMessage(job, t)
        : job.status === 'canceled' ? `🚫 job ${ref} cancelado`
        : null;

      if (terminalMessage === null) {
        // Transição não-terminal (ex.: queued -> running): nada a notificar, nada a perder.
        deps.state.setStatus(t.queue, t.jobId, job.status);
        continue;
      }

      try {
        await deps.notify(t.chatId, terminalMessage);
        // Só persiste o status terminal DEPOIS do notify ter sucesso, senão o job
        // some de pending() e a notificação nunca é reentregue.
        deps.state.setStatus(t.queue, t.jobId, job.status);
        log.info(`[notificado] chat ${t.chatId}: job ${ref} -> ${job.status}`);
      } catch (e) {
        log.error(`[watcher] notify falhou (job ${ref}): ${(e as Error).message}`);
        continue; // não tenta entregar narração sem antes garantir o aviso principal
      }

      // Entrega da narração é best-effort e NÃO pode derrubar o aviso principal (já entregue acima).
      if (job.status === 'done' && narrationAvailable && t.narracaoPath && deps.sendNarration) {
        try {
          await deps.sendNarration(t.chatId, t.narracaoPath);
          log.info(`[narração entregue] chat ${t.chatId}: job ${ref}`);
        } catch (e) {
          log.error(`[watcher] sendNarration falhou (job ${ref}): ${(e as Error).message}`);
        }
      }
    }
  }
}

export function startWatcher(deps: WatcherDeps, intervalMs: number): () => void {
  const h = setInterval(() => { void tick(deps); }, intervalMs);
  return () => clearInterval(h);
}
