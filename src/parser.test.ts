import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseLine, parseMessage } from './parser.js';

const base = join(tmpdir(), 'inemaccvbot-test-parser');
const SKILLS = ['explicativo', 'curso', 'demo', 'timesmkt3'];

beforeAll(() => {
  rmSync(base, { recursive: true, force: true });
  mkdirSync(join(base, 'yt-pub-lives3'), { recursive: true });
});

describe('parseLine', () => {
  it('parseia skill + assunto + formato + destino', () => {
    const r = parseLine('explicativo: O que é RAG | 9:16 | lives3', SKILLS, base);
    expect(r.kind).toBe('instr');
    if (r.kind !== 'instr') return;
    expect(r.instr).toMatchObject({
      skill: 'explicativo', input: 'O que é RAG', vertical: true,
      destToken: 'lives3', pesquisa: false,
    });
    expect(r.instr.dest).toBe(join(base, 'yt-pub-lives3', 'imports', 'videos'));
  });
  it('campos em qualquer ordem + flag pesquisa', () => {
    const r = parseLine('explicativo: Computação quântica | pesquisa | 9:16', SKILLS, base);
    expect(r.kind).toBe('instr');
    if (r.kind !== 'instr') return;
    expect(r.instr.pesquisa).toBe(true);
    expect(r.instr.vertical).toBe(true);
    expect(r.instr.dest).toBeNull();
  });
  it('curso com modulo', () => {
    const r = parseLine('curso: https://x.io/skillsx/ | modulo t1m1', SKILLS, base);
    expect(r.kind).toBe('instr');
    if (r.kind !== 'instr') return;
    expect(r.instr.modulo).toBe('t1m1');
    expect(r.instr.input).toBe('https://x.io/skillsx/');
  });
  it('destino inexistente → error, não free', () => {
    const r = parseLine('explicativo: X | lives99', SKILLS, base);
    expect(r.kind).toBe('error');
    if (r.kind !== 'error') return;
    expect(r.message).toContain('lives99');
  });
  it('skill desconhecida no prefixo → free (fallback)', () => {
    expect(parseLine('fazum: negócio aí', SKILLS, base).kind).toBe('free');
  });
  it('texto livre → free', () => {
    expect(parseLine('pesquisa sobre IA e faz um vídeo', SKILLS, base).kind).toBe('free');
  });
  it('assunto vazio (campo depois do skill some) → error, não vira instr com input errado', () => {
    const r = parseLine('explicativo: | 9:16', SKILLS, base);
    expect(r.kind).toBe('error');
    if (r.kind !== 'error') return;
    expect(r.message).toContain('faltou o assunto/link');
  });
  it('"explicativo:" sem nada depois → error, não free', () => {
    const r = parseLine('explicativo:', SKILLS, base);
    expect(r.kind).toBe('error');
    if (r.kind !== 'error') return;
    expect(r.message).toContain('faltou o assunto/link');
  });
  it('assunto com dois-pontos dentro do texto é preservado inteiro', () => {
    const r = parseLine('explicativo: Erro 500: o que é | 9:16', SKILLS, base);
    expect(r.kind).toBe('instr');
    if (r.kind !== 'instr') return;
    expect(r.instr.input).toBe('Erro 500: o que é');
    expect(r.instr.vertical).toBe(true);
  });
  it('prefixo de skill em maiúsculas é normalizado', () => {
    const r = parseLine('EXPLICATIVO: X', SKILLS, base);
    expect(r.kind).toBe('instr');
    if (r.kind !== 'instr') return;
    expect(r.instr.skill).toBe('explicativo');
  });
  it('prefixo de skill com dígito é reconhecido', () => {
    const r = parseLine('timesmkt3: X', SKILLS, base);
    expect(r.kind).toBe('instr');
    if (r.kind !== 'instr') return;
    expect(r.instr.skill).toBe('timesmkt3');
  });
  it('curso com espaço → error (mkivideos re-junta e re-splita argv, um token só por flag)', () => {
    const r = parseLine('curso: https://x.io/skillsx/ | curso Meu Curso | modulo t1m1', SKILLS, base);
    expect(r.kind).toBe('error');
    if (r.kind !== 'error') return;
    expect(r.message).toContain('espaço');
    expect(r.message).toContain('skillsx');
  });
  it('modulo com espaço → error', () => {
    const r = parseLine('curso: https://x.io/skillsx/ | modulo t1 m1', SKILLS, base);
    expect(r.kind).toBe('error');
    if (r.kind !== 'error') return;
    expect(r.message).toContain('espaço');
  });
  it('flag narracao marca a instrução', () => {
    const r = parseLine('explicativo: X | narracao', SKILLS, base);
    expect(r.kind).toBe('instr');
    if (r.kind !== 'instr') return;
    expect(r.instr.narracao).toBe(true);
  });
  it('sinônimo texto também marca narracao', () => {
    const r = parseLine('explicativo: X | texto', SKILLS, base);
    expect(r.kind).toBe('instr');
    if (r.kind !== 'instr') return;
    expect(r.instr.narracao).toBe(true);
  });
  it('sem o campo, narracao é false por default', () => {
    const r = parseLine('explicativo: X', SKILLS, base);
    expect(r.kind).toBe('instr');
    if (r.kind !== 'instr') return;
    expect(r.instr.narracao).toBe(false);
  });
  it('flag transcrever marca a instrução', () => {
    const r = parseLine('explicativo: https://x.io/reel | transcrever', SKILLS, base);
    expect(r.kind).toBe('instr');
    if (r.kind !== 'instr') return;
    expect(r.instr.transcrever).toBe(true);
  });
  it('sinônimo transcricao/transcrição também marca transcrever', () => {
    const r1 = parseLine('explicativo: X | transcricao', SKILLS, base);
    const r2 = parseLine('explicativo: X | transcrição', SKILLS, base);
    if (r1.kind !== 'instr' || r2.kind !== 'instr') throw new Error('esperava instr');
    expect(r1.instr.transcrever).toBe(true);
    expect(r2.instr.transcrever).toBe(true);
  });
  it('sem o campo, transcrever é false por default', () => {
    const r = parseLine('explicativo: X', SKILLS, base);
    expect(r.kind).toBe('instr');
    if (r.kind !== 'instr') return;
    expect(r.instr.transcrever).toBe(false);
  });
  it('combina transcrever + narracao + livesN numa linha só', () => {
    const r = parseLine('explicativo: https://x.io/reel | transcrever | narracao | lives3', SKILLS, base);
    expect(r.kind).toBe('instr');
    if (r.kind !== 'instr') return;
    expect(r.instr.transcrever).toBe(true);
    expect(r.instr.narracao).toBe(true);
    expect(r.instr.destToken).toBe('lives3');
  });
  it('destino inexistente lista os destinos válidos na mensagem', () => {
    const r = parseLine('explicativo: X | lives99', SKILLS, base);
    expect(r.kind).toBe('error');
    if (r.kind !== 'error') return;
    expect(r.message).toContain('lives3');
  });
});

describe('parseMessage', () => {
  it('uma instrução por linha, ignora linhas vazias', () => {
    const rs = parseMessage('explicativo: A | lives3\n\ndemo: https://b.com', SKILLS, base);
    expect(rs).toHaveLength(2);
    expect(rs.every((r) => r.kind === 'instr')).toBe(true);
  });
});
