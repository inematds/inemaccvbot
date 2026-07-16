import { describe, it, expect } from 'vitest';
import { QueueClient, parseAddOutput, parseStatusOutput } from './queue-client.js';

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
  it('jobById parseia a saída de `status <id>` e devolve o job (fallback fora da janela de 50)', async () => {
    const c = new QueueClient(cfg, async (args) => {
      expect(args).toEqual(['status', '99']);
      return '#99 [done] explicativo · entrada=X · resultado=/v/mkivideo-99.mp4';
    });
    const job = await c.jobById(99);
    expect(job).toMatchObject({ id: 99, status: 'done', skill: 'explicativo', result_path: '/v/mkivideo-99.mp4' });
  });
  it('jobById devolve undefined numa resposta não reconhecida (nunca inventa status terminal)', async () => {
    const c = new QueueClient(cfg, async () => '#99 não existe');
    expect(await c.jobById(99)).toBeUndefined();
  });
});

describe('parseStatusOutput', () => {
  it('extrai id, status, skill, resultado e erro', () => {
    const j = parseStatusOutput('#41 [failed] demo · entrada=X · erro=render explodiu');
    expect(j).toMatchObject({ id: 41, status: 'failed', skill: 'demo', error: 'render explodiu' });
  });
  it('undefined quando não bate o formato esperado', () => {
    expect(parseStatusOutput('erro: uso: ...')).toBeUndefined();
    expect(parseStatusOutput('#5 [status-invalido] x')).toBeUndefined();
  });
});
