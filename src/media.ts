import { createWriteStream, mkdirSync } from 'node:fs';
import { get } from 'node:https';
import { basename, extname, join } from 'node:path';

/** Baixa um documento do Telegram (por `fileId`) e devolve o caminho local. Assinatura enxuta
 * (sem `ctx`) pra poder ser fakeada nos testes — nenhum teste deste bot bate na API real do
 * Telegram. */
export type DocumentDownloader = (fileId: string, originalFilename: string) => Promise<string>;

/** Nome de arquivo original (do Telegram) → nome seguro pra guardar em `ANEXOS_DIR`.
 * Restrições (o caminho final vira parte do `input` do job, que o CLI do mkivideos re-splita em
 * argv por espaço em branco):
 *  - `basename()` primeiro — mata qualquer path traversal (`../../etc/passwd` → `passwd`).
 *  - SEM espaço em branco (troca por `-`).
 *  - SEM token começando com "--" (traços de sobra no começo são removidos).
 *  - mantém a extensão original (normalizada, minúscula). */
export function sanitizeAnexoFilename(original: string): string {
  const safeBase = basename(String(original ?? '').trim()) || 'arquivo';
  const ext = extname(safeBase).toLowerCase().replace(/[^a-z0-9.]/g, '');
  const stemRaw = ext ? safeBase.slice(0, safeBase.length - extname(safeBase).length) : safeBase;
  let stem = stemRaw
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // remove acentos
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  if (!stem) stem = 'arquivo';
  return `${stem}${ext}`;
}

/** Nome final em `ANEXOS_DIR`: timestamp + nome sanitizado (evita colisão, sem espaço). */
export function anexoFilename(original: string, now: number = Date.now()): string {
  return `${now}-${sanitizeAnexoFilename(original)}`;
}

function httpGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    get(url, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        res.resume();
        reject(new Error(`falha ao contatar a API do Telegram (HTTP ${res.statusCode})`));
        return;
      }
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve(data));
      res.on('error', reject);
    }).on('error', () => reject(new Error('falha de rede ao contatar a API do Telegram')));
  });
}

function downloadToFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);
    get(url, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        res.resume();
        file.close();
        reject(new Error(`falha ao baixar o arquivo (HTTP ${res.statusCode})`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
      file.on('error', reject);
    }).on('error', () => { file.close(); reject(new Error('falha de rede ao baixar o arquivo')); });
  });
}

/** Downloader real, usado em produção (`index.ts`). Nunca loga nem expõe o token — os erros
 * lançados aqui não incluem a URL (que contém o token no path `/bot<token>/...`). */
export function makeDocumentDownloader(botToken: string, anexosDir: string): DocumentDownloader {
  return async (fileId, originalFilename) => {
    mkdirSync(anexosDir, { recursive: true });
    const infoUrl = `https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`;
    const body = await httpGet(infoUrl);
    let parsed: { ok?: boolean; result?: { file_path?: string } };
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new Error('resposta inválida da API do Telegram ao buscar o arquivo');
    }
    if (!parsed.ok || !parsed.result?.file_path) {
      throw new Error('não consegui localizar o arquivo no Telegram');
    }
    const dest = join(anexosDir, anexoFilename(originalFilename));
    const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${parsed.result.file_path}`;
    await downloadToFile(downloadUrl, dest);
    return dest;
  };
}
