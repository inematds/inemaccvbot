import { resolveDest } from './dests.js';

export interface Instruction {
  skill: string;
  input: string;
  vertical: boolean;
  dest: string | null;
  destToken: string | null;
  pesquisa: boolean;
  curso?: string;
  modulo?: string;
}

export type LineResult =
  | { kind: 'instr'; instr: Instruction }
  | { kind: 'free'; line: string }
  | { kind: 'error'; line: string; message: string };

/** Formato: `<skill>: <assunto/link> [| campo]*` — campos: 9:16|vertical, pesquisa, livesN, modulo X, curso X. */
export function parseLine(line: string, skills: string[], projetosDir: string): LineResult {
  const trimmed = line.trim();
  const m = trimmed.match(/^([a-zA-Zçãõéíóú-]+)\s*:\s*(.+)$/);
  if (!m) return { kind: 'free', line: trimmed };
  const skill = m[1].toLowerCase();
  if (!skills.includes(skill)) return { kind: 'free', line: trimmed };

  const fields = m[2].split('|').map((s) => s.trim()).filter(Boolean);
  const input = fields.shift() ?? '';
  if (!input) return { kind: 'error', line: trimmed, message: 'faltou o assunto/link depois do ":"' };

  const instr: Instruction = { skill, input, vertical: false, dest: null, destToken: null, pesquisa: false };
  for (const f of fields) {
    const lower = f.toLowerCase();
    if (lower === '9:16' || lower === 'vertical') { instr.vertical = true; continue; }
    if (lower === '16:9' || lower === 'horizontal') { instr.vertical = false; continue; }
    if (lower === 'pesquisa' || lower === 'pesquisar') { instr.pesquisa = true; continue; }
    const mod = f.match(/^modulo\s+(.+)$/i);
    if (mod) { instr.modulo = mod[1].trim(); continue; }
    const cur = f.match(/^curso\s+(.+)$/i);
    if (cur) { instr.curso = cur[1].trim(); continue; }
    if (/^lives\d+$/i.test(lower)) {
      const dest = resolveDest(lower, projetosDir);
      if (!dest) return { kind: 'error', line: trimmed, message: `destino "${lower}" não existe (pasta yt-pub-${lower} não encontrada)` };
      instr.dest = dest;
      instr.destToken = lower;
      continue;
    }
    return { kind: 'error', line: trimmed, message: `campo desconhecido: "${f}"` };
  }
  return { kind: 'instr', instr };
}

/** Uma instrução por linha; linhas vazias ignoradas. */
export function parseMessage(text: string, skills: string[], projetosDir: string): LineResult[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => parseLine(l, skills, projetosDir));
}
