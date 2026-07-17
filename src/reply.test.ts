import { describe, it, expect, vi } from 'vitest';
import { splitForTelegram, safeReply } from './reply.js';

describe('splitForTelegram', () => {
  it('texto curto vira um único chunk, sem alterar o conteúdo', () => {
    const text = 'oi, tudo bem?';
    expect(splitForTelegram(text)).toEqual([text]);
  });

  it('texto vazio não gera chunk nenhum', () => {
    expect(splitForTelegram('')).toEqual([]);
  });

  it('texto de 10000 chars vira vários chunks, cada um dentro do limite, nada vazio', () => {
    const text = Array.from({ length: 800 }, (_, i) => `linha ${i} com algum conteúdo de exemplo pra engordar`).join('\n');
    expect(text.length).toBeGreaterThan(10000);
    const chunks = splitForTelegram(text, 4000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeGreaterThan(0);
      expect(c.length).toBeLessThanOrEqual(4000);
    }
    // Rejoin não perde nada (as quebras de linha originais são preservadas dentro dos chunks).
    expect(chunks.join('')).toBe(text);
  });

  it('token gigante sem espaço nenhum ainda é quebrado (hard-cut de último recurso)', () => {
    const text = 'x'.repeat(9000);
    const chunks = splitForTelegram(text, 4000);
    expect(chunks.length).toBe(3);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(4000);
    expect(chunks.join('')).toBe(text);
  });

  it('prefere quebrar em espaço quando uma linha isolada estoura o limite', () => {
    const text = Array.from({ length: 1000 }, (_, i) => `palavra${i}`).join(' ');
    const chunks = splitForTelegram(text, 4000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(4000);
    expect(chunks.join('')).toBe(text);
  });
});

describe('safeReply', () => {
  it('envia cada chunk awaited, em ordem', async () => {
    const calls: string[] = [];
    const ctx = { reply: vi.fn(async (t: string) => { calls.push(t); }) } as unknown as Parameters<typeof safeReply>[0];
    const text = 'a'.repeat(9000);
    await safeReply(ctx, text);
    expect(ctx.reply).toHaveBeenCalledTimes(3);
    expect(calls.join('')).toBe(text);
  });

  it('mensagem curta gera uma única chamada de reply', async () => {
    const ctx = { reply: vi.fn(async () => {}) } as unknown as Parameters<typeof safeReply>[0];
    await safeReply(ctx, 'oi');
    expect(ctx.reply).toHaveBeenCalledTimes(1);
    expect(ctx.reply).toHaveBeenCalledWith('oi');
  });
});
