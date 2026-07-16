import { loadConfig } from './config.js';
import { loadSkills } from './skills.js';
import { QueueClient } from './queue-client.js';
import { StateStore } from './state.js';
import { createBot } from './bot.js';
import { startWatcher } from './watcher.js';
import { defaultClaudeRunner, interpretFreeText } from './interpret.js';

const cfg = loadConfig();
const defs = loadSkills();
const client = new QueueClient(cfg);
const state = new StateStore(cfg.stateDb);
const bot = createBot(cfg, { client, state, defs, interpret: interpretFreeText, claude: defaultClaudeRunner() });

const stopWatcher = startWatcher(
  {
    jobs: () => client.jobs(),
    state,
    notify: (chatId, text) => bot.api.sendMessage(chatId, text).then(() => {}),
    jobById: (id) => client.jobById(id),
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
  console.error('[inemaccvbot] unhandledRejection:', reason);
});

console.log('[inemaccvbot] iniciando (long polling)…');
bot.start().catch((err) => {
  console.error('[inemaccvbot] falha ao iniciar o bot:', err);
  process.exit(1);
});
