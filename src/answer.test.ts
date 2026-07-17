import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readLogTail, buildAnswerContext, buildAnswerPrompt, answerQuestion } from './answer.js';
import { StateStore } from './state.js';
import type { QueueClient } from './queue-client.js';
import type { SkillDef } from './skills.js';

const base = join(tmpdir(), 'inemaccvbot-test-answer');
const logFile = join(base, 'bot.log');
const DEFS: SkillDef[] = [
  { command: 'explicativo', mkiSkill: 'explicativo', queue: 'video', description: 'vídeo explicativo', example: 'explicativo: X' },
];
const DESTS: string[] = ['lives2'];

beforeEach(() => {
  rmSync(base, { recursive: true, force: true });
  mkdirSync(base, { recursive: true });
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('readLogTail', () => {
  it('tolera arquivo ausente sem lançar', () => {
    expect(() => readLogTail(join(base, 'nao-existe.log'))).not.toThrow();
    expect(readLogTail(join(base, 'nao-existe.log'))).toContain('sem log');
  });

  it('tolera arquivo vazio sem lançar', () => {
    writeFileSync(logFile, '');
    expect(() => readLogTail(logFile)).not.toThrow();
    expect(readLogTail(logFile)).toContain('vazio');
  });

  it('devolve só as últimas N linhas', () => {
    const lines = Array.from({ length: 500 }, (_, i) => `linha ${i}`);
    writeFileSync(logFile, `${lines.join('\n')}\n`);
    const tail = readLogTail(logFile, 10);
    const got = tail.split('\n');
    expect(got).toHaveLength(10);
    expect(got[got.length - 1]).toBe('linha 499');
    expect(tail).not.toContain('linha 0\n');
  });

  it('trunca linhas muito longas', () => {
    const long = 'x'.repeat(5000);
    writeFileSync(logFile, `${long}\n`);
    const tail = readLogTail(logFile, 10, 100);
    expect(tail.length).toBeLessThan(200);
    expect(tail.endsWith('…')).toBe(true);
  });

  it('não lê o arquivo inteiro pra memória — funciona mesmo em arquivo grande, lendo só o final', () => {
    // ~1MB de linhas, bem acima do chunk default usado no teste (pequeno de propósito)
    const chunk = 'a'.repeat(200);
    for (let i = 0; i < 6000; i++) appendFileSync(logFile, `${chunk} linha=${i}\n`);
    const tail = readLogTail(logFile, 5, 300, 10_000); // chunkBytes pequeno de propósito
    const got = tail.split('\n').filter(Boolean);
    expect(got.length).toBeLessThanOrEqual(5);
    // a última linha do arquivo deve estar presente (lemos do fim)
    expect(tail).toContain('linha=5999');
  });
});

function fakeClient(overrides: Partial<QueueClient> = {}): QueueClient {
  return {
    ping: async () => true,
    fila: async () => 'fila: 2 rodando',
    stats: async () => 'stats: 10 concluídos',
    status: async () => '',
    cancel: async () => '',
    getPath: async () => '',
    add: async () => 1,
    jobs: async () => [],
    jobById: async () => undefined,
    ...overrides,
  } as unknown as QueueClient;
}

const textoFakeDefault = fakeClient({ fila: async () => 'fila texto: 1 rodando', stats: async () => 'stats texto: 3 concluídos' });

describe('buildAnswerContext', () => {
  it('junta fila/stats/jobs do chat/log das DUAS filas quando estão no ar', async () => {
    writeFileSync(logFile, 'linha de log\n');
    const state = new StateStore(':memory:');
    state.track({ queue: 'video', jobId: 1, chatId: 111, dest: null, destToken: 'lives2', pesquisa: false });
    const ctx = await buildAnswerContext(111, fakeClient(), textoFakeDefault, state, logFile, DEFS, DESTS);
    expect(ctx.video.unreachable).toBe(false);
    expect(ctx.video.filaText).toContain('rodando');
    expect(ctx.video.statsText).toContain('concluídos');
    expect(ctx.texto.unreachable).toBe(false);
    expect(ctx.texto.filaText).toContain('rodando');
    expect(ctx.trackedJobs).toHaveLength(1);
    expect(ctx.logTail).toContain('linha de log');
    state.close();
  });

  it('escopa jobs ao chat que perguntou — não vaza jobs de outro chat', async () => {
    const state = new StateStore(':memory:');
    state.track({ queue: 'video', jobId: 1, chatId: 111, dest: null, destToken: null, pesquisa: false });
    state.track({ queue: 'video', jobId: 2, chatId: 222, dest: null, destToken: null, pesquisa: false });
    const ctx = await buildAnswerContext(111, fakeClient(), textoFakeDefault, state, logFile, DEFS, DESTS);
    expect(ctx.trackedJobs.map((j) => j.jobId)).toEqual([1]);
    state.close();
  });

  it('marca unreachable só na fila de VÍDEO quando o ping dela é false — a de texto segue informativa', async () => {
    const state = new StateStore(':memory:');
    const videoClient = fakeClient({ ping: async () => false });
    const ctx = await buildAnswerContext(111, videoClient, textoFakeDefault, state, logFile, DEFS, DESTS);
    expect(ctx.video.unreachable).toBe(true);
    expect(ctx.video.filaText).toBe('');
    expect(ctx.texto.unreachable).toBe(false);
    expect(ctx.texto.filaText).toContain('rodando');
    state.close();
  });

  it('marca unreachable só na fila de TEXTO quando o ping dela é false — a de vídeo segue informativa', async () => {
    const state = new StateStore(':memory:');
    const textoClient = fakeClient({ ping: async () => false });
    const ctx = await buildAnswerContext(111, fakeClient(), textoClient, state, logFile, DEFS, DESTS);
    expect(ctx.texto.unreachable).toBe(true);
    expect(ctx.video.unreachable).toBe(false);
    state.close();
  });

  it('tolera log ausente sem lançar', async () => {
    const state = new StateStore(':memory:');
    const ctx = await buildAnswerContext(111, fakeClient(), textoFakeDefault, state, join(base, 'nao-existe.log'), DEFS, DESTS);
    expect(ctx.logTail).toContain('sem log');
    state.close();
  });
});

describe('answerQuestion', () => {
  it('passa o contexto pro runner e devolve o texto dele', async () => {
    const state = new StateStore(':memory:');
    const ctx = await buildAnswerContext(111, fakeClient(), textoFakeDefault, state, logFile, DEFS, DESTS);
    let promptSeen = '';
    const run = async (prompt: string) => { promptSeen = prompt; return '  sim, terminou às 10h.  '; };
    const answer = await answerQuestion('terminou?', ctx, run);
    expect(answer).toBe('sim, terminou às 10h.');
    expect(promptSeen).toContain('terminou?');
    expect(promptSeen).toContain('rodando');
    state.close();
  });

  it('o prompt pede pra responder curto/factual e nunca inventar', () => {
    const prompt = buildAnswerPrompt('quanto falta?', {
      video: { filaText: '', statsText: '', unreachable: false },
      texto: { filaText: '', statsText: '', unreachable: false },
      trackedJobs: [], logTail: '(sem log ainda)', capabilitiesText: 'skills: explicativo',
    });
    expect(prompt.toLowerCase()).toContain('não sabe');
    expect(prompt).toContain('quanto falta?');
  });

  it('avisa no prompt quando a fila de vídeo está inacessível', () => {
    const prompt = buildAnswerPrompt('terminou?', {
      video: { filaText: '', statsText: '', unreachable: true },
      texto: { filaText: '', statsText: '', unreachable: false },
      trackedJobs: [], logTail: '(sem log ainda)', capabilitiesText: 'skills: explicativo',
    });
    expect(prompt).toContain('inacessível');
    expect(prompt.toUpperCase()).toContain('VÍDEO');
  });

  it('avisa no prompt quando a fila de texto está inacessível', () => {
    const prompt = buildAnswerPrompt('terminou?', {
      video: { filaText: '', statsText: '', unreachable: false },
      texto: { filaText: '', statsText: '', unreachable: true },
      trackedJobs: [], logTail: '(sem log ainda)', capabilitiesText: 'skills: explicativo',
    });
    expect(prompt).toContain('inacessível');
    expect(prompt.toUpperCase()).toContain('TEXTO');
  });

  it('inclui as capacidades reais (skills/help) no prompt, pra pergunta de capacidade não inventar', () => {
    const prompt = buildAnswerPrompt('você consegue transcrever áudio de um reel?', {
      video: { filaText: '', statsText: '', unreachable: false },
      texto: { filaText: '', statsText: '', unreachable: false },
      trackedJobs: [], logTail: '(sem log ainda)',
      capabilitiesText: 'skills registradas: explicativo',
    });
    expect(prompt).toContain('skills registradas: explicativo');
    expect(prompt.toLowerCase()).toContain('não faz');
  });

  it('buildAnswerContext popula capabilitiesText com as skills e o /help reais', async () => {
    const state = new StateStore(':memory:');
    const ctx = await buildAnswerContext(111, fakeClient(), textoFakeDefault, state, logFile, DEFS, DESTS);
    expect(ctx.capabilitiesText).toContain('explicativo');
    state.close();
  });

  it('jobs deste chat aparecem com id prefixado V#/T# no prompt', async () => {
    const state = new StateStore(':memory:');
    state.track({ queue: 'video', jobId: 12, chatId: 111, dest: null, destToken: null, pesquisa: false });
    state.track({ queue: 'texto', jobId: 7, chatId: 111, dest: null, destToken: null, pesquisa: false });
    const ctx = await buildAnswerContext(111, fakeClient(), textoFakeDefault, state, logFile, DEFS, DESTS);
    const prompt = buildAnswerPrompt('quanto falta?', ctx);
    expect(prompt).toContain('V#12');
    expect(prompt).toContain('T#7');
    state.close();
  });
});
