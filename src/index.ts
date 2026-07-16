import { loadConfig } from './config.js';
import { loadSkills } from './skills.js';
import { QueueClient } from './queue-client.js';
import { StateStore } from './state.js';
import { createBot } from './bot.js';
import { startWatcher } from './watcher.js';
import { defaultClaudeRunner, interpretFreeText, researchBriefing } from './interpret.js';

const cfg = loadConfig();
const defs = loadSkills();
const client = new QueueClient(cfg);
const state = new StateStore(cfg.stateDb);
const bot = createBot(cfg, { client, state, defs, interpret: interpretFreeText, research: researchBriefing, claude: defaultClaudeRunner() });

const stopWatcher = startWatcher(
  { jobs: () => client.jobs(), state, notify: (chatId, text) => bot.api.sendMessage(chatId, text).then(() => {}) },
  cfg.pollIntervalMs,
);

process.on('SIGTERM', () => { stopWatcher(); void bot.stop(); });
process.on('SIGINT', () => { stopWatcher(); void bot.stop(); });

console.log('[inemaccvbot] iniciando (long polling)…');
void bot.start();
