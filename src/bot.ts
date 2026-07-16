import { Bot } from 'grammy';
import { InputFile } from 'grammy';
import { statSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.js';
import { parseMessage, type Instruction } from './parser.js';
import { skillCommands, buildAddArgs, type SkillDef } from './skills.js';
import { listDests } from './dests.js';
import { helpText, skillsText } from './help.js';
import type { QueueClient } from './queue-client.js';
import type { StateStore } from './state.js';
import { interpretFreeText, type ClaudeRunner } from './interpret.js';
import { consoleLogger, truncate, type Logger } from './log.js';

const MAX_SEND_BYTES = 50 * 1024 * 1024;

/** Anexada ao input do job quando "pesquisa" está marcado — o AGENTE de render (mkivideos) é quem
 * de fato pesquisa a web (claude -p sem --allowedTools, sessão completa com ferramentas web).
 * Uma frase só, sem quebra de linha e sem token começando com "--" (o CLI do mkivideos re-splita
 * o input em argv e um "--algo" seria engolido pelo loop de flags). */
const RESEARCH_INSTRUCTION =
  'IMPORTANTE: antes de escrever o roteiro, pesquise o assunto na web e baseie o conteúdo no que encontrar (fatos verificados, números e fontes).';

/** Mesma restrição do RESEARCH_INSTRUCTION: uma frase só, sem quebra de linha, sem token "--…",
 * e o caminho absoluto embutido não pode conter espaço (o CLI do mkivideos re-splita o input em argv). */
function narrationInstruction(absPath: string): string {
  return `IMPORTANTE: além do vídeo, salve a narração completa (o texto falado, em ordem de cena, em texto puro) no arquivo "${absPath}".`;
}

/** Slug sem espaço/acento pro nome do arquivo de narração. */
function slugify(input: string): string {
  const slug = input
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.slice(0, 60) || 'sem-titulo';
}

export interface BotDeps {
  client: QueueClient;
  state: StateStore;
  defs: SkillDef[];
  interpret: typeof interpretFreeText;
  claude: ClaudeRunner;
  log?: Logger;
}

export function createBot(cfg: Config, deps: BotDeps): Bot {
  const bot = new Bot(cfg.botToken);
  const commands = skillCommands(deps.defs);
  const log = deps.log ?? consoleLogger();

  bot.catch((err) => {
    log.error(`[bot] erro não tratado em ${err.ctx.update.update_id}: ${(err.error as Error)?.message ?? err.error}`);
    const chatId = err.ctx.chat?.id;
    if (chatId !== undefined && cfg.allowedChatIds.includes(chatId)) {
      err.ctx.reply('❌ deu um erro inesperado por aqui — tenta de novo, e se persistir avisa o Nei').catch((e) => {
        log.error(`[bot] falha ao notificar erro ao usuário: ${(e as Error).message}`);
      });
    }
  });

  // Allowlist: fora da lista = ignora em silêncio (só log).
  bot.use(async (ctx, next) => {
    const id = ctx.chat?.id;
    if (id === undefined || !cfg.allowedChatIds.includes(id)) {
      log.warn(`[acesso] ignorando chat não autorizado: ${id} (@${ctx.from?.username ?? '?'})`);
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
      await ctx.reply(await deps.client.fila());
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
      await ctx.reply(await deps.client.stats());
    } catch (e) {
      await ctx.reply(`❌ falha ao consultar status: ${(e as Error).message.slice(0, 200)}`);
    }
  });

  bot.command('cancelar', async (ctx) => {
    try {
      const arg = ctx.match?.toString().trim();
      if (!arg) return ctx.reply('uso: /cancelar <id>');
      const id = Number(arg);
      if (!Number.isInteger(id)) return ctx.reply('uso: /cancelar <id>');
      await ctx.reply(await deps.client.cancel(id));
      deps.state.setStatus(id, 'canceled');
    } catch (e) {
      await ctx.reply(`❌ falha ao cancelar: ${(e as Error).message.slice(0, 200)}`);
    }
  });

  bot.command('enviar', async (ctx) => {
    try {
      const arg = ctx.match?.toString().trim();
      if (!arg) return ctx.reply('uso: /enviar <id>');
      const id = Number(arg);
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
    log.info(`[instrução] chat ${ctx.chat.id}: ${truncate(text)}`);
    if (!(await deps.client.ping())) return ctx.reply('⚠️ fila mkivideos indisponível — instrução NÃO enfileirada, tenta de novo depois');

    const results = parseMessage(text, commands, cfg.projetosDir);
    const replies: string[] = [];
    const freeLines: string[] = [];

    for (const r of results) {
      if (r.kind === 'error') { log.warn(`[recusa] chat ${ctx.chat.id}: ${r.message}`); replies.push(`❌ ${r.line}\n   ${r.message}`); continue; }
      if (r.kind === 'free') { freeLines.push(r.line); continue; }
      replies.push(await submit(r.instr, ctx.chat.id, cfg, deps));
    }

    if (freeLines.length) {
      await ctx.reply('🧠 interpretando com Claude…');
      try {
        const out = await deps.interpret(freeLines.join('\n'), deps.defs, cfg.projetosDir, deps.claude);
        if (!out.ok) {
          log.warn(`[recusa] chat ${ctx.chat.id}: ${out.error}`);
          replies.push(`❌ não deu: ${out.error}\nveja /help e /skills`);
        } else {
          for (const instr of out.instrs) replies.push(await submit(instr, ctx.chat.id, cfg, deps));
          if (out.ignorado) {
            log.info(`[ignorado] chat ${ctx.chat.id}: ${out.ignorado}`);
            replies.push(`⚠️ não vou fazer: ${out.ignorado}`);
          }
        }
      } catch (e) {
        log.error(`[interpret] chat ${ctx.chat.id} falhou: ${(e as Error).message}`);
        replies.push(`❌ falha ao interpretar com Claude: ${(e as Error).message.slice(0, 200)}\nveja /help e /skills`);
      }
    }

    await ctx.reply(replies.join('\n\n') || 'nada pra fazer — manda /help');
  });

  return bot;
}

export async function submit(instr: Instruction, chatId: number, cfg: Config, deps: BotDeps): Promise<string> {
  const log = deps.log ?? consoleLogger();
  try {
    if (instr.pesquisa) {
      instr = { ...instr, input: `${instr.input}. ${RESEARCH_INSTRUCTION}` };
    }
    let narracaoPath: string | null = null;
    if (instr.narracao) {
      if (/\s/.test(cfg.narracoesDir)) {
        return `❌ falhou ao enfileirar "${instr.input.slice(0, 60)}": NARRACOES_DIR contém espaço — corrija a config antes de pedir narração`;
      }
      const slug = slugify(instr.input);
      narracaoPath = join(cfg.narracoesDir, `${Date.now()}-${slug}.txt`);
      mkdirSync(cfg.narracoesDir, { recursive: true });
      instr = { ...instr, input: `${instr.input}. ${narrationInstruction(narracaoPath)}` };
    }
    if (instr.dest) mkdirSync(instr.dest, { recursive: true });
    const jobId = await deps.client.add(buildAddArgs(instr, deps.defs));
    deps.state.track({ jobId, chatId, dest: instr.dest, destToken: instr.destToken, pesquisa: instr.pesquisa, narracaoPath });
    const extras = [instr.vertical ? '9:16' : '16:9', instr.pesquisa ? 'com pesquisa 🔎' : null,
      instr.narracao ? 'com narração em texto 📝' : null, instr.destToken ? `→ ${instr.destToken}` : null]
      .filter(Boolean).join(' · ');
    log.info(`[enfileirado] chat ${chatId}: #${jobId} (${instr.skill})`);
    return `📥 #${jobId} na fila (${instr.skill}) ${extras}\naviso aqui quando terminar`;
  } catch (e) {
    log.error(`[falha ao enfileirar] chat ${chatId}: ${(e as Error).message}`);
    return `❌ falhou ao enfileirar "${instr.input.slice(0, 60)}": ${(e as Error).message.slice(0, 200)}`;
  }
}
