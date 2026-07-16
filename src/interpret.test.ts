import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildInterpretPrompt, interpretFreeText } from './interpret.js';
import type { SkillDef } from './skills.js';

const base = join(tmpdir(), 'inemaccvbot-test-interpret');
const DEFS: SkillDef[] = [
  { command: 'explicativo', mkiSkill: 'explicativo', description: 'vídeo explicativo', example: 'explicativo: X' },
];

beforeAll(() => {
  rmSync(base, { recursive: true, force: true });
  mkdirSync(join(base, 'yt-pub-lives2'), { recursive: true });
});

describe('buildInterpretPrompt', () => {
  it('inclui skills e destinos válidos', () => {
    const p = buildInterpretPrompt('faz um vídeo', DEFS, ['lives2']);
    expect(p).toContain('explicativo');
    expect(p).toContain('lives2');
    expect(p).toContain('JSON');
  });
});

describe('interpretFreeText', () => {
  it('valida e converte o JSON do Claude em instruções', async () => {
    const run = async () => JSON.stringify([{ skill: 'explicativo', input: 'IA na saúde', vertical: true, dest: 'lives2', pesquisa: false }]);
    const r = await interpretFreeText('pesquisa...', DEFS, base, run);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.instrs[0]).toMatchObject({ skill: 'explicativo', vertical: true, destToken: 'lives2' });
    expect(r.instrs[0].dest).toBe(join(base, 'yt-pub-lives2', 'imports', 'videos'));
  });
  it('recusa skill fora do registro', async () => {
    const run = async () => JSON.stringify([{ skill: 'carrossel', input: 'x' }]);
    const r = await interpretFreeText('faz carrossel', DEFS, base, run);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('carrossel');
  });
  it('recusa quando o Claude responde RECUSAR', async () => {
    const r = await interpretFreeText('joga xadrez', DEFS, base, async () => 'RECUSAR: não é pedido de vídeo');
    expect(r.ok).toBe(false);
  });
  it('erro claro quando o JSON vem quebrado', async () => {
    const r = await interpretFreeText('x', DEFS, base, async () => 'não sei');
    expect(r.ok).toBe(false);
  });
  it('recusa curso com espaço vindo do Claude', async () => {
    const run = async () => JSON.stringify([{ skill: 'explicativo', input: 'x', curso: 'Meu Curso' }]);
    const r = await interpretFreeText('faz um vídeo de curso', DEFS, base, run);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('espaço');
  });
  it('recusa modulo com espaço vindo do Claude', async () => {
    const run = async () => JSON.stringify([{ skill: 'explicativo', input: 'x', modulo: 't1 m1' }]);
    const r = await interpretFreeText('faz um vídeo de curso', DEFS, base, run);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('espaço');
  });
  it('destino inexistente vindo do Claude lista os destinos válidos', async () => {
    const run = async () => JSON.stringify([{ skill: 'explicativo', input: 'x', dest: 'lives99' }]);
    const r = await interpretFreeText('faz um vídeo', DEFS, base, run);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('lives2');
  });
  it('narracao=true vindo do Claude é propagado pra instrução', async () => {
    const run = async () => JSON.stringify([{ skill: 'explicativo', input: 'x', narracao: true }]);
    const r = await interpretFreeText('vídeo com a narração em texto', DEFS, base, run);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.instrs[0].narracao).toBe(true);
  });
  it('aceita o envelope {jobs, ignorado} e extrai o job mapeável mesmo com pedido extra', async () => {
    const run = async () => JSON.stringify({
      jobs: [{ skill: 'explicativo', input: 'IA na saúde', narracao: true }],
      ignorado: 'mandar o vídeo por e-mail',
    });
    const r = await interpretFreeText('faz um vídeo sobre IA na saúde, com a narração em texto, e manda por e-mail', DEFS, base, run);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.instrs).toHaveLength(1);
    expect(r.instrs[0]).toMatchObject({ skill: 'explicativo', narracao: true });
    expect(r.ignorado).toContain('e-mail');
  });
  it('envelope com ignorado null não seta ignorado no resultado', async () => {
    const run = async () => JSON.stringify({ jobs: [{ skill: 'explicativo', input: 'x' }], ignorado: null });
    const r = await interpretFreeText('faz um vídeo', DEFS, base, run);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ignorado).toBeUndefined();
  });
  it('formato array antigo (sem envelope) continua funcionando, por compatibilidade', async () => {
    const run = async () => JSON.stringify([{ skill: 'explicativo', input: 'x' }]);
    const r = await interpretFreeText('faz um vídeo', DEFS, base, run);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.instrs).toHaveLength(1);
    expect(r.ignorado).toBeUndefined();
  });
});
