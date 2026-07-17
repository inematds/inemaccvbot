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
    expect(skillCommands(defs)).toEqual(['explicativo', 'curso', 'demo', 'transcrever', 'dublar']);
    for (const d of defs) expect(['video', 'texto']).toContain(d.queue);
  });
  it('explicativo/curso/demo são da fila de vídeo; transcrever/dublar da fila de texto', () => {
    const defs = loadSkills();
    const byCommand = Object.fromEntries(defs.map((d) => [d.command, d.queue]));
    expect(byCommand.explicativo).toBe('video');
    expect(byCommand.curso).toBe('video');
    expect(byCommand.demo).toBe('video');
    expect(byCommand.transcrever).toBe('texto');
    expect(byCommand.dublar).toBe('texto');
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
