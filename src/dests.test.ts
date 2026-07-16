import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveDest, listDests } from './dests.js';

const base = join(tmpdir(), 'inemaccvbot-test-dests');

beforeAll(() => {
  rmSync(base, { recursive: true, force: true });
  for (const n of [1, 2, 10]) mkdirSync(join(base, `yt-pub-lives${n}`), { recursive: true });
  mkdirSync(join(base, 'yt-pub-livesx'), { recursive: true }); // não numérico: ignorar
});

describe('resolveDest', () => {
  it('mapeia livesN para imports/videos dentro do projeto', () => {
    expect(resolveDest('lives2', base)).toBe(join(base, 'yt-pub-lives2', 'imports', 'videos'));
  });
  it('aceita maiúsculas/espaços', () => {
    expect(resolveDest(' Lives10 ', base)).toBe(join(base, 'yt-pub-lives10', 'imports', 'videos'));
  });
  it('recusa lives inexistente', () => {
    expect(resolveDest('lives99', base)).toBeNull();
  });
  it('recusa token que não é livesN', () => {
    expect(resolveDest('qualquercoisa', base)).toBeNull();
  });
});

describe('listDests', () => {
  it('lista tokens numéricos ordenados', () => {
    expect(listDests(base)).toEqual(['lives1', 'lives2', 'lives10']);
  });
});
