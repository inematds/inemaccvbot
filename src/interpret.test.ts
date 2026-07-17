import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildInterpretPrompt, interpretFreeText } from './interpret.js';
import type { SkillDef } from './skills.js';

const base = join(tmpdir(), 'inemaccvbot-test-interpret');
const DEFS: SkillDef[] = [
  { command: 'explicativo', mkiSkill: 'explicativo', queue: 'video', description: 'vídeo explicativo', example: 'explicativo: X' },
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
    if (!r.ok || r.kind !== 'jobs') return;
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
    if (!r.ok || r.kind !== 'jobs') return;
    expect(r.instrs[0].narracao).toBe(true);
  });
  it('aceita o envelope {jobs, ignorado} e extrai o job mapeável mesmo com pedido extra', async () => {
    const run = async () => JSON.stringify({
      jobs: [{ skill: 'explicativo', input: 'IA na saúde', narracao: true }],
      ignorado: 'mandar o vídeo por e-mail',
    });
    const r = await interpretFreeText('faz um vídeo sobre IA na saúde, com a narração em texto, e manda por e-mail', DEFS, base, run);
    expect(r.ok).toBe(true);
    if (!r.ok || r.kind !== 'jobs') return;
    expect(r.instrs).toHaveLength(1);
    expect(r.instrs[0]).toMatchObject({ skill: 'explicativo', narracao: true });
    expect(r.ignorado).toContain('e-mail');
  });
  it('envelope com ignorado null não seta ignorado no resultado', async () => {
    const run = async () => JSON.stringify({ jobs: [{ skill: 'explicativo', input: 'x' }], ignorado: null });
    const r = await interpretFreeText('faz um vídeo', DEFS, base, run);
    expect(r.ok).toBe(true);
    if (!r.ok || r.kind !== 'jobs') return;
    expect(r.ignorado).toBeUndefined();
  });
  it('formato array antigo (sem envelope) continua funcionando, por compatibilidade', async () => {
    const run = async () => JSON.stringify([{ skill: 'explicativo', input: 'x' }]);
    const r = await interpretFreeText('faz um vídeo', DEFS, base, run);
    expect(r.ok).toBe(true);
    if (!r.ok || r.kind !== 'jobs') return;
    expect(r.instrs).toHaveLength(1);
    expect(r.ignorado).toBeUndefined();
  });
  it('classifica pergunta sobre o serviço ("terminou?") como question, não job', async () => {
    const run = async () => JSON.stringify({ pergunta: 'terminou?' });
    const r = await interpretFreeText('terminou?', DEFS, base, run);
    expect(r.ok).toBe(true);
    if (!r.ok || r.kind !== 'question') return;
    expect(r.question).toContain('terminou');
  });
  it('classifica pergunta ("quanto falta?") como question', async () => {
    const run = async () => JSON.stringify({ pergunta: 'quanto falta pro vídeo ficar pronto?' });
    const r = await interpretFreeText('quanto falta?', DEFS, base, run);
    expect(r.ok).toBe(true);
    if (!r.ok || r.kind !== 'question') return;
    expect(r.question).toContain('falta');
  });
  it('classifica pergunta ("você moveu pro lives3?") como question', async () => {
    const run = async () => JSON.stringify({ pergunta: 'você moveu o vídeo pro lives3?' });
    const r = await interpretFreeText('você moveu pro lives3?', DEFS, base, run);
    expect(r.ok).toBe(true);
    if (!r.ok || r.kind !== 'question') return;
    expect(r.question).toContain('lives3');
  });
  it('pedido de vídeo continua indo pro caminho de jobs como hoje', async () => {
    const run = async () => JSON.stringify([{ skill: 'explicativo', input: 'IA na saúde' }]);
    const r = await interpretFreeText('faz um vídeo sobre IA na saúde', DEFS, base, run);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.kind).toBe('jobs');
  });
  it('transcrever=true vindo do Claude é propagado pra instrução (pedido de transcrever o áudio)', async () => {
    const run = async () => JSON.stringify([{ skill: 'explicativo', input: 'https://instagram.com/reel/x', transcrever: true }]);
    const r = await interpretFreeText('transcreva o áudio desse reel e faz um vídeo', DEFS, base, run);
    expect(r.ok).toBe(true);
    if (!r.ok || r.kind !== 'jobs') return;
    expect(r.instrs[0].transcrever).toBe(true);
  });
  it('prompt inclui o campo transcrever no contrato de resposta', () => {
    const p = buildInterpretPrompt('faz um vídeo', DEFS, []);
    expect(p).toContain('transcrever');
  });
  it('"jogue xadrez comigo" ainda é recusado', async () => {
    const r = await interpretFreeText('jogue xadrez comigo', DEFS, base, async () => 'RECUSAR: não é pedido de vídeo nem pergunta sobre o serviço');
    expect(r.ok).toBe(false);
  });

  it('bug 1: objeto único sem wrapper de array vira uma instrução, não é recusado', async () => {
    const run = async () => JSON.stringify({ skill: 'explicativo', input: 'IA na saúde', vertical: true });
    const r = await interpretFreeText('faz um vídeo sobre IA na saúde', DEFS, base, run);
    expect(r.ok).toBe(true);
    if (!r.ok || r.kind !== 'jobs') return;
    expect(r.instrs).toHaveLength(1);
    expect(r.instrs[0]).toMatchObject({ skill: 'explicativo', input: 'IA na saúde', vertical: true });
  });

  it('bug 2: free-text "reel /p/a.mp4 com imagem ilustrativa" vira job reel com o caminho e visuais=true', async () => {
    const REEL_DEFS: SkillDef[] = [...DEFS, { command: 'reel', mkiSkill: 'reel', queue: 'video', description: 'reel a partir de avatar', example: 'reel: /p/a.mp4' }];
    const run = async () => JSON.stringify([{ skill: 'reel', input: '/p/a.mp4', visuais: true }]);
    const r = await interpretFreeText('quero um reel /p/a.mp4 com imagem ilustrativa', REEL_DEFS, base, run);
    expect(r.ok).toBe(true);
    if (!r.ok || r.kind !== 'jobs') return;
    expect(r.instrs[0]).toMatchObject({ skill: 'reel', input: '/p/a.mp4', visuais: true });
  });

  it('prompt orienta que "input" do reel é caminho de arquivo, e inclui visuais/mover no contrato', () => {
    const p = buildInterpretPrompt('faz um reel', DEFS, []);
    expect(p).toContain('visuais');
    expect(p).toContain('mover');
    expect(p.toLowerCase()).toContain('caminho');
  });
});
