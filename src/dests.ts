import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** 'lives3' → <projetosDir>/yt-pub-lives3/imports/videos (null se a pasta do projeto não existir). */
export function resolveDest(token: string, projetosDir: string): string | null {
  const m = token.trim().toLowerCase().match(/^lives(\d+)$/);
  if (!m) return null;
  const root = join(projetosDir, `yt-pub-lives${m[1]}`);
  if (!existsSync(root)) return null;
  return join(root, 'imports', 'videos');
}

/** Tokens válidos a partir das pastas yt-pub-lives<N> existentes, ordem numérica. */
export function listDests(projetosDir: string): string[] {
  let entries: string[] = [];
  try { entries = readdirSync(projetosDir); } catch { return []; }
  return entries
    .map((e) => e.match(/^yt-pub-lives(\d+)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b)
    .map((n) => `lives${n}`);
}
