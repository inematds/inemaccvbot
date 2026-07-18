import { existsSync } from 'node:fs';
import { resolveDest, listDests } from './dests.js';

export interface Instruction {
  skill: string;
  input: string;
  vertical: boolean;
  dest: string | null;
  destToken: string | null;
  pesquisa: boolean;
  narracao: boolean;
  transcrever: boolean;
  curso?: string;
  modulo?: string;
  /** Só relevante pra skill `reel`: destino (livesN) é CÓPIA por default, `mover`=true move em vez
   * de copiar (ver watcher.ts). Ignorado por qualquer outra skill (que sempre move via --pasta). */
  mover?: boolean;
  /** Só relevante pra skill `reel`: usa o Modo 3 (visuais) da skill reel-edita-inema em vez do
   * explicador default (Modo 2). */
  visuais?: boolean;
  /** Só relevante pra skill `reel`: descrição livre em linguagem natural que veio junto com o
   * caminho do avatar (ex.: "reel: /p/a.mp4 quero um resumo animado") e não mapeou pra nenhuma
   * flag conhecida (visuais/mover/livesN) — anexada como contexto extra ao job em `submit()`. */
  reelDescricao?: string;
}

export type LineResult =
  | { kind: 'instr'; instr: Instruction }
  | { kind: 'free'; line: string }
  | { kind: 'error'; line: string; message: string };

/** Formato: `<skill>: <assunto/link> [| campo]*` — campos: 9:16|vertical, pesquisa, narracao, transcrever, livesN, modulo X, curso X. */
export function parseLine(line: string, skills: string[], projetosDir: string): LineResult {
  const trimmed = line.trim();
  const m = trimmed.match(/^([a-zA-Z0-9çãõéíóú-]+)\s*:\s*(.*)$/);
  if (!m) return { kind: 'free', line: trimmed };
  const skill = m[1].toLowerCase();
  if (!skills.includes(skill)) return { kind: 'free', line: trimmed };

  // O assunto é o primeiro segmento, tomado POSICIONALMENTE (antes de filtrar
  // vazios) — senão um assunto vazio "some" e o próximo campo vira o assunto.
  const rawFields = m[2].split('|').map((s) => s.trim());
  let input = rawFields.shift() ?? '';
  if (!input) return { kind: 'error', line: trimmed, message: 'faltou o assunto/link depois do ":"' };
  const fields = rawFields.filter(Boolean);

  // `reel`/`reelinematds`: o "input" é um CAMINHO de MP4 (avatar HeyGen / bruto vertical), não um
  // assunto/link — mas o usuário frequentemente digita o caminho seguido de uma descrição livre na
  // mesma frase (sem usar "|"), ex.: "reel: /p/a.mp4 quero com texto e imagem ilustrativa".
  // Separamos o PRIMEIRO token que parece caminho (começa com "/" ou "~") do resto: em `reel` isso
  // vira descrição mapeada pra "visuais" quando pede imagem/ilustração (modo 3 da reel-edita-inema)
  // ou contexto extra; em `reelinematds` (skill sem modos) o resto sempre vira contexto extra —
  // a skill reel-edita-inematds decide sozinha o tratamento, só recebe a instrução verbatim.
  let reelDescricao: string | undefined;
  let reelVisuaisFromDesc = false;
  if (skill === 'reel' || skill === 'reelinematds') {
    const pathSplit = input.match(/^(\S+)(?:\s+([\s\S]*))?$/);
    const token = pathSplit ? pathSplit[1] : '';
    const rest = (pathSplit?.[2] ?? '').trim();
    if (!token.startsWith('/') && !token.startsWith('~')) {
      return {
        kind: 'error', line: trimmed,
        message: `${skill} precisa do caminho do arquivo do vídeo (ex.: "${skill}: /home/user/video.mp4") — não encontrei um caminho válido em "${input}"`,
      };
    }
    input = token;
    if (rest && skill === 'reel') {
      const restLower = rest.toLowerCase();
      const wantsVisual = /(imagem|ilustrativ|visuais|visual)/.test(restLower);
      const wantsExplainer = /(explicativ|narrad|explicador)/.test(restLower);
      if (wantsVisual && !wantsExplainer) {
        reelVisuaisFromDesc = true;
      } else {
        reelDescricao = rest.replace(/\n/g, ' ').replace(/--+/g, '-').trim();
      }
    } else if (rest) {
      reelDescricao = rest.replace(/\n/g, ' ').replace(/--+/g, '-').trim();
    }
  }

  const instr: Instruction = { skill, input, vertical: false, dest: null, destToken: null, pesquisa: false, narracao: false, transcrever: false };
  if (reelVisuaisFromDesc) instr.visuais = true;
  if (reelDescricao) instr.reelDescricao = reelDescricao;
  for (const f of fields) {
    const lower = f.toLowerCase();
    if (lower === '9:16' || lower === 'vertical') { instr.vertical = true; continue; }
    if (lower === '16:9' || lower === 'horizontal') { instr.vertical = false; continue; }
    if (lower === 'pesquisa' || lower === 'pesquisar') { instr.pesquisa = true; continue; }
    if (lower === 'narracao' || lower === 'narração' || lower === 'texto') { instr.narracao = true; continue; }
    if (lower === 'transcrever' || lower === 'transcricao' || lower === 'transcrição') { instr.transcrever = true; continue; }
    if (lower === 'mover') { instr.mover = true; continue; }
    if (lower === 'visuais') { instr.visuais = true; continue; }
    const mod = f.match(/^modulo\s+(.+)$/i);
    if (mod) {
      const value = mod[1].trim();
      if (/\s/.test(value)) return { kind: 'error', line: trimmed, message: `módulo "${value}" não pode conter espaços — use uma forma sem espaço, ex.: t1m1` };
      instr.modulo = value;
      continue;
    }
    const cur = f.match(/^curso\s+(.+)$/i);
    if (cur) {
      const value = cur[1].trim();
      if (/\s/.test(value)) return { kind: 'error', line: trimmed, message: `curso "${value}" não pode conter espaços — use uma forma sem espaço, ex.: skillsx` };
      instr.curso = value;
      continue;
    }
    if (/^lives\d+$/i.test(lower)) {
      const dest = resolveDest(lower, projetosDir);
      if (!dest) return { kind: 'error', line: trimmed, message: `destino "${lower}" não existe (pasta yt-pub-${lower} não encontrada) — destinos válidos: ${listDests(projetosDir).join(', ') || '(nenhum)'}` };
      instr.dest = dest;
      instr.destToken = lower;
      continue;
    }
    return { kind: 'error', line: trimmed, message: `campo desconhecido: "${f}"` };
  }
  // `reel`/`reelinematds`: o "input" é um CAMINHO de MP4, não um assunto/link — confere no disco
  // antes de enfileirar (a forma anexo já chega com o caminho baixado, então sempre existe).
  if ((skill === 'reel' || skill === 'reelinematds') && !existsSync(instr.input)) {
    return { kind: 'error', line: trimmed, message: `arquivo não encontrado: "${instr.input}" — confira o caminho` };
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
