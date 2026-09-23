import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Modelo Claude do ecossistema INEMA — fonte única em ~/.config/inema/modelos.env
 * (doc: ~/projetos/wifi/MODELOS.md). Ordem: variável de ambiente → arquivo central → reserva.
 */
const ARQUIVO_CENTRAL = join(homedir(), '.config', 'inema', 'modelos.env');

function lerCentral(chave: string): string | undefined {
  if (process.env[chave]) return process.env[chave];
  try {
    const m = readFileSync(ARQUIVO_CENTRAL, 'utf-8').match(new RegExp(`^${chave}=(.*)$`, 'm'));
    return m?.[1].trim() || undefined;
  } catch {
    return undefined;
  }
}

export const CLAUDE_TOPO = lerCentral('INEMA_CLAUDE_TOPO') ?? 'claude-opus-5-5';
export const CLAUDE_EFFORT = lerCentral('INEMA_CLAUDE_EFFORT') ?? 'low';
/** O Opus 5.5 exige CLI >= 2.1.280; `claude` solto no PATH pode cair no /usr/bin 2.1.63. */
export const CLAUDE_BIN = lerCentral('INEMA_CLAUDE_BIN') ?? 'claude';
