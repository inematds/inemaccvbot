import { Bot, Context } from 'grammy';
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
import { buildAnswerContext, answerQuestion } from './answer.js';
import { consoleLogger, truncate, type Logger } from './log.js';
import type { DocumentDownloader } from './media.js';

const MAX_SEND_BYTES = 50 * 1024 * 1024;
const MAX_ANEXO_BYTES = 5 * 1024 * 1024;

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

/** Mesma restrição das outras instruções anexadas ao input do job: uma frase só, sem quebra de
 * linha, sem token "--…", caminho absoluto sem espaço (o CLI do mkivideos re-splita o input em
 * argv). Diz ao agente de render pra usar o conteúdo do anexo como fonte/base do vídeo. */
function documentInstruction(absPath: string): string {
  return `IMPORTANTE: use o conteúdo do arquivo em "${absPath}" como fonte/base para o vídeo.`;
}

/** Anexa `note` ao "input" de uma instrução já resolvida (job estruturado OU job vindo do
 * fallback Claude) — mesmo padrão de RESEARCH_INSTRUCTION/narrationInstruction. */
function withNote(instr: Instruction, note?: string): Instruction {
  return note ? { ...instr, input: `${instr.input}. ${note}` } : instr;
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
  /** Baixa um documento do Telegram e devolve o caminho local. Ausente em `submit()`-only deps
   * (testes que não exercitam `message:document`) — só é obrigatório de fato pro handler de
   * documento em `createBot`. */
  downloadDocument?: DocumentDownloader;
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

  /** Núcleo compartilhado entre `message:text` e `message:document`: parseia `text` (parser leve +
   * fallback Claude), enfileira o que mapeia pra skill registrada, responde pergunta sobre o
   * serviço/capacidades sem enfileirar nada. Quando `fileNote` é passado (mensagem tem um anexo já
   * baixado), é anexado ao "input" de todo job resolvido — estruturado OU vindo do fallback — pra
   * o agente de render usar o arquivo como fonte. */
  async function processInstructionText(ctx: Context, text: string, fileNote?: string): Promise<void> {
    const results = parseMessage(text, commands, cfg.projetosDir);
    const replies: string[] = [];
    const freeLines: string[] = [];
    const jobLines: Instruction[] = [];

    for (const r of results) {
      if (r.kind === 'error') { log.warn(`[recusa] chat ${ctx.chat!.id}: ${r.message}`); replies.push(`❌ ${r.line}\n   ${r.message}`); continue; }
      if (r.kind === 'free') { freeLines.push(r.line); continue; }
      jobLines.push(withNote(r.instr, fileNote));
    }

    // Ping é checado sob demanda (e só uma vez) — uma PERGUNTA não precisa da fila viva
    // (log + state local já bastam), então o gate não pode bloquear o handler inteiro.
    let queueUp: boolean | undefined;
    const ensurePing = async (): Promise<boolean> => {
      if (queueUp === undefined) queueUp = await deps.client.ping();
      return queueUp;
    };

    if (jobLines.length) {
      if (!(await ensurePing())) {
        replies.push('⚠️ fila mkivideos indisponível — instrução NÃO enfileirada, tenta de novo depois');
      } else {
        for (const instr of jobLines) replies.push(await submit(instr, ctx.chat!.id, cfg, deps));
      }
    }

    if (freeLines.length) {
      await ctx.reply('🧠 interpretando com Claude…');
      try {
        const out = await deps.interpret(freeLines.join('\n'), deps.defs, cfg.projetosDir, deps.claude);
        if (!out.ok) {
          log.warn(`[recusa] chat ${ctx.chat!.id}: ${out.error}`);
          replies.push(`❌ não deu: ${out.error}\nveja /help e /skills`);
        } else if (out.kind === 'question') {
          log.info(`[pergunta] chat ${ctx.chat!.id}: ${truncate(out.question)}`);
          try {
            const answerCtx = await buildAnswerContext(ctx.chat!.id, deps.client, deps.state, cfg.logFile, deps.defs, listDests(cfg.projetosDir));
            const answer = await answerQuestion(out.question, answerCtx, deps.claude);
            log.info(`[resposta] chat ${ctx.chat!.id}: ${truncate(answer)}`);
            replies.push(answer);
          } catch (e) {
            log.error(`[resposta] chat ${ctx.chat!.id} falhou: ${(e as Error).message}`);
            replies.push(`❌ não consegui responder agora: ${(e as Error).message.slice(0, 200)}`);
          }
        } else {
          if (!(await ensurePing())) {
            replies.push('⚠️ fila mkivideos indisponível — instrução NÃO enfileirada, tenta de novo depois');
          } else {
            for (const instr of out.instrs) replies.push(await submit(withNote(instr, fileNote), ctx.chat!.id, cfg, deps));
            if (out.ignorado) {
              log.info(`[ignorado] chat ${ctx.chat!.id}: ${out.ignorado}`);
              replies.push(`⚠️ não vou fazer: ${out.ignorado}`);
            }
          }
        }
      } catch (e) {
        log.error(`[interpret] chat ${ctx.chat!.id} falhou: ${(e as Error).message}`);
        replies.push(`❌ falha ao interpretar com Claude: ${(e as Error).message.slice(0, 200)}\nveja /help e /skills`);
      }
    }

    await ctx.reply(replies.join('\n\n') || 'nada pra fazer — manda /help');
  }

  // Mensagem de texto = instruções (1 por linha) OU pergunta sobre o serviço/capacidades.
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith('/')) return; // comando desconhecido
    log.info(`[instrução] chat ${ctx.chat.id}: ${truncate(text)}`);
    await processInstructionText(ctx, text);
  });

  // Documento anexado (ex.: .md) — baixa, sanitiza o nome e trata a legenda como instrução,
  // apontando o agente de render pro arquivo local. Sem legenda, nunca inventa um job.
  bot.on('message:document', async (ctx) => {
    const doc = ctx.message.document;
    const filename = doc.file_name ?? 'arquivo';
    const size = doc.file_size ?? 0;
    log.info(`[documento] chat ${ctx.chat.id}: ${filename} (${size} bytes)`);

    if (size > MAX_ANEXO_BYTES) {
      await ctx.reply(`❌ "${filename}" tem ${(size / 1e6).toFixed(1)} MB — limite pra anexos é ${(MAX_ANEXO_BYTES / 1e6).toFixed(0)} MB (é pra texto/instrução, não pra mídia grande)`);
      return;
    }

    const caption = ctx.message.caption?.trim() ?? '';
    if (!caption) {
      await ctx.reply(`recebi "${filename}" mas sem legenda não sei o que fazer com ele — manda de novo com uma instrução na legenda (ex.: "explicativo: resumo desse documento").\n\n${skillsText(deps.defs)}`);
      return;
    }

    if (/\s/.test(cfg.anexosDir)) {
      log.error(`[documento] chat ${ctx.chat.id}: ANEXOS_DIR contém espaço, recusando anexo`);
      await ctx.reply('❌ ANEXOS_DIR contém espaço — corrija a config antes de mandar anexos');
      return;
    }

    if (!deps.downloadDocument) {
      log.error(`[documento] chat ${ctx.chat.id}: downloadDocument não configurado`);
      await ctx.reply('❌ recebimento de anexos não está configurado neste bot');
      return;
    }

    let localPath: string;
    try {
      localPath = await deps.downloadDocument(doc.file_id, filename);
    } catch (e) {
      log.error(`[documento] chat ${ctx.chat.id} falhou ao baixar "${filename}": ${(e as Error).message}`);
      await ctx.reply('❌ falha ao baixar o arquivo — tenta de novo');
      return;
    }

    await processInstructionText(ctx, caption, documentInstruction(localPath));
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
