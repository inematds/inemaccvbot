import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { publishForDownload } from './deliver.js';

const srcDir = join(tmpdir(), 'inemaccvbot-test-deliver-src');
const entregasDir = join(tmpdir(), 'inemaccvbot-test-deliver-entregas');

beforeEach(() => {
  rmSync(srcDir, { recursive: true, force: true });
  rmSync(entregasDir, { recursive: true, force: true });
  mkdirSync(srcDir, { recursive: true });
});
afterEach(() => {
  rmSync(srcDir, { recursive: true, force: true });
  rmSync(entregasDir, { recursive: true, force: true });
});

describe('publishForDownload', () => {
  it('copia o arquivo pra entregasDir e devolve URL com nome codificado', () => {
    const src = join(srcDir, 'video-final.mp4');
    writeFileSync(src, 'conteudo de teste');
    const { url, publicPath } = publishForDownload(src, entregasDir, 'http://192.168.2.99:8199');
    expect(existsSync(publicPath)).toBe(true);
    expect(readFileSync(publicPath, 'utf8')).toBe('conteudo de teste');
    expect(url).toBe('http://192.168.2.99:8199/video-final.mp4');
    expect(publicPath.startsWith(entregasDir)).toBe(true);
  });

  it('sanitiza nomes com espaço, ".." e unicode — sem escapar de entregasDir', () => {
    const src = join(srcDir, 'meu vídeo ção ../../etc.mp4');
    mkdirSync(join(srcDir), { recursive: true });
    writeFileSync(src, 'x');
    const { url, publicPath } = publishForDownload(src, entregasDir, 'http://192.168.2.99:8199');
    // caminho publicado tem que ficar estritamente dentro de entregasDir
    expect(publicPath.startsWith(entregasDir)).toBe(true);
    expect(publicPath).not.toContain('..');
    expect(existsSync(publicPath)).toBe(true);
    // URL não pode conter espaço cru nem ".."
    expect(url).not.toMatch(/ /);
    expect(url).not.toContain('..');
    expect(url.startsWith('http://192.168.2.99:8199/')).toBe(true);
  });

  it('não colide nomes iguais de arquivos diferentes — sufixa em vez de sobrescrever', () => {
    const srcA = join(srcDir, 'a.mp4');
    const srcB = join(srcDir, 'b', 'a.mp4');
    mkdirSync(join(srcDir, 'b'), { recursive: true });
    writeFileSync(srcA, '1234567890'); // 10 bytes
    writeFileSync(srcB, '12345'); // 5 bytes (tamanho diferente => não "parece idêntico")
    const first = publishForDownload(srcA, entregasDir, 'http://x');
    const second = publishForDownload(srcB, entregasDir, 'http://x');
    expect(first.publicPath).not.toBe(second.publicPath);
    expect(existsSync(first.publicPath)).toBe(true);
    expect(existsSync(second.publicPath)).toBe(true);
  });

  it('republicar o mesmo arquivo (mesmo tamanho) reusa o slot em vez de sufixar', () => {
    const src = join(srcDir, 'igual.mp4');
    writeFileSync(src, 'conteudo fixo');
    const first = publishForDownload(src, entregasDir, 'http://x');
    const second = publishForDownload(src, entregasDir, 'http://x');
    expect(first.publicPath).toBe(second.publicPath);
    expect(first.url).toBe(second.url);
  });
});
