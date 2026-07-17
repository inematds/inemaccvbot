import { describe, it, expect } from 'vitest';
import { parseJobRef, formatJobRef, resolveJobArg } from './jobref.js';

describe('parseJobRef', () => {
  it('aceita V5, V#5, v5, T#7 (case-insensitive, com/sem #)', () => {
    expect(parseJobRef('V5')).toEqual({ queue: 'video', jobId: 5 });
    expect(parseJobRef('V#5')).toEqual({ queue: 'video', jobId: 5 });
    expect(parseJobRef('v5')).toEqual({ queue: 'video', jobId: 5 });
    expect(parseJobRef('v#5')).toEqual({ queue: 'video', jobId: 5 });
    expect(parseJobRef('T7')).toEqual({ queue: 'texto', jobId: 7 });
    expect(parseJobRef('T#7')).toEqual({ queue: 'texto', jobId: 7 });
  });
  it('null pra id nu ou formato inválido', () => {
    expect(parseJobRef('5')).toBeNull();
    expect(parseJobRef('X5')).toBeNull();
    expect(parseJobRef('')).toBeNull();
  });
});

describe('formatJobRef', () => {
  it('formata V#/T#', () => {
    expect(formatJobRef({ queue: 'video', jobId: 48 })).toBe('V#48');
    expect(formatJobRef({ queue: 'texto', jobId: 7 })).toBe('T#7');
  });
});

describe('resolveJobArg', () => {
  it('id prefixado é sempre inequívoco, mesmo sem estar rastreado', () => {
    expect(resolveJobArg('V5', [])).toEqual({ kind: 'ok', ref: { queue: 'video', jobId: 5 } });
    expect(resolveJobArg('T#7', [])).toEqual({ kind: 'ok', ref: { queue: 'texto', jobId: 7 } });
  });
  it('id nu resolve quando bate em exatamente uma fila rastreada', () => {
    const tracked = [{ queue: 'video' as const, jobId: 5 }];
    expect(resolveJobArg('5', tracked)).toEqual({ kind: 'ok', ref: { queue: 'video', jobId: 5 } });
  });
  it('id nu é ambíguo quando existe em V e T pro mesmo chat — não adivinha', () => {
    const tracked = [{ queue: 'video' as const, jobId: 5 }, { queue: 'texto' as const, jobId: 5 }];
    const r = resolveJobArg('5', tracked);
    expect(r.kind).toBe('ambiguous');
    if (r.kind === 'ambiguous') {
      expect(r.candidates).toEqual(expect.arrayContaining([
        { queue: 'video', jobId: 5 }, { queue: 'texto', jobId: 5 },
      ]));
      expect(r.candidates).toHaveLength(2);
    }
  });
  it('id nu não rastreado devolve notfound', () => {
    expect(resolveJobArg('99', [{ queue: 'video', jobId: 5 }])).toEqual({ kind: 'notfound' });
  });
  it('argumento não numérico e sem prefixo devolve notfound', () => {
    expect(resolveJobArg('abc', [])).toEqual({ kind: 'notfound' });
  });
});
