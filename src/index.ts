import { readFileSync } from 'node:fs';
import { InputFile } from 'grammy';
import { loadConfig } from './config.js';
import { loadSkills } from './skills.js';
import { QueueClient } from './queue-client.js';
import { StateStore } from './state.js';
import { createBot, makeReelEnqueuer, type BotDeps } from './bot.js';
import { startWatcher } from './watcher.js';
import { defaultFase1Runner, defaultFase2Runner, defaultHeygenClient, startPromoWatcher } from './promoclub.js';
import { defaultClaudeRunner, interpretFreeText } from './interpret.js';
import { createLogger } from './log.js';
import { makeDocumentDownloader } from './media.js';

const cfg = loadConfig();
const log = createLogger(cfg.logFile, cfg.logMaxBytes);
const defs = loadSkills();
const videoClient = new QueueClient({ mkiDir: cfg.mkiDir, mkiDb: cfg.mkiDb, dashUrl: cfg.dashUrl, dashToken: cfg.dashToken });
const textoClient = new QueueClient({ mkiDir: cfg.mkiDir, mkiDb: cfg.mkiTextoDb, dashUrl: cfg.mkiTextoDash, dashToken: cfg.dashToken });
const state = new StateStore(cfg.stateDb);
const botDeps: BotDeps = {
  videoClient, textoClient, state, defs, interpret: interpretFreeText, claude: defaultClaudeRunner(),
  downloadDocument: makeDocumentDownloader(cfg.botToken, cfg.anexosDir), log,
  promo: { fase1: defaultFase1Runner(), fase2: defaultFase2Runner(log), heygen: defaultHeygenClient(cfg.heygenEnvPath) },
};
const bot = createBot(cfg, botDeps);

// Telegram limita mensagens a 4096 chars — abaixo de ~3500 manda como texto, senão como documento.
const NARRATION_INLINE_MAX_CHARS = 3500;

const stopWatcher = startWatcher(
  {
    queues: [
      { queue: 'video', jobs: () => videoClient.jobs(), jobById: (id) => videoClient.jobById(id) },
      { queue: 'texto', jobs: () => textoClient.jobs(), jobById: (id) => textoClient.jobById(id) },
    ],
    state,
    notify: (chatId, text) => bot.api.sendMessage(chatId, text).then(() => {}),
    log,
    sendNarration: async (chatId, path) => {
      const content = readFileSync(path, 'utf8');
      if (content.length <= NARRATION_INLINE_MAX_CHARS) {
        await bot.api.sendMessage(chatId, content);
      } else {
        await bot.api.sendDocument(chatId, new InputFile(path));
      }
    },
  },
  cfg.pollIntervalMs,
);

// Watcher do /promoclub: detecta renders prontos no HeyGen (fase 2.5) e emenda a fase 3.
const stopPromoWatcher = startPromoWatcher(
  {
    promoDir: cfg.promoDir,
    baixar: { heygen: botDeps.promo!.heygen, enqueueReel: makeReelEnqueuer(cfg, botDeps), log },
    notify: (chatId, text) => bot.api.sendMessage(chatId, text).then(() => {}),
    log,
  },
  cfg.promoPollMs,
);

function shutdown(): void {
  stopPromoWatcher();
  stopWatcher();
  state.close();
  void bot.stop();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('unhandledRejection', (reason) => {
  log.error(`[inemaccvbot] unhandledRejection: ${String(reason)}`);
});

log.info('[inemaccvbot] iniciando (long polling)…');
bot.start().catch((err) => {
  log.error(`[inemaccvbot] falha ao iniciar o bot: ${(err as Error).message}`);
  process.exit(1);
});
