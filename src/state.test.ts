import { describe, it, expect } from 'vitest';
import { StateStore } from './state.js';

describe('StateStore', () => {
  it('track + get + pending + setStatus', () => {
    const s = new StateStore(':memory:');
    s.track({ jobId: 41, chatId: 123, dest: '/x/videos', destToken: 'lives3', briefing: null });
    s.track({ jobId: 42, chatId: 123, dest: null, destToken: null, briefing: '/b/41.md' });
    expect(s.get(41)?.lastStatus).toBe('queued');
    expect(s.pending().map((j) => j.jobId)).toEqual([41, 42]);
    s.setStatus(41, 'done');
    expect(s.pending().map((j) => j.jobId)).toEqual([42]);
    expect(s.get(41)?.lastStatus).toBe('done');
    s.close();
  });
  it('track do mesmo jobId sobrescreve sem erro', () => {
    const s = new StateStore(':memory:');
    s.track({ jobId: 1, chatId: 9, dest: null, destToken: null, briefing: null });
    s.track({ jobId: 1, chatId: 9, dest: null, destToken: null, briefing: null });
    expect(s.pending()).toHaveLength(1);
    s.close();
  });
});
