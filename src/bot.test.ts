import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { submit, type BotDeps } from './bot.js';
import { StateStore } from './state.js';
import type { Config } from './config.js';
import type { Instruction } from './parser.js';
import type { SkillDef } from './skills.js';

const DEFS: SkillDef[] = [
  { command: 'explicativo', mkiSkill: 'explicativo', description: 'vídeo explicativo', example: 'explicativo: X' },
];

const narracoesDir = join(tmpdir(), 'inemaccvbot-test-narracoes');
const cfg = { projetosDir: '/tmp', narracoesDir } as Config;

beforeEach(() => rmSync(narracoesDir, { recursive: true, force: true }));
afterEach(() => rmSync(narracoesDir, { recursive: true, force: true }));

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
  skill: 'explicativo', input: 'IA na saúde', vertical: false, dest: null, destToken: null, pesquisa: false, narracao: false,
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

  it('narracao=true anexa instrução com caminho absoluto sem espaço, sem quebra de linha e sem token "--"', async () => {
    const addedArgs: string[][] = [];
    const deps = makeDeps(addedArgs);
    await submit({ ...baseInstr, narracao: true }, 1, cfg, deps);
    const jobInput = addedArgs[0][2];
    expect(jobInput).toContain('IA na saúde');
    expect(jobInput.toLowerCase()).toContain('narração');
    expect(jobInput).not.toMatch(/\n/);
    expect(jobInput.split(/\s+/).some((tok) => tok.startsWith('--'))).toBe(false);
    const match = jobInput.match(/"([^"]+)"/);
    expect(match).not.toBeNull();
    const path = match![1];
    expect(path).not.toMatch(/\s/);
    expect(path.startsWith(narracoesDir)).toBe(true);
    expect(path.endsWith('.txt')).toBe(true);
    expect(existsSync(narracoesDir)).toBe(true); // mkdirSync criou o diretório
  });

  it('narracao=true grava o caminho da narração no state', async () => {
    const addedArgs: string[][] = [];
    const deps = makeDeps(addedArgs);
    await submit({ ...baseInstr, narracao: true }, 1, cfg, deps);
    const tracked = deps.state.get(1);
    expect(tracked?.narracaoPath).toBeTruthy();
    expect(tracked!.narracaoPath!.startsWith(narracoesDir)).toBe(true);
  });

  it('narracao=false não grava caminho de narração no state', async () => {
    const addedArgs: string[][] = [];
    const deps = makeDeps(addedArgs);
    await submit({ ...baseInstr, narracao: false }, 1, cfg, deps);
    expect(deps.state.get(1)?.narracaoPath).toBeNull();
  });

  it('NARRACOES_DIR com espaço falha o submit em vez de corromper o job', async () => {
    const addedArgs: string[][] = [];
    const deps = makeDeps(addedArgs);
    const badCfg = { ...cfg, narracoesDir: '/tmp/dir com espaco' } as Config;
    const result = await submit({ ...baseInstr, narracao: true }, 1, badCfg, deps);
    expect(result).toContain('❌');
    expect(addedArgs).toHaveLength(0);
  });
});
