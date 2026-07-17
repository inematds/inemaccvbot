import type { Queue, TrackedJob } from './state.js';

export interface JobRef { queue: Queue; jobId: number }

const PREFIX_TO_QUEUE: Record<string, Queue> = { v: 'video', t: 'texto' };
const QUEUE_TO_PREFIX: Record<Queue, string> = { video: 'V', texto: 'T' };

/** Aceita "V5", "V#5", "v5", "T#7" (case-insensitive, com ou sem "#"). Devolve null se não bater
 * o formato prefixado — nesse caso o chamador trata como id NU (ambíguo entre filas). */
export function parseJobRef(raw: string): JobRef | null {
  const m = raw.trim().match(/^([vt])#?(\d+)$/i);
  if (!m) return null;
  return { queue: PREFIX_TO_QUEUE[m[1].toLowerCase()], jobId: Number(m[2]) };
}

/** `V#48` (vídeo) / `T#7` (texto) — id user-facing usado em toda notificação e resposta de comando. */
export function formatJobRef(ref: JobRef): string {
  return `${QUEUE_TO_PREFIX[ref.queue]}#${ref.jobId}`;
}

export type ResolveResult =
  | { kind: 'ok'; ref: JobRef }
  | { kind: 'ambiguous'; candidates: JobRef[] }
  | { kind: 'notfound' };

/** Resolve um argumento de id (`/status <arg>`, `/cancelar <arg>`, `/enviar <arg>`) contra os jobs
 * rastreados do chat que perguntou. Um id PREFIXADO (V#/T#) é sempre inequívoco — nem precisa
 * bater com nada rastreado. Um id NU só resolve se casar com exatamente uma fila entre os jobs
 * rastreados desse chat; se não achar nenhum ou achar em mais de uma fila, NUNCA adivinha —
 * devolve 'notfound' ou 'ambiguous' pro chamador perguntar/avisar. */
export function resolveJobArg(arg: string, tracked: Pick<TrackedJob, 'queue' | 'jobId'>[]): ResolveResult {
  const prefixed = parseJobRef(arg);
  if (prefixed) return { kind: 'ok', ref: prefixed };
  const bareId = Number(arg.trim());
  if (!Number.isInteger(bareId)) return { kind: 'notfound' };
  const queues = [...new Set(tracked.filter((t) => t.jobId === bareId).map((t) => t.queue))];
  if (queues.length === 0) return { kind: 'notfound' };
  if (queues.length > 1) return { kind: 'ambiguous', candidates: queues.map((queue) => ({ queue, jobId: bareId })) };
  return { kind: 'ok', ref: { queue: queues[0], jobId: bareId } };
}
