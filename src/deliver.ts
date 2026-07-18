import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { basename, extname, join, resolve, sep } from 'node:path';

export interface PublishResult {
  /** URL completa (baseUrl + '/' + nome codificado). */
  url: string;
  /** Caminho absoluto do arquivo dentro de `entregasDir`. */
  publicPath: string;
}

/** Remove tudo que não seja seguro num nome de arquivo público: sem separadores de caminho, sem
 * "..", sem espaços/unicode problemático — evita tanto path traversal quanto URLs quebradas. */
function sanitizeName(name: string): string {
  const base = basename(name); // descarta qualquer diretório embutido (../, /etc/passwd etc.)
  const ext = extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  const cleanStem = stem
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '') // acentos
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 150);
  const cleanExt = ext.replace(/[^a-zA-Z0-9.]+/g, '').slice(0, 20);
  return (cleanStem || 'arquivo') + cleanExt;
}

/** Compara conteúdo por tamanho + mtime — suficiente pra decidir "é o mesmo arquivo que já publiquei
 * antes" sem ler o arquivo inteiro (podem ser vídeos grandes). */
function looksIdentical(a: string, b: string): boolean {
  try {
    const sa = statSync(a);
    const sb = statSync(b);
    return sa.size === sb.size;
  } catch {
    return false;
  }
}

/**
 * Copia `srcPath` para dentro de `entregasDir` com um nome sanitizado e sem colisão, e devolve a
 * URL pública (baseUrl + nome codificado) e o caminho no disco. Nunca escreve fora de
 * `entregasDir`. Se já existir um arquivo com o mesmo nome sanitizado:
 *  - se parecer idêntico (mesmo tamanho), reusa — não copia de novo, não perde o slot;
 *  - senão, sufixa com um contador até achar um nome livre.
 */
export function publishForDownload(srcPath: string, entregasDir: string, baseUrl: string): PublishResult {
  const entregasAbs = resolve(entregasDir);
  mkdirSync(entregasAbs, { recursive: true });

  const sanitized = sanitizeName(basename(srcPath));
  const ext = extname(sanitized);
  const stem = ext ? sanitized.slice(0, -ext.length) : sanitized;

  let candidate = sanitized;
  let n = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const destPath = resolve(entregasAbs, candidate);
    // Garantia extra contra traversal: o destino tem que ficar estritamente dentro de entregasAbs.
    if (destPath !== entregasAbs && !destPath.startsWith(entregasAbs + sep)) {
      throw new Error('nome de arquivo inválido: escaparia do diretório de entregas');
    }
    if (!existsSync(destPath)) {
      copyFileSync(srcPath, destPath);
      return { url: `${baseUrl.replace(/\/+$/, '')}/${encodeURIComponent(candidate)}`, publicPath: destPath };
    }
    if (looksIdentical(srcPath, destPath)) {
      return { url: `${baseUrl.replace(/\/+$/, '')}/${encodeURIComponent(candidate)}`, publicPath: destPath };
    }
    n += 1;
    candidate = `${stem}-${n}${ext}`;
  }
}
