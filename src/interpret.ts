import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveDest, listDests } from './dests.js';
import type { Instruction } from './parser.js';
import type { SkillDef } from './skills.js';

const pExecFile = promisify(execFile);

export type ClaudeRunner = (prompt: string, extraArgs?: string[]) => Promise<string>;

/** `claude --model opus -p` (esforço médio = default da conta). */
export function defaultClaudeRunner(): ClaudeRunner {
  return async (prompt, extraArgs = []) => {
    const { stdout } = await pExecFile('claude', ['--model', 'opus', '-p', prompt, ...extraArgs],
      { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 });
    return stdout.trim();
  };
}

export function buildInterpretPrompt(text: string, defs: SkillDef[], dests: string[]): string {
  const skillList = defs.map((d) => `- ${d.command}: ${d.description} (ex.: ${d.example})`).join('\n');
  return [
    'Você traduz um pedido de criação de vídeo em jobs para uma fila. Responda APENAS com JSON, sem markdown.',
    'Skills registradas (as ÚNICAS permitidas):',
    skillList,
    `Destinos válidos (campo "dest", opcional): ${dests.join(', ') || '(nenhum)'}`,
    'Formato de cada item: {"skill": string, "input": string (assunto ou link), "vertical": boolean, "dest": string|null, "pesquisa": boolean, "narracao": boolean, "curso": string|null, "modulo": string|null}',
    '"curso" e "modulo", quando presentes, NÃO podem conter espaços (ex.: "t1m1", não "t1 m1").',
    '"pesquisa"=true somente se o pedido mandar pesquisar o assunto antes.',
    '"narracao"=true somente se o pedido pedir também o texto da narração/roteiro falado (ex.: "me retorne o vídeo e a narração em texto", "quero o texto também").',
    'IMPORTANTE — extraia TUDO que mapear para uma skill registrada: se o pedido tiver uma parte que mapeia (ex.: "faz um vídeo explicativo sobre X") e uma parte extra que não é um job de vídeo (ex.: "e me manda por e-mail"), gere o job da parte que mapeia e reporte a parte que não mapeia em "ignorado" — NÃO recuse o pedido inteiro por causa da parte extra.',
    'Responda no formato: {"jobs": [<itens como acima>], "ignorado": string|null} — "ignorado" é uma frase curta descrevendo o que você NÃO vai fazer (ou null se tudo foi atendido).',
    'Por compatibilidade, também é aceito responder só o array de itens (sem o envelope "jobs"/"ignorado").',
    'Reserve RECUSAR: para quando NADA no pedido mapear para nenhuma skill registrada (ex.: "jogue xadrez comigo"). Nesse caso, responda exatamente: RECUSAR: <motivo curto>',
    '',
    'Pedido:',
    text,
  ].join('\n');
}

export async function interpretFreeText(
  text: string, defs: SkillDef[], projetosDir: string, run: ClaudeRunner,
): Promise<{ ok: true; instrs: Instruction[]; ignorado?: string } | { ok: false; error: string }> {
  const out = await run(buildInterpretPrompt(text, defs, listDests(projetosDir)));
  if (out.startsWith('RECUSAR:')) return { ok: false, error: out.slice('RECUSAR:'.length).trim() };
  let items: any[];
  let ignorado: string | undefined;
  try {
    const jsonText = out.replace(/^```(json)?/m, '').replace(/```$/m, '').trim();
    const parsed = JSON.parse(jsonText);
    if (Array.isArray(parsed)) {
      items = parsed;
    } else if (parsed && Array.isArray(parsed.jobs)) {
      items = parsed.jobs;
      if (typeof parsed.ignorado === 'string' && parsed.ignorado.trim()) ignorado = parsed.ignorado.trim();
    } else {
      throw new Error('não é array nem envelope {jobs,ignorado}');
    }
  } catch {
    return { ok: false, error: `não entendi o pedido (resposta inválida do interpretador): ${out.slice(0, 200)}` };
  }
  const instrs: Instruction[] = [];
  for (const it of items) {
    if (!defs.some((d) => d.command === it.skill)) {
      return { ok: false, error: `skill "${it.skill}" não registrada — só sei: ${defs.map((d) => d.command).join(', ')}` };
    }
    if (!it.input || typeof it.input !== 'string') return { ok: false, error: 'item sem "input"' };
    let dest: string | null = null;
    let destToken: string | null = null;
    if (it.dest) {
      dest = resolveDest(String(it.dest), projetosDir);
      if (!dest) return { ok: false, error: `destino "${it.dest}" não existe — destinos válidos: ${listDests(projetosDir).join(', ') || '(nenhum)'}` };
      destToken = String(it.dest).toLowerCase();
    }
    let curso: string | undefined;
    let modulo: string | undefined;
    if (it.curso !== undefined && it.curso !== null) {
      curso = String(it.curso).trim();
      if (/\s/.test(curso)) return { ok: false, error: `curso "${curso}" não pode conter espaços — use uma forma sem espaço, ex.: skillsx` };
    }
    if (it.modulo !== undefined && it.modulo !== null) {
      modulo = String(it.modulo).trim();
      if (/\s/.test(modulo)) return { ok: false, error: `módulo "${modulo}" não pode conter espaços — use uma forma sem espaço, ex.: t1m1` };
    }
    instrs.push({
      skill: it.skill, input: it.input, vertical: Boolean(it.vertical),
      dest, destToken, pesquisa: Boolean(it.pesquisa), narracao: Boolean(it.narracao), curso, modulo,
    });
  }
  if (!instrs.length) return { ok: false, error: 'nenhum job identificado no pedido' };
  return ignorado ? { ok: true, instrs, ignorado } : { ok: true, instrs };
}
