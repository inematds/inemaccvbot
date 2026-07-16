import { describe, it, expect } from 'vitest';
import { tick, doneMessage } from './watcher.js';
import { StateStore } from './state.js';
import type { MkiJob } from './queue-client.js';

const mkJob = (over: Partial<MkiJob>): MkiJob => ({
  id: 1, skill: 'explicativo', input: 'X', opts: null,
  status: 'queued', result_path: null, error: null, ...over,
});

describe('tick', () => {
  it('notifica done uma única vez e marca o estado', async () => {
    const state = new StateStore(':memory:');
    state.track({ jobId: 1, chatId: 77, dest: '/d/videos', destToken: 'lives3', briefing: null });
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
    state.track({ jobId: 2, chatId: 77, dest: null, destToken: null, briefing: null });
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
    state.track({ jobId: 3, chatId: 77, dest: null, destToken: null, briefing: null });
    const sent: string[] = [];
    await tick({ jobs: async () => [mkJob({ id: 3, status: 'running' as const })], state, notify: async (_c, t) => { sent.push(t); } });
    expect(sent).toHaveLength(0);
    expect(state.get(3)?.lastStatus).toBe('running');
  });
  it('erro no poll não derruba (fila fora do ar)', async () => {
    const state = new StateStore(':memory:');
    state.track({ jobId: 4, chatId: 77, dest: null, destToken: null, briefing: null });
    await expect(tick({ jobs: async () => { throw new Error('down'); }, state, notify: async () => {} })).resolves.toBeUndefined();
  });
});

describe('doneMessage', () => {
  it('avisa quando o resultado NÃO caiu no destino pedido', () => {
    const msg = doneMessage(
      mkJob({ id: 5, status: 'done', result_path: '/outro/lugar/v.mp4' }),
      { jobId: 5, chatId: 1, dest: '/d/videos', destToken: 'lives3', briefing: null, lastStatus: 'running', createdAt: '' },
    );
    expect(msg).toContain('/outro/lugar/v.mp4');
    expect(msg.toLowerCase()).toContain('fora do destino');
  });
});
