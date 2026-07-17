import { describe, it, expect } from 'vitest';
import { loadSkills, skillCommands, buildAddArgs, type SkillDef } from './skills.js';
import type { Instruction } from './parser.js';

const DEFS: SkillDef[] = [
  { command: 'explicativo', mkiSkill: 'explicativo', description: 'x', example: 'x' },
  { command: 'curso', mkiSkill: 'curso', description: 'x', example: 'x' },
];

const base: Instruction = { skill: 'explicativo', input: 'O que é RAG', vertical: false, dest: null, destToken: null, pesquisa: false, narracao: false, transcrever: false };

describe('loadSkills', () => {
  it('carrega o registro do config/skills.json', () => {
    const defs = loadSkills();
    expect(skillCommands(defs)).toEqual(['explicativo', 'curso', 'demo']);
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
});
