import { describe, it, expect } from 'vitest';
import { loadSkills, skillCommands, buildAddArgs, type SkillDef } from './skills.js';
import type { Instruction } from './parser.js';

const DEFS: SkillDef[] = [
  { command: 'explicativo', mkiSkill: 'explicativo', queue: 'video', description: 'x', example: 'x' },
  { command: 'curso', mkiSkill: 'curso', queue: 'video', description: 'x', example: 'x' },
];

const base: Instruction = { skill: 'explicativo', input: 'O que é RAG', vertical: false, dest: null, destToken: null, pesquisa: false, narracao: false, transcrever: false };

describe('loadSkills', () => {
  it('carrega o registro do config/skills.json, com queue em cada entrada', () => {
    const defs = loadSkills();
    expect(skillCommands(defs)).toEqual(['explicativo', 'curso', 'demo', 'reel', 'reelinematds']);
    for (const d of defs) expect(['video', 'texto']).toContain(d.queue);
  });

  // `transcrever`/`dublar` saíram daqui em 2026-07-30: migraram para o
  // `inemaccbot` (etapa 2 do cutover) e o `mkitexto.service`, que era quem as
  // executava, foi parado e desabilitado. Deixá-las no registro faria este bot
  // aceitar um pedido que ninguém mais executa — o job ficaria pendurado numa
  // fila morta, sem erro e sem resposta.
  it('não sobrou skill da fila de texto — mkitexto está desligado', () => {
    const defs = loadSkills();
    expect(defs.filter((d) => d.queue === 'texto')).toEqual([]);
    expect(defs.every((d) => d.queue === 'video')).toBe(true);
  });
});

describe('buildAddArgs', () => {
  it('monta add básico silencioso', () => {
    expect(buildAddArgs(base, DEFS)).toEqual(['add', 'explicativo', 'O que é RAG', '--silencioso']);
  });
  it('inclui vertical e pasta', () => {
    expect(buildAddArgs({ ...base, vertical: true, dest: '/x/videos', destToken: 'lives3' }, DEFS))
      .toEqual(['add', 'explicativo', 'O que é RAG', '--silencioso', '--vertical', '--pasta', '/x/videos']);
  });
  it('inclui curso/modulo', () => {
    expect(buildAddArgs({ ...base, skill: 'curso', input: 'https://c.io', curso: 'skillsx', modulo: 't1m1' }, DEFS))
      .toEqual(['add', 'curso', 'https://c.io', '--silencioso', '--curso', 'skillsx', '--modulo', 't1m1']);
  });
  it('recusa skill fora do registro', () => {
    expect(() => buildAddArgs({ ...base, skill: 'carrossel' }, DEFS)).toThrow(/não registrada/);
  });
  it('reel NUNCA passa --pasta mesmo com dest setado (cópia/move é do watcher, não do daemon)', () => {
    const REEL_DEFS: SkillDef[] = [...DEFS, { command: 'reel', mkiSkill: 'reel', queue: 'video', description: 'x', example: 'x' }];
    const args = buildAddArgs({ ...base, skill: 'reel', input: '/x/avatar.mp4', dest: '/x/videos', destToken: 'lives3' }, REEL_DEFS);
    expect(args).toEqual(['add', 'reel', '/x/avatar.mp4', '--silencioso']);
    expect(args).not.toContain('--pasta');
  });
});
