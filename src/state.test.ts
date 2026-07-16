import { describe, it, expect } from 'vitest';
import { StateStore } from './state.js';

describe('StateStore', () => {
  it('track + get + pending + setStatus', () => {
    const s = new StateStore(':memory:');
    s.track({ jobId: 41, chatId: 123, dest: '/x/videos', destToken: 'lives3', pesquisa: false });
    s.track({ jobId: 42, chatId: 123, dest: null, destToken: null, pesquisa: true });
    expect(s.get(41)?.lastStatus).toBe('queued');
    expect(s.get(41)?.pesquisa).toBe(false);
    expect(s.get(42)?.pesquisa).toBe(true);
    expect(s.pending().map((j) => j.jobId)).toEqual([41, 42]);
    s.setStatus(41, 'done');
    expect(s.pending().map((j) => j.jobId)).toEqual([42]);
    expect(s.get(41)?.lastStatus).toBe('done');
    s.close();
  });
  it('track do mesmo jobId sobrescreve sem erro', () => {
    const s = new StateStore(':memory:');
    s.track({ jobId: 1, chatId: 9, dest: null, destToken: null, pesquisa: false });
    s.track({ jobId: 1, chatId: 9, dest: null, destToken: null, pesquisa: false });
    expect(s.pending()).toHaveLength(1);
    s.close();
  });
});
