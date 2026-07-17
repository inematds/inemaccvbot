import { existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import type { QueueClient } from './queue-client.js';
import type { StateStore, TrackedJob } from './state.js';
import type { ClaudeRunner } from './interpret.js';
import type { SkillDef } from './skills.js';
import { helpText, skillsText } from './help.js';
import { formatJobRef } from './jobref.js';
import { truncate } from './log.js';

export interface QueueSnapshot {
  filaText: string;
  statsText: string;
  unreachable: boolean;
}

export interface AnswerContext {
  video: QueueSnapshot;
  texto: QueueSnapshot;
  trackedJobs: TrackedJob[];
  logTail: string;
  capabilitiesText: string;
}

async function snapshotQueue(client: QueueClient): Promise<QueueSnapshot> {
  try {
    const reachable = await client.ping();
    if (!reachable) return { filaText: '', statsText: '', unreachable: true };
    const [filaText, statsText] = await Promise.all([
      client.fila().catch(() => ''),
      client.stats().catch(() => ''),
    ]);
    return { filaText, statsText, unreachable: false };
  } catch {
    return { filaText: '', statsText: '', unreachable: true };
  }
}

/** Lê só o final de `file` (últimas `maxLines` linhas), sem nunca carregar o arquivo inteiro
 * na memória — lê no máximo `chunkBytes` a partir do fim via file descriptor. Trunca linhas
 * muito longas. Tolerante a arquivo ausente/vazio/ilegível (nunca lança). */
export function readLogTail(file: string, maxLines = 150, maxLineLen = 300, chunkBytes = 200_000): string {
  if (!existsSync(file)) return '(sem log ainda)';
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return '(log inacessível)';
  }
  if (size === 0) return '(log vazio)';
  const readSize = Math.min(size, chunkBytes);
  const start = size - readSize;
  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch {
    return '(log inacessível)';
  }
  try {
    const buf = Buffer.alloc(readSize);
    readSync(fd, buf, 0, readSize, start);
    const text = buf.toString('utf8');
    const lines = text.split('\n').filter((l) => l.length > 0);
    // se começamos no meio do arquivo, a primeira linha pode estar cortada — descarta.
    const usable = start > 0 && lines.length > 1 ? lines.slice(1) : lines;
    const tail = usable.slice(-maxLines);
    return tail.length ? tail.map((l) => truncate(l, maxLineLen)).join('\n') : '(log vazio)';
  } catch {
    return '(falha ao ler log)';
  } finally {
    try { closeSync(fd); } catch { /* noop */ }
  }
}

/** Junta os fatos disponíveis pra responder uma pergunta sobre o serviço (ou sobre as capacidades
 * do bot), ESCOPADOS ao `chatId` que perguntou (nunca vaza jobs de outro chat). Nunca lança — se
 * UMA das filas estiver fora do ar, marca `unreachable` NESSA fila e segue com o que existe pra
 * ela (a outra fila e o state local/log continuam informativos). `defs`/`dests` alimentam
 * `capabilitiesText` (skills registradas + texto do /help) — mesma fonte real usada pelos
 * comandos /skills e /help, pra a resposta de "o que você sabe fazer" nunca inventar nada. */
export async function buildAnswerContext(
  chatId: number, videoClient: QueueClient, textoClient: QueueClient, state: StateStore, logFile: string,
  defs: SkillDef[], dests: string[], tailLines = 150,
): Promise<AnswerContext> {
  const [video, texto] = await Promise.all([snapshotQueue(videoClient), snapshotQueue(textoClient)]);
  const trackedJobs = state.forChat(chatId);
  const logTail = readLogTail(logFile, tailLines);
  const capabilitiesText = [skillsText(defs), '', helpText(defs, dests)].join('\n');
  return { video, texto, trackedJobs, logTail, capabilitiesText };
}

function jobLine(j: TrackedJob): string {
  const parts = [
    formatJobRef({ queue: j.queue, jobId: j.jobId }),
    `status=${j.lastStatus}`,
    `destino=${j.destToken ?? '(padrão)'}`,
    `pesquisa=${j.pesquisa ? 'sim' : 'não'}`,
    `narracao=${j.narracaoPath ? 'sim' : 'não'}`,
  ];
  return parts.join(' ');
}

export function buildAnswerPrompt(question: string, ctx: AnswerContext): string {
  const jobsText = ctx.trackedJobs.length
    ? ctx.trackedJobs.map(jobLine).join('\n')
    : '(nenhum job registrado para este chat)';
  return [
    'Você é o assistente do inemaccvbot (bot Telegram de DUAS filas de jobs — vídeo e texto). Responda em PT-BR,',
    'CURTO e FACTUAL, usando SOMENTE as informações do CONTEXTO abaixo. Se o contexto não tiver a resposta, diga',
    'claramente que não sabe — NUNCA invente status, prazos ou ações que não estejam no contexto.',
    'Nunca revele caminhos de arquivos de configuração (.env), tokens, credenciais, ou trechos de log que',
    'pareçam ruído interno/segredo — resuma o que aconteceu em linguagem natural, sem despejar o log cru.',
    'Se a pergunta for sobre o que você CONSEGUE ou NÃO CONSEGUE fazer (capacidades), responda com base',
    'SOMENTE na seção "capacidades do bot" abaixo — ela é a lista real de skills registradas e comandos.',
    'Diga PLANAMENTE o que você NÃO faz (qualquer coisa fora dessas skills e comandos) em vez de prometer',
    'ou especular sobre uma capacidade que não está listada.',
    'Os jobs deste chat aparecem com id prefixado (V#12 = fila de vídeo, T#7 = fila de texto) — use esse',
    'prefixo na resposta quando falar de um job específico, nunca um número solto ambíguo entre as duas filas.',
    ctx.video.unreachable
      ? 'AVISO: a fila de VÍDEO está inacessível agora — responda sobre ela só com o que já se sabe pelo state local e pelo log, e avise que está fora do ar.'
      : '',
    ctx.texto.unreachable
      ? 'AVISO: a fila de TEXTO está inacessível agora — responda sobre ela só com o que já se sabe pelo state local e pelo log, e avise que está fora do ar.'
      : '',
    '',
    '--- capacidades do bot (skills registradas + /help, fonte real) ---',
    ctx.capabilitiesText,
    '--- fila de vídeo (mkivideos, ao vivo) ---',
    ctx.video.filaText || '(indisponível)',
    '--- stats de vídeo ---',
    ctx.video.statsText || '(indisponível)',
    '--- fila de texto (mkitexto, ao vivo) ---',
    ctx.texto.filaText || '(indisponível)',
    '--- stats de texto ---',
    ctx.texto.statsText || '(indisponível)',
    '--- jobs deste chat (registro local do bot, id prefixado V#/T#) ---',
    jobsText,
    '--- log recente do bot (mais novo no final) ---',
    ctx.logTail,
    '',
    '--- pergunta do usuário ---',
    question,
  ].filter((l) => l !== '').join('\n');
}

/** Pergunta ao Claude (via `run` injetado) e devolve a resposta em texto, pronta pra mandar no chat. */
export async function answerQuestion(question: string, ctx: AnswerContext, run: ClaudeRunner): Promise<string> {
  const out = await run(buildAnswerPrompt(question, ctx));
  return out.trim();
}
