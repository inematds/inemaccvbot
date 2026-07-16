import { appendFileSync, existsSync, renameSync, statSync } from 'node:fs';

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

/** Trunca linhas grandes (ex.: mensagens de usuário) antes de logar. */
export function truncate(s: string, max = 500): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Rotaciona `file` -> `file.1` (substituindo o `.1` anterior) se `file` passar de `maxBytes`.
 * Mantém no máximo UM backup — nunca mais que ~2× maxBytes em disco. */
function rotateIfNeeded(file: string, maxBytes: number): void {
  if (!existsSync(file)) return;
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return;
  }
  if (size <= maxBytes) return;
  try {
    renameSync(file, `${file}.1`);
  } catch {
    // se o rename falhar (ex.: permissão), segue tentando anexar no arquivo atual
  }
}

/** Logger que escreve em `file` (com rotação) e ainda em stdout/stderr (journalctl continua funcionando).
 * Nunca lança — se o log em disco falhar (disco cheio, permissão), engole o erro e segue rodando o bot. */
export function createLogger(file: string, maxBytes: number): Logger {
  const write = (level: 'INFO' | 'WARN' | 'ERROR', msg: string): void => {
    const line = `${new Date().toISOString()} [${level}] ${msg}`;
    if (level === 'ERROR' || level === 'WARN') console.error(line);
    else console.log(line);
    try {
      rotateIfNeeded(file, maxBytes);
      appendFileSync(file, `${line}\n`);
    } catch {
      // swallow — logging nunca derruba o bot
    }
  };
  return {
    info: (msg) => write('INFO', msg),
    warn: (msg) => write('WARN', msg),
    error: (msg) => write('ERROR', msg),
  };
}

/** Fallback pra quando nenhum Logger foi injetado (ex.: testes) — só console, sem arquivo. */
export function consoleLogger(): Logger {
  return {
    info: (msg) => console.log(msg),
    warn: (msg) => console.warn(msg),
    error: (msg) => console.error(msg),
  };
}
