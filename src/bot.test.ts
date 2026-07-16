import { describe, it, expect } from 'vitest';
import { submit, type BotDeps } from './bot.js';
import { StateStore } from './state.js';
import type { Config } from './config.js';
import type { Instruction } from './parser.js';
import type { SkillDef } from './skills.js';

const DEFS: SkillDef[] = [
  { command: 'explicativo', mkiSkill: 'explicativo', description: 'vídeo explicativo', example: 'explicativo: X' },
];

const cfg = { projetosDir: '/tmp' } as Config;

function makeDeps(addedArgs: string[][]): BotDeps {
  return {
    client: { add: async (args: string[]) => { addedArgs.push(args); return 1; } } as any,
    state: new StateStore(':memory:'),
    defs: DEFS,
    interpret: (async () => ({ ok: false, error: 'n/a' })) as any,
    claude: (async () => '') as any,
  };
}

const baseInstr: Instruction = {
  skill: 'explicativo', input: 'IA na saúde', vertical: false, dest: null, destToken: null, pesquisa: false,
};

describe('submit', () => {
  it('anexa a instrução de pesquisa ao input do job quando pesquisa=true', async () => {
    const addedArgs: string[][] = [];
    const deps = makeDeps(addedArgs);
    await submit({ ...baseInstr, pesquisa: true }, 1, cfg, deps);
    const jobInput = addedArgs[0][2]; // ['add', mkiSkill, input, ...]
    expect(jobInput).toContain('IA na saúde');
    expect(jobInput.toLowerCase()).toContain('pesquise');
    expect(jobInput).not.toMatch(/\n/);
    expect(jobInput.split(/\s+/).some((tok) => tok.startsWith('--'))).toBe(false);
  });

  it('não anexa nada ao input quando pesquisa=false', async () => {
    const addedArgs: string[][] = [];
    const deps = makeDeps(addedArgs);
    await submit({ ...baseInstr, pesquisa: false }, 1, cfg, deps);
    const jobInput = addedArgs[0][2];
    expect(jobInput).toBe('IA na saúde');
  });
});
