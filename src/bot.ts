import { Bot } from 'grammy';
import { InputFile } from 'grammy';
import { statSync, existsSync, mkdirSync } from 'node:fs';
import type { Config } from './config.js';
import { parseMessage, type Instruction } from './parser.js';
import { skillCommands, buildAddArgs, type SkillDef } from './skills.js';
import { listDests } from './dests.js';
import { helpText, skillsText } from './help.js';
import type { QueueClient } from './queue-client.js';
import type { StateStore } from './state.js';
import { interpretFreeText, researchBriefing, type ClaudeRunner } from './interpret.js';

const MAX_SEND_BYTES = 50 * 1024 * 1024;

export interface BotDeps {
  client: QueueClient;
  state: StateStore;
  defs: SkillDef[];
  interpret: typeof interpretFreeText;
  research: typeof researchBriefing;
  claude: ClaudeRunner;
}

export function createBot(cfg: Config, deps: BotDeps): Bot {
  const bot = new Bot(cfg.botToken);
  const commands = skillCommands(deps.defs);

  bot.catch((err) => {
    console.error(`[bot] erro não tratado em ${err.ctx.update.update_id}:`, err.error);
    const chatId = err.ctx.chat?.id;
    if (chatId !== undefined && cfg.allowedChatIds.includes(chatId)) {
      err.ctx.reply('❌ deu um erro inesperado por aqui — tenta de novo, e se persistir avisa o Nei').catch((e) => {
        console.error('[bot] falha ao notificar erro ao usuário:', e);
      });
    }
  });

  // Allowlist: fora da lista = ignora em silêncio (só log).
  bot.use(async (ctx, next) => {
    const id = ctx.chat?.id;
    if (id === undefined || !cfg.allowedChatIds.includes(id)) {
      console.warn(`[acesso] ignorando chat não autorizado: ${id} (@${ctx.from?.username ?? '?'})`);
      return;
    }
    await next();
  });

  bot.command('help', (ctx) => ctx.reply(helpText(deps.defs, listDests(cfg.projetosDir))));
  bot.command('start', (ctx) => ctx.reply(helpText(deps.defs, listDests(cfg.projetosDir))));
  bot.command('skills', (ctx) => ctx.reply(skillsText(deps.defs)));

  bot.command('fila', async (ctx) => {
    try {
      if (!(await deps.client.ping())) return ctx.reply('⚠️ fila mkivideos indisponível (daemon fora do ar)');
      ctx.reply(await deps.client.fila());
    } catch (e) {
      await ctx.reply(`❌ falha ao consultar a fila: ${(e as Error).message.slice(0, 200)}`);
    }
  });

  bot.command('status', async (ctx) => {
    try {
      const arg = ctx.match?.toString().trim();
      if (arg) {
        const id = Number(arg);
        if (!Number.isInteger(id)) return ctx.reply('uso: /status <id> (ou /status sem argumento pra ver stats)');
        return ctx.reply(await deps.client.status(id));
      }
      ctx.reply(await deps.client.stats());
    } catch (e) {
      await ctx.reply(`❌ falha ao consultar status: ${(e as Error).message.slice(0, 200)}`);
    }
  });

  bot.command('cancelar', async (ctx) => {
    try {
      const id = Number(ctx.match?.toString().trim());
      if (!Number.isInteger(id)) return ctx.reply('uso: /cancelar <id>');
      ctx.reply(await deps.client.cancel(id));
      deps.state.setStatus(id, 'canceled');
    } catch (e) {
      await ctx.reply(`❌ falha ao cancelar: ${(e as Error).message.slice(0, 200)}`);
    }
  });

  bot.command('enviar', async (ctx) => {
    try {
      const id = Number(ctx.match?.toString().trim());
      if (!Number.isInteger(id)) return ctx.reply('uso: /enviar <id>');
      const path = await deps.client.getPath(id);
      if (!path || !existsSync(path)) return ctx.reply(`#${id} ainda não tem arquivo pronto`);
      const size = statSync(path).size;
      if (size > MAX_SEND_BYTES) {
        return ctx.reply(`arquivo tem ${(size / 1e6).toFixed(0)} MB (limite do bot: 50 MB)\ncaminho: ${path}`);
      }
      await ctx.replyWithVideo(new InputFile(path));
    } catch (e) {
      await ctx.reply(`❌ falha ao enviar: ${(e as Error).message.slice(0, 200)}`);
    }
  });

  // Mensagem de texto = instruções (1 por linha)
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith('/')) return; // comando desconhecido
    if (!(await deps.client.ping())) return ctx.reply('⚠️ fila mkivideos indisponível — instrução NÃO enfileirada, tenta de novo depois');

    const results = parseMessage(text, commands, cfg.projetosDir);
    const replies: string[] = [];
    const freeLines: string[] = [];

    for (const r of results) {
      if (r.kind === 'error') { replies.push(`❌ ${r.line}\n   ${r.message}`); continue; }
      if (r.kind === 'free') { freeLines.push(r.line); continue; }
      replies.push(await submit(r.instr, ctx.chat.id, cfg, deps));
    }

    if (freeLines.length) {
      await ctx.reply('🧠 interpretando com Claude…');
      try {
        const out = await deps.interpret(freeLines.join('\n'), deps.defs, cfg.projetosDir, deps.claude);
        if (!out.ok) replies.push(`❌ não deu: ${out.error}\nveja /help e /skills`);
        else for (const instr of out.instrs) replies.push(await submit(instr, ctx.chat.id, cfg, deps));
      } catch (e) {
        replies.push(`❌ falha ao interpretar com Claude: ${(e as Error).message.slice(0, 200)}\nveja /help e /skills`);
      }
    }

    await ctx.reply(replies.join('\n\n') || 'nada pra fazer — manda /help');
  });

  return bot;
}

async function submit(instr: Instruction, chatId: number, cfg: Config, deps: BotDeps): Promise<string> {
  try {
    let briefing: string | null = null;
    if (instr.pesquisa) {
      briefing = await deps.research(instr.input, cfg.briefingsDir, deps.claude);
      instr = { ...instr, input: `${instr.input}. IMPORTANTE: use como base o briefing de pesquisa em ${briefing} (fatos, ângulos e fontes).` };
    }
    if (instr.dest) mkdirSync(instr.dest, { recursive: true });
    const jobId = await deps.client.add(buildAddArgs(instr, deps.defs));
    deps.state.track({ jobId, chatId, dest: instr.dest, destToken: instr.destToken, briefing });
    const extras = [instr.vertical ? '9:16' : '16:9', instr.pesquisa ? 'com pesquisa 🔎' : null, instr.destToken ? `→ ${instr.destToken}` : null]
      .filter(Boolean).join(' · ');
    return `📥 #${jobId} na fila (${instr.skill}) ${extras}\naviso aqui quando terminar`;
  } catch (e) {
    return `❌ falhou ao enfileirar "${instr.input.slice(0, 60)}": ${(e as Error).message.slice(0, 200)}`;
  }
}
