import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveDest, listDests } from './dests.js';
import type { Instruction } from './parser.js';
import type { SkillDef } from './skills.js';

const pExecFile = promisify(execFile);

export type ClaudeRunner = (prompt: string, extraArgs?: string[]) => Promise<string>;

/** `claude --model opus -p` (esforço médio = default da conta). */
export function defaultClaudeRunner(): ClaudeRunner {
  return async (prompt, extraArgs = []) => {
    const { stdout } = await pExecFile('claude', ['--model', 'opus', '-p', prompt, ...extraArgs],
      { timeout: 600_000, maxBuffer: 10 * 1024 * 1024 });
    return stdout.trim();
  };
}

export function buildInterpretPrompt(text: string, defs: SkillDef[], dests: string[]): string {
  const skillList = defs.map((d) => `- ${d.command}: ${d.description} (ex.: ${d.example})`).join('\n');
  return [
    'Você traduz um pedido de criação de vídeo em jobs para uma fila. Responda APENAS com JSON (array), sem markdown.',
    'Skills registradas (as ÚNICAS permitidas):',
    skillList,
    `Destinos válidos (campo "dest", opcional): ${dests.join(', ') || '(nenhum)'}`,
    'Formato de cada item: {"skill": string, "input": string (assunto ou link), "vertical": boolean, "dest": string|null, "pesquisa": boolean}',
    '"pesquisa"=true somente se o pedido mandar pesquisar o assunto antes.',
    'Se o pedido NÃO mapear para nenhuma skill registrada, responda exatamente: RECUSAR: <motivo curto>',
    '',
    'Pedido:',
    text,
  ].join('\n');
}

export function buildResearchPrompt(assunto: string): string {
  return [
    `Pesquise na web sobre: ${assunto}`,
    'Produza um briefing em markdown para roteirizar um vídeo: fatos verificados com datas, números-chave,',
    '3-5 ângulos interessantes, erros comuns sobre o tema, e as fontes (URLs). Máximo ~600 palavras.',
    'Responda APENAS com o markdown do briefing.',
  ].join('\n');
}

export async function interpretFreeText(
  text: string, defs: SkillDef[], projetosDir: string, run: ClaudeRunner,
): Promise<{ ok: true; instrs: Instruction[] } | { ok: false; error: string }> {
  const out = await run(buildInterpretPrompt(text, defs, listDests(projetosDir)));
  if (out.startsWith('RECUSAR:')) return { ok: false, error: out.slice('RECUSAR:'.length).trim() };
  let items: any[];
  try {
    const jsonText = out.replace(/^```(json)?/m, '').replace(/```$/m, '').trim();
    items = JSON.parse(jsonText);
    if (!Array.isArray(items)) throw new Error('não é array');
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
      if (!dest) return { ok: false, error: `destino "${it.dest}" não existe` };
      destToken = String(it.dest).toLowerCase();
    }
    instrs.push({
      skill: it.skill, input: it.input, vertical: Boolean(it.vertical),
      dest, destToken, pesquisa: Boolean(it.pesquisa),
    });
  }
  if (!instrs.length) return { ok: false, error: 'nenhum job identificado no pedido' };
  return { ok: true, instrs };
}

/** Pesquisa web via claude -p com WebSearch; salva briefing e devolve o caminho. */
export async function researchBriefing(assunto: string, briefingsDir: string, run: ClaudeRunner): Promise<string> {
  mkdirSync(briefingsDir, { recursive: true });
  const md = await run(buildResearchPrompt(assunto), ['--allowedTools', 'WebSearch,WebFetch']);
  const slug = assunto.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'briefing';
  const path = join(briefingsDir, `${Date.now()}-${slug}.md`);
  writeFileSync(path, md, 'utf8');
  return path;
}
