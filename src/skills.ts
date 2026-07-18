import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Instruction } from './parser.js';

export interface SkillDef { command: string; mkiSkill: string; queue: 'video' | 'texto'; description: string; example: string }

const DEFAULT_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'config', 'skills.json');

export function loadSkills(path: string = DEFAULT_PATH): SkillDef[] {
  return JSON.parse(readFileSync(path, 'utf8')) as SkillDef[];
}

export function skillCommands(defs: SkillDef[]): string[] {
  return defs.map((d) => d.command);
}

/** Instrução validada → args do CLI mkivideos. Notificação é do bot (watcher), então sempre --silencioso. */
export function buildAddArgs(instr: Instruction, defs: SkillDef[]): string[] {
  const def = defs.find((d) => d.command === instr.skill);
  if (!def) throw new Error(`skill não registrada: ${instr.skill}`);
  const args = ['add', def.mkiSkill, instr.input, '--silencioso'];
  if (instr.vertical) args.push('--vertical');
  // `reel`/`reelinematds` são CÓPIA por default (as skills reel-edita-inema/reel-edita-inematds
  // escrevem em ~/projetos/output/.../<slug>/ e o WATCHER do bot copia/move o resultado pra
  // livesN depois de done — nunca `--pasta`, que faria o daemon MOVER direto e perder o
  // original). Todas as outras skills seguem movendo via --pasta.
  if (instr.dest && instr.skill !== 'reel' && instr.skill !== 'reelinematds') args.push('--pasta', instr.dest);
  if (instr.curso) args.push('--curso', instr.curso);
  if (instr.modulo) args.push('--modulo', instr.modulo);
  return args;
}
