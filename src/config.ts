import 'dotenv/config';

export interface Config {
  botToken: string;
  allowedChatIds: number[];
  mkiDir: string;
  // Fila de vídeo (mkivideos.service — explicativo/curso/demo, render ~15min).
  mkiDb: string;
  dashUrl: string;
  // Fila de texto (mkitexto.service — transcrever/dublar via inemavox, minutos). Mesmo binário
  // (mkiDir) e mesmo token (dashToken); só o DB e o dashboard são outros.
  mkiTextoDb: string;
  mkiTextoDash: string;
  dashToken: string;
  pollIntervalMs: number;
  stateDb: string;
  projetosDir: string;
  narracoesDir: string;
  anexosDir: string;
  logFile: string;
  logMaxBytes: number;
  /** Base URL do servidor HTTP de entregas (systemd user service `inema-entregas`), ex.:
   * "http://192.168.2.99:8199". Opcional — se ausente, /enviar cai no fallback de sempre
   * (responder só com o caminho em disco) pra arquivos acima do limite do Telegram. */
  fileServerBaseUrl?: string;
  /** Diretório servido por esse serviço — é pra dentro dele que /enviar copia o arquivo antes de
   * montar o link. */
  entregasDir: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const need = (k: string): string => {
    const v = env[k];
    if (!v) throw new Error(`variável obrigatória ausente no .env: ${k}`);
    return v;
  };
  return {
    botToken: need('TELEGRAM_BOT_TOKEN'),
    allowedChatIds: need('ALLOWED_CHAT_IDS').split(',').map((s) => Number(s.trim())).filter(Number.isFinite),
    mkiDir: env.MKIVIDEOS_DIR ?? '/home/nmaldaner/projetos/mkivideos',
    mkiDb: env.MKIVIDEOS_DB ?? '/home/nmaldaner/projetos/mkivideos/mkivideos.db',
    dashUrl: env.MKIVIDEOS_DASH ?? 'http://localhost:3142',
    mkiTextoDb: env.MKITEXTO_DB ?? '/home/nmaldaner/projetos/mkivideos/mkitexto.db',
    mkiTextoDash: env.MKITEXTO_DASH ?? 'http://localhost:3143',
    // Sem default: credencial vive só no .env, nunca no código.
    dashToken: need('MKIVIDEOS_TOKEN'),
    pollIntervalMs: Number(env.POLL_INTERVAL_SECONDS ?? 60) * 1000,
    stateDb: env.STATE_DB ?? '/home/nmaldaner/projetos/inemaccvbot/state.db',
    projetosDir: env.PROJETOS_DIR ?? '/home/nmaldaner/projetos',
    narracoesDir: env.NARRACOES_DIR ?? '/home/nmaldaner/projetos/inemaccvbot/narracoes',
    anexosDir: env.ANEXOS_DIR ?? '/home/nmaldaner/projetos/inemaccvbot/anexos',
    logFile: env.LOG_FILE ?? '/home/nmaldaner/projetos/inemaccvbot/inemaccvbot.log',
    logMaxBytes: Number(env.LOG_MAX_BYTES ?? 5_000_000),
    fileServerBaseUrl: env.FILE_SERVER_BASE_URL || undefined,
    entregasDir: env.ENTREGAS_DIR ?? '/home/nmaldaner/projetos/output/entregas',
  };
}
