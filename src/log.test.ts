import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLogger, truncate } from './log.js';

const base = join(tmpdir(), 'inemaccvbot-test-log');
const file = join(base, 'bot.log');

beforeEach(() => {
  rmSync(base, { recursive: true, force: true });
  mkdirSync(base, { recursive: true });
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('createLogger', () => {
  it('grava linhas com timestamp no arquivo', () => {
    const log = createLogger(file, 5_000_000);
    log.info('mensagem de teste');
    const content = readFileSync(file, 'utf8');
    expect(content).toContain('mensagem de teste');
    expect(content).toMatch(/\[INFO\]/);
  });

  it('rotaciona pra .1 quando passa do tamanho máximo, começando um arquivo novo', () => {
    const log = createLogger(file, 100);
    for (let i = 0; i < 20; i++) log.info(`linha ${i} preenchendo o arquivo até passar do limite de bytes`);
    expect(existsSync(`${file}.1`)).toBe(true);
    expect(existsSync(file)).toBe(true);
    const current = readFileSync(file, 'utf8');
    // arquivo atual não deve conter TODAS as 20 linhas (foi rotacionado no meio)
    expect(current.split('\n').filter(Boolean).length).toBeLessThan(20);
  });

  it('mantém só UM backup — nunca acumula .1, .2, .3...', () => {
    const log = createLogger(file, 50);
    for (let i = 0; i < 50; i++) log.info(`linha ${i} bem grande pra forçar várias rotações seguidas`);
    expect(existsSync(`${file}.1`)).toBe(true);
    expect(existsSync(`${file}.2`)).toBe(false);
  });

  it('nunca lança mesmo se o diretório do arquivo não existir', () => {
    const badFile = join(base, 'inexistente', 'sub', 'bot.log');
    const log = createLogger(badFile, 5_000_000);
    expect(() => log.info('não deveria quebrar')).not.toThrow();
    expect(() => log.error('nem isso')).not.toThrow();
  });
});

describe('truncate', () => {
  it('não mexe em strings curtas', () => {
    expect(truncate('oi', 500)).toBe('oi');
  });
  it('corta strings longas e adiciona reticências', () => {
    const long = 'a'.repeat(600);
    const t = truncate(long, 500);
    expect(t.length).toBe(501);
    expect(t.endsWith('…')).toBe(true);
  });
});
