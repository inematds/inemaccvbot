import { describe, it, expect } from 'vitest';
import { StateStore } from './state.js';

describe('StateStore', () => {
  it('track + get + pending + setStatus', () => {
    const s = new StateStore(':memory:');
    s.track({ queue: 'video', jobId: 41, chatId: 123, dest: '/x/videos', destToken: 'lives3', pesquisa: false });
    s.track({ queue: 'video', jobId: 42, chatId: 123, dest: null, destToken: null, pesquisa: true });
    expect(s.get('video', 41)?.lastStatus).toBe('queued');
    expect(s.get('video', 41)?.pesquisa).toBe(false);
    expect(s.get('video', 42)?.pesquisa).toBe(true);
    expect(s.pending().map((j) => j.jobId)).toEqual([41, 42]);
    s.setStatus('video', 41, 'done');
    expect(s.pending().map((j) => j.jobId)).toEqual([42]);
    expect(s.get('video', 41)?.lastStatus).toBe('done');
    s.close();
  });
  it('track do mesmo (queue, jobId) sobrescreve sem erro', () => {
    const s = new StateStore(':memory:');
    s.track({ queue: 'video', jobId: 1, chatId: 9, dest: null, destToken: null, pesquisa: false });
    s.track({ queue: 'video', jobId: 1, chatId: 9, dest: null, destToken: null, pesquisa: false });
    expect(s.pending()).toHaveLength(1);
    s.close();
  });
  it('V#5 e T#5 são jobs distintos — mesma jobId, filas diferentes', () => {
    const s = new StateStore(':memory:');
    s.track({ queue: 'video', jobId: 5, chatId: 1, dest: null, destToken: null, pesquisa: false });
    s.track({ queue: 'texto', jobId: 5, chatId: 1, dest: null, destToken: null, pesquisa: false });
    expect(s.pending()).toHaveLength(2);
    expect(s.get('video', 5)).toBeTruthy();
    expect(s.get('texto', 5)).toBeTruthy();
    s.setStatus('video', 5, 'done');
    expect(s.get('video', 5)?.lastStatus).toBe('done');
    expect(s.get('texto', 5)?.lastStatus).toBe('queued');
    s.close();
  });
  it('forChat devolve queue de cada job rastreado', () => {
    const s = new StateStore(':memory:');
    s.track({ queue: 'video', jobId: 1, chatId: 1, dest: null, destToken: null, pesquisa: false });
    s.track({ queue: 'texto', jobId: 2, chatId: 1, dest: null, destToken: null, pesquisa: false });
    const jobs = s.forChat(1);
    expect(jobs.find((j) => j.jobId === 1)?.queue).toBe('video');
    expect(jobs.find((j) => j.jobId === 2)?.queue).toBe('texto');
    s.close();
  });
});
