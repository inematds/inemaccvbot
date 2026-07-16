import { readFileSync } from 'node:fs';
import { InputFile } from 'grammy';
import { loadConfig } from './config.js';
import { loadSkills } from './skills.js';
import { QueueClient } from './queue-client.js';
import { StateStore } from './state.js';
import { createBot } from './bot.js';
import { startWatcher } from './watcher.js';
import { defaultClaudeRunner, interpretFreeText } from './interpret.js';
import { createLogger } from './log.js';

const cfg = loadConfig();
const log = createLogger(cfg.logFile, cfg.logMaxBytes);
const defs = loadSkills();
const client = new QueueClient(cfg);
const state = new StateStore(cfg.stateDb);
const bot = createBot(cfg, { client, state, defs, interpret: interpretFreeText, claude: defaultClaudeRunner(), log });

// Telegram limita mensagens a 4096 chars — abaixo de ~3500 manda como texto, senão como documento.
const NARRATION_INLINE_MAX_CHARS = 3500;

const stopWatcher = startWatcher(
  {
    jobs: () => client.jobs(),
    state,
    notify: (chatId, text) => bot.api.sendMessage(chatId, text).then(() => {}),
    jobById: (id) => client.jobById(id),
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

function shutdown(): void {
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
