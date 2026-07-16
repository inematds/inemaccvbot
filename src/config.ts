import 'dotenv/config';

export interface Config {
  botToken: string;
  allowedChatIds: number[];
  mkiDir: string;
  mkiDb: string;
  dashUrl: string;
  dashToken: string;
  pollIntervalMs: number;
  stateDb: string;
  briefingsDir: string;
  projetosDir: string;
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
    dashToken: env.MKIVIDEOS_TOKEN ?? 'inemadash',
    pollIntervalMs: Number(env.POLL_INTERVAL_SECONDS ?? 60) * 1000,
    stateDb: env.STATE_DB ?? '/home/nmaldaner/projetos/inemaccvbot/state.db',
    briefingsDir: env.BRIEFINGS_DIR ?? '/home/nmaldaner/projetos/inemaccvbot/briefings',
    projetosDir: env.PROJETOS_DIR ?? '/home/nmaldaner/projetos',
  };
}
