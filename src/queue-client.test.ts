import { describe, it, expect } from 'vitest';
import { QueueClient, parseAddOutput } from './queue-client.js';

const cfg = { mkiDir: '/mki', mkiDb: '/mki/db', dashUrl: 'http://localhost:3142', dashToken: 'tok' };

describe('parseAddOutput', () => {
  it('extrai o id', () => {
    expect(parseAddOutput('enfileirado #41 (explicativo) → /x')).toBe(41);
  });
  it('null quando é erro', () => {
    expect(parseAddOutput('erro: uso: ...')).toBeNull();
  });
});

describe('QueueClient', () => {
  it('add usa o exec injetado e devolve o id', async () => {
    const calls: string[][] = [];
    const c = new QueueClient(cfg, async (args) => { calls.push(args); return 'enfileirado #7 (demo)'; });
    expect(await c.add(['add', 'demo', 'x', '--silencioso'])).toBe(7);
    expect(calls[0]).toEqual(['add', 'demo', 'x', '--silencioso']);
  });
  it('add lança quando o CLI devolve erro', async () => {
    const c = new QueueClient(cfg, async () => 'erro: skill inválida');
    await expect(c.add(['add', 'x', 'y'])).rejects.toThrow(/erro: skill inválida/);
  });
  it('jobs consulta a API com token', async () => {
    const fetchFn = (async (url: any) => {
      expect(String(url)).toBe('http://localhost:3142/api/video-jobs?token=tok');
      return { ok: true, json: async () => ({ jobs: [{ id: 1, status: 'done' }] }) } as any;
    }) as typeof fetch;
    const c = new QueueClient(cfg, async () => '', fetchFn);
    expect((await c.jobs())[0]).toMatchObject({ id: 1, status: 'done' });
  });
  it('ping false quando a API falha', async () => {
    const fetchFn = (async () => { throw new Error('down'); }) as unknown as typeof fetch;
    const c = new QueueClient(cfg, async () => '', fetchFn);
    expect(await c.ping()).toBe(false);
  });
});
