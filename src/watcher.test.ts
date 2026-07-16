import { describe, it, expect } from 'vitest';
import { tick, doneMessage, formatDuration } from './watcher.js';
import { StateStore } from './state.js';
import type { MkiJob } from './queue-client.js';

const mkJob = (over: Partial<MkiJob>): MkiJob => ({
  id: 1, skill: 'explicativo', input: 'X', opts: null,
  status: 'queued', result_path: null, error: null, ...over,
});

describe('tick', () => {
  it('notifica done uma única vez e marca o estado', async () => {
    const state = new StateStore(':memory:');
    state.track({ jobId: 1, chatId: 77, dest: '/d/videos', destToken: 'lives3', pesquisa: false });
    const sent: string[] = [];
    const deps = {
      jobs: async () => [mkJob({ id: 1, status: 'done' as const, result_path: '/d/videos/mkivideo-1.mp4' })],
      state,
      notify: async (_chat: number, text: string) => { sent.push(text); },
    };
    await tick(deps);
    await tick(deps); // segunda rodada não repete
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('mkivideo-1.mp4');
    expect(sent[0]).toContain('lives3');
    expect(state.get(1)?.lastStatus).toBe('done');
  });
  it('notifica failed com o erro', async () => {
    const state = new StateStore(':memory:');
    state.track({ jobId: 2, chatId: 77, dest: null, destToken: null, pesquisa: false });
    const sent: string[] = [];
    await tick({
      jobs: async () => [mkJob({ id: 2, status: 'failed' as const, error: 'render explodiu' })],
      state,
      notify: async (_c, t) => { sent.push(t); },
    });
    expect(sent[0]).toContain('render explodiu');
    expect(state.get(2)?.lastStatus).toBe('failed');
  });
  it('running só atualiza status, sem notificar', async () => {
    const state = new StateStore(':memory:');
    state.track({ jobId: 3, chatId: 77, dest: null, destToken: null, pesquisa: false });
    const sent: string[] = [];
    await tick({ jobs: async () => [mkJob({ id: 3, status: 'running' as const })], state, notify: async (_c, t) => { sent.push(t); } });
    expect(sent).toHaveLength(0);
    expect(state.get(3)?.lastStatus).toBe('running');
  });
  it('erro no poll não derruba (fila fora do ar)', async () => {
    const state = new StateStore(':memory:');
    state.track({ jobId: 4, chatId: 77, dest: null, destToken: null, pesquisa: false });
    await expect(tick({ jobs: async () => { throw new Error('down'); }, state, notify: async () => {} })).resolves.toBeUndefined();
  });
  it('job fora da janela de 50 usa jobById como fallback e notifica', async () => {
    const state = new StateStore(':memory:');
    state.track({ jobId: 8, chatId: 77, dest: null, destToken: null, pesquisa: false });
    const sent: string[] = [];
    await tick({
      jobs: async () => [], // job #8 caiu fora da janela
      jobById: async (id) => (id === 8 ? mkJob({ id: 8, status: 'done' as const, result_path: '/v/mkivideo-8.mp4' }) : undefined),
      state,
      notify: async (_c, t) => { sent.push(t); },
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('mkivideo-8.mp4');
    expect(state.get(8)?.lastStatus).toBe('done');
  });
  it('sem jobById e job fora da janela: fica pendente, sem crash', async () => {
    const state = new StateStore(':memory:');
    state.track({ jobId: 9, chatId: 77, dest: null, destToken: null, pesquisa: false });
    await tick({ jobs: async () => [], state, notify: async () => {} });
    expect(state.pending().map((p) => p.jobId)).toContain(9);
  });
  it('notify falha em job done: job continua pendente, status não é persistido, e uma tick seguinte com notify funcionando entrega a mensagem exatamente uma vez', async () => {
    const state = new StateStore(':memory:');
    state.track({ jobId: 6, chatId: 77, dest: '/d/videos', destToken: 'lives3', pesquisa: false });
    const job = mkJob({ id: 6, status: 'done' as const, result_path: '/d/videos/mkivideo-6.mp4' });
    const jobsDep = { jobs: async () => [job] };

    await tick({ ...jobsDep, state, notify: async () => { throw new Error('rate limit'); } });
    expect(state.pending().map((p) => p.jobId)).toContain(6);
    expect(state.get(6)?.lastStatus).not.toBe('done');

    const sent: string[] = [];
    await tick({ ...jobsDep, state, notify: async (_c, t) => { sent.push(t); } });
    expect(sent).toHaveLength(1);
    expect(state.get(6)?.lastStatus).toBe('done');

    // uma terceira rodada não deve reenviar
    await tick({ ...jobsDep, state, notify: async (_c, t) => { sent.push(t); } });
    expect(sent).toHaveLength(1);
  });
});

describe('doneMessage', () => {
  it('avisa quando o resultado NÃO caiu no destino pedido', () => {
    const msg = doneMessage(
      mkJob({ id: 5, status: 'done', result_path: '/outro/lugar/v.mp4' }),
      { jobId: 5, chatId: 1, dest: '/d/videos', destToken: 'lives3', pesquisa: false, lastStatus: 'running', createdAt: '' },
    );
    expect(msg).toContain('/outro/lugar/v.mp4');
    expect(msg.toLowerCase()).toContain('fora do destino');
  });
  it('não trata diretório irmão com prefixo igual como dentro do destino', () => {
    const msg = doneMessage(
      mkJob({ id: 7, status: 'done', result_path: '/x/videos-old/f.mp4' }),
      { jobId: 7, chatId: 1, dest: '/x/videos', destToken: 'lives3', pesquisa: false, lastStatus: 'running', createdAt: '' },
    );
    expect(msg).toContain('/x/videos-old/f.mp4');
    expect(msg.toLowerCase()).toContain('fora do destino');
  });
  it('inclui a duração quando started_at/finished_at estão presentes', () => {
    const msg = doneMessage(
      mkJob({ id: 9, status: 'done', result_path: '/v/v.mp4', started_at: 1000, finished_at: 1000 + 62 }),
      { jobId: 9, chatId: 1, dest: null, destToken: null, pesquisa: false, lastStatus: 'running', createdAt: '' },
    );
    expect(msg).toContain('1m');
  });
  it('omite a duração quando algum timestamp falta', () => {
    const msg = doneMessage(
      mkJob({ id: 10, status: 'done', result_path: '/v/v.mp4' }),
      { jobId: 10, chatId: 1, dest: null, destToken: null, pesquisa: false, lastStatus: 'running', createdAt: '' },
    );
    expect(msg).not.toContain('duração');
  });
  it('marca "com pesquisa" quando o job foi enfileirado com pesquisa', () => {
    const msg = doneMessage(
      mkJob({ id: 11, status: 'done', result_path: '/v/v.mp4' }),
      { jobId: 11, chatId: 1, dest: null, destToken: null, pesquisa: true, lastStatus: 'running', createdAt: '' },
    );
    expect(msg).toContain('com pesquisa');
  });
  it('não menciona pesquisa quando o job não foi enfileirado com pesquisa', () => {
    const msg = doneMessage(
      mkJob({ id: 12, status: 'done', result_path: '/v/v.mp4' }),
      { jobId: 12, chatId: 1, dest: null, destToken: null, pesquisa: false, lastStatus: 'running', createdAt: '' },
    );
    expect(msg).not.toContain('pesquisa');
  });
});

describe('formatDuration', () => {
  it('formata segundos, minutos e horas', () => {
    expect(formatDuration(0, 45)).toBe('45s');
    expect(formatDuration(0, 14 * 60)).toBe('14m');
    expect(formatDuration(0, 3600 + 120)).toBe('1h2m');
  });
  it('null quando falta timestamp ou delta é negativo', () => {
    expect(formatDuration(null, 10)).toBeNull();
    expect(formatDuration(10, null)).toBeNull();
    expect(formatDuration(20, 10)).toBeNull();
  });
});
