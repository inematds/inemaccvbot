import { describe, it, expect } from 'vitest';
import { sanitizeAnexoFilename, anexoFilename } from './media.js';

describe('sanitizeAnexoFilename', () => {
  it('remove espaço em branco', () => {
    expect(sanitizeAnexoFilename('meu arquivo legal.md')).not.toMatch(/\s/);
  });

  it('remove acentos', () => {
    const out = sanitizeAnexoFilename('anotação de vídeo.md');
    expect(out).not.toMatch(/[áàãéíóõúç]/i);
  });

  it('mata path traversal — usa só o basename', () => {
    const out = sanitizeAnexoFilename('../../etc/passwd');
    expect(out).not.toContain('/');
    expect(out).not.toContain('..');
    expect(out).toBe('passwd');
  });

  it('não deixa o nome começar com "--" (token de flag pro CLI do mkivideos)', () => {
    const out = sanitizeAnexoFilename('--flag.md');
    expect(out.startsWith('--')).toBe(false);
    expect(out.startsWith('-')).toBe(false);
  });

  it('mantém a extensão original em minúsculo', () => {
    expect(sanitizeAnexoFilename('Relatorio.MD')).toMatch(/\.md$/);
  });

  it('nunca devolve string vazia — cai pra "arquivo" se sobrar nada', () => {
    expect(sanitizeAnexoFilename('   ')).toBeTruthy();
    expect(sanitizeAnexoFilename('---...')).toBeTruthy();
  });

  it('combinação nasty: espaço + acento + "--" + path traversal', () => {
    const out = sanitizeAnexoFilename('../../etc/-- anotação difícil.md');
    expect(out).not.toMatch(/\s/);
    expect(out.startsWith('-')).toBe(false);
    expect(out).not.toContain('/');
    expect(out).not.toContain('..');
    expect(out).toMatch(/\.md$/);
  });
});

describe('anexoFilename', () => {
  it('prefixa com timestamp e não tem espaço', () => {
    const out = anexoFilename('meu arquivo --flag ../../etc/passwd.md', 1234567890);
    expect(out.startsWith('1234567890-')).toBe(true);
    expect(out).not.toMatch(/\s/);
    expect(out.split(/\s+/).every((tok) => !tok.startsWith('--'))).toBe(true);
  });

  it('dois arquivos com o mesmo nome original geram nomes diferentes em timestamps diferentes', () => {
    const a = anexoFilename('nota.md', 1);
    const b = anexoFilename('nota.md', 2);
    expect(a).not.toBe(b);
  });
});
