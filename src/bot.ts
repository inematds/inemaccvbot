import { Bot, Context } from 'grammy';
import { InputFile } from 'grammy';
import { statSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import type { Config } from './config.js';
import { parseMessage, type Instruction } from './parser.js';
import { skillCommands, buildAddArgs, type SkillDef } from './skills.js';
import { listDests } from './dests.js';
import { helpText, skillsText } from './help.js';
import { safeReply } from './reply.js';
import type { QueueClient } from './queue-client.js';
import type { StateStore, Queue } from './state.js';
import { resolveJobArg, formatJobRef } from './jobref.js';
import {
  parsePromoclubArg, newPromoState, saveState, loadState, listStates, runFase1, runFase2, baixarTick,
  statusText, reelDescricaoFor, PUBLICO_LIVES, type Fase1Runner, type Fase2Runner, type HeygenClient, type PromoState, type ReelEnqueuer,
} from './promoclub.js';
import { resolveDest } from './dests.js';
import { interpretFreeText, type ClaudeRunner } from './interpret.js';
import { buildAnswerContext, answerQuestion } from './answer.js';
import { consoleLogger, truncate, type Logger } from './log.js';
import type { DocumentDownloader } from './media.js';
import { publishForDownload } from './deliver.js';

const MAX_SEND_BYTES = 50 * 1024 * 1024;
const MAX_ANEXO_BYTES = 5 * 1024 * 1024;

/** Acima disso, `/reel <pasta>` ainda enfileira todos os vídeos, mas a resposta ganha um aviso —
 * cada reel é um render longo (fila com concorrência 1), então uma pasta grande enfileirada
 * de uma vez pode levar bastante tempo até o último terminar. */
const REEL_BATCH_WARN_THRESHOLD = 30;

/** Extensões de vídeo aceitas pro modo pasta do `/reel` — top-level apenas (não recursivo),
 * case-insensitive, ignora dotfiles/ocultos. */
const REEL_VIDEO_EXTENSIONS = ['.mp4', '.mov', '.m4v', '.webm'];

/** `true` só se `path` existe e é um diretório — nunca lança (arquivo inexistente/erro de acesso
 * vira `false`, tratado como "não é pasta" pelo chamador). */
function isDirectoryPath(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Lista os vídeos diretamente dentro de `dir` (não recursivo), ordenados por nome pra ordem
 * estável — mesma ordem em que os jobs são enfileirados. Pode lançar (ex.: permissão negada);
 * o chamador (`submitReelFolder`) captura e transforma numa resposta clara. */
function listVideoFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.startsWith('.') && REEL_VIDEO_EXTENSIONS.includes(extname(e.name).toLowerCase()))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => join(dir, name));
}

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

/** Mesma restrição do RESEARCH_INSTRUCTION: uma frase só, sem quebra de linha, sem token "--…".
 * O download+transcrição não é uma skill do mkivideos — é delegada ao próprio agente de render
 * (mesmo padrão de pesquisa/narração), que roda como sessão `claude -p` completa com acesso a
 * filesystem e ferramentas, e é instruído a usar o inemavox (baixar_v1.py + transcrever_v1.py,
 * download + Whisper local, em ~/projetos/inemavox) ANTES de escrever o roteiro. */
const TRANSCRIPTION_INSTRUCTION =
  'IMPORTANTE: antes de escrever o roteiro, baixe o áudio do link de origem e transcreva localmente com o inemavox (baixar_v1.py mais transcrever_v1.py, Whisper local, em ~/projetos/inemavox), e use essa transcrição como base factual do vídeo.';

/** Mesma restrição das outras instruções anexadas ao input do job: uma frase só, sem quebra de
 * linha, sem token "--…", caminho absoluto sem espaço (o CLI do mkivideos re-splita o input em
 * argv). Diz ao agente de render pra usar o conteúdo do anexo como fonte/base do vídeo. */
function documentInstruction(absPath: string): string {
  return `IMPORTANTE: use o conteúdo do arquivo em "${absPath}" como fonte/base para o vídeo.`;
}

/** Mesma restrição das outras instruções: UMA frase só, sem quebra de linha, sem token "--…".
 * Reforça o caminho do avatar e, quando `visuais` foi pedido, embute na MESMA frase a troca pro
 * Modo 3 (visuais) da skill reel-edita-inema em vez do Modo 2 (explicador, default). */
function reelInstruction(avatarPath: string, visuais: boolean, descricao?: string): string {
  const modo = visuais ? ', usando o Modo 3 (visuais) em vez do explicador' : '';
  const extra = descricao ? ` (pedido adicional do usuário: ${descricao})` : '';
  return `IMPORTANTE: use o vídeo de avatar em "${avatarPath}" como base do reel${modo}${extra}.`;
}

/** Caption de anexo no formato "reel"/"/reel" (bare) ou "reel | campo | campo"/"reel <descrição>"
 * (SEM "assunto:", já que o "input" é o próprio arquivo anexado) — devolve a linha equivalente
 * `reel: <path> ...resto` pronta pra `parseMessage` (que faz a separação caminho/descrição), ou
 * null se a caption não é desse formato (segue o fluxo genérico de anexo). */
function reelCaptionLine(caption: string, localPath: string): string | null {
  const m = caption.trim().match(/^\/?reels?\b\s*(.*)$/i);
  if (!m) return null;
  const rest = m[1]?.trim() ?? '';
  return `reel: ${localPath}${rest ? ` ${rest}` : ''}`;
}

/** Instrução pra `reelinematds` (skill sem modos — só o caminho do bruto + instrução extra opcional). */
function reelInematdsInstruction(brutoPath: string, descricao?: string): string {
  const extra = descricao ? ` (pedido adicional do usuário: ${descricao})` : '';
  return `IMPORTANTE: use o vídeo bruto em "${brutoPath}" como base do reel${extra}.`;
}

/** Mesmo padrão de `reelCaptionLine`, pra `reelinematds`/"/reelinematds" (bare) ou com campos/descrição. */
function reelInematdsCaptionLine(caption: string, localPath: string): string | null {
  const m = caption.trim().match(/^\/?reelinematds\b\s*(.*)$/i);
  if (!m) return null;
  const rest = m[1]?.trim() ?? '';
  return `reelinematds: ${localPath}${rest ? ` ${rest}` : ''}`;
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
  /** Fila de vídeo (mkivideos — explicativo/curso/demo) e fila de texto (mkitexto —
   * transcrever/dublar). São dois clientes distintos, nunca um só — o roteamento entre eles é
   * SEMPRE uma consulta à tabela de skills (`SkillDef.queue`), nunca uma decisão do modelo. */
  videoClient: QueueClient;
  textoClient: QueueClient;
  state: StateStore;
  defs: SkillDef[];
  interpret: typeof interpretFreeText;
  claude: ClaudeRunner;
  /** Baixa um documento do Telegram e devolve o caminho local. Ausente em `submit()`-only deps
   * (testes que não exercitam `message:document`) — só é obrigatório de fato pro handler de
   * documento em `createBot`. */
  downloadDocument?: DocumentDownloader;
  log?: Logger;
  /** Dependências do /promoclub (pipeline inemaclubpromover). Ausente em testes que não o
   * exercitam — o comando responde que o recurso não está configurado. `fase2` é opcional: sem
   * ele, a fase 2 (avatar) continua manual, como antes. */
  promo?: { fase1: Fase1Runner; fase2?: Fase2Runner; heygen: HeygenClient };
}

/** Enfileira a fase 3 de um avatar do /promoclub: skill `reel` (capa impacto + gatilho do
 * público) com destino no lives do público. Pasta lives faltante → cria o MÍNIMO
 * imports/videos (autorizado 2026-07-18) — a config do canal segue pendente com o usuário. */
export function makeReelEnqueuer(cfg: Config, deps: BotDeps): ReelEnqueuer {
  return async (arquivo, publico, state: PromoState) => {
    const livesToken = PUBLICO_LIVES[publico];
    let dest = resolveDest(livesToken, cfg.projetosDir);
    if (!dest) {
      mkdirSync(join(cfg.projetosDir, `yt-pub-${livesToken}`, 'imports', 'videos'), { recursive: true });
      dest = resolveDest(livesToken, cfg.projetosDir);
    }
    const instr: Instruction = {
      skill: 'reel', input: arquivo, vertical: false, dest, destToken: livesToken,
      pesquisa: false, narracao: false, transcrever: false, mover: false,
      reelDescricao: reelDescricaoFor(publico),
    };
    const reply = await submit(instr, state.chatId, cfg, deps);
    const m = reply.match(/V#(\d+)/);
    if (!m) throw new Error(`enfileirar reel falhou: ${reply.slice(0, 200)}`);
    return Number(m[1]);
  };
}

/** Table lookup — a fila de uma instrução é sempre a `queue` da skill registrada, nunca uma
 * decisão do modelo. Skill desconhecida (não deveria acontecer, buildAddArgs já teria lançado)
 * cai em vídeo por segurança. */
function queueForSkill(skill: string, defs: SkillDef[]): Queue {
  return defs.find((d) => d.command === skill)?.queue ?? 'video';
}

function clientFor(queue: Queue, deps: Pick<BotDeps, 'videoClient' | 'textoClient'>): QueueClient {
  return queue === 'video' ? deps.videoClient : deps.textoClient;
}

const QUEUE_LABEL: Record<Queue, string> = { video: '🎬 vídeo', texto: '📝 texto' };

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

  bot.command('help', (ctx) => safeReply(ctx, helpText(deps.defs, listDests(cfg.projetosDir))));
  bot.command('start', (ctx) => safeReply(ctx, helpText(deps.defs, listDests(cfg.projetosDir))));
  bot.command('skills', (ctx) => safeReply(ctx, skillsText(deps.defs)));

  /** Resolve o argumento de id de um comando (/status, /cancelar, /enviar) contra os jobs
   * rastreados deste chat. Nunca adivinha: se o id nu bater em mais de uma fila, ou em nenhuma,
   * responde pedindo pra especificar (prefixo V#/T#) e devolve null pro chamador não agir. */
  async function resolveOrReply(ctx: Context, arg: string): Promise<{ queue: Queue; jobId: number } | null> {
    const resolved = resolveJobArg(arg, deps.state.forChat(ctx.chat!.id));
    if (resolved.kind === 'ok') return resolved.ref;
    if (resolved.kind === 'ambiguous') {
      await ctx.reply(`existe "#${arg}" em mais de uma fila — qual? ${resolved.candidates.map(formatJobRef).join(' ou ')}`);
      return null;
    }
    await ctx.reply(`não achei "${arg}" entre os jobs rastreados deste chat — use o prefixo V# (vídeo) ou T# (texto), ex.: V${arg.replace(/^[vt]#?/i, '')}`);
    return null;
  }

  bot.command('fila', async (ctx) => {
    const parts: string[] = [];
    for (const queue of ['video', 'texto'] as const) {
      const client = clientFor(queue, deps);
      try {
        if (!(await client.ping())) { parts.push(`${QUEUE_LABEL[queue]}: ⚠️ indisponível (daemon fora do ar)`); continue; }
        parts.push(`${QUEUE_LABEL[queue]}:\n${await client.fila()}`);
      } catch (e) {
        parts.push(`${QUEUE_LABEL[queue]}: ❌ falha ao consultar (${(e as Error).message.slice(0, 150)})`);
      }
    }
    await safeReply(ctx, parts.join('\n\n'));
  });

  bot.command('status', async (ctx) => {
    try {
      const arg = ctx.match?.toString().trim();
      if (arg) {
        const ref = await resolveOrReply(ctx, arg);
        if (!ref) return;
        return safeReply(ctx, await clientFor(ref.queue, deps).status(ref.jobId));
      }
      const parts: string[] = [];
      for (const queue of ['video', 'texto'] as const) {
        try {
          parts.push(`${QUEUE_LABEL[queue]}:\n${await clientFor(queue, deps).stats()}`);
        } catch (e) {
          parts.push(`${QUEUE_LABEL[queue]}: ❌ falha ao consultar (${(e as Error).message.slice(0, 150)})`);
        }
      }
      await safeReply(ctx, parts.join('\n\n'));
    } catch (e) {
      await ctx.reply(`❌ falha ao consultar status: ${(e as Error).message.slice(0, 200)}`);
    }
  });

  bot.command('cancelar', async (ctx) => {
    try {
      const arg = ctx.match?.toString().trim();
      if (!arg) return ctx.reply('uso: /cancelar <id> (ex.: /cancelar V5 ou /cancelar T7)');
      const ref = await resolveOrReply(ctx, arg);
      if (!ref) return;
      await ctx.reply(await clientFor(ref.queue, deps).cancel(ref.jobId));
      deps.state.setStatus(ref.queue, ref.jobId, 'canceled');
    } catch (e) {
      await ctx.reply(`❌ falha ao cancelar: ${(e as Error).message.slice(0, 200)}`);
    }
  });

  bot.command('enviar', async (ctx) => {
    try {
      const arg = ctx.match?.toString().trim();
      if (!arg) return ctx.reply('uso: /enviar <id> (ex.: /enviar V5 ou /enviar T7)');
      const ref = await resolveOrReply(ctx, arg);
      if (!ref) return;
      const path = await clientFor(ref.queue, deps).getPath(ref.jobId);
      if (!path || !existsSync(path)) return ctx.reply(`${formatJobRef(ref)} ainda não tem arquivo pronto`);
      const size = statSync(path).size;
      if (size > MAX_SEND_BYTES) {
        const sizeMb = (size / 1e6).toFixed(0);
        if (cfg.fileServerBaseUrl) {
          try {
            const { url } = publishForDownload(path, cfg.entregasDir, cfg.fileServerBaseUrl);
            return ctx.reply(`arquivo tem ${sizeMb} MB (limite do bot: 50 MB)\n🔗 ${url}\n📁 no disco: ${path}`);
          } catch (e) {
            return ctx.reply(`arquivo tem ${sizeMb} MB (limite do bot: 50 MB)\n⚠️ falha ao publicar link (${(e as Error).message.slice(0, 150)})\n📁 no disco: ${path}`);
          }
        }
        return ctx.reply(`arquivo tem ${sizeMb} MB (limite do bot: 50 MB)\n📁 no disco: ${path}`);
      }
      await ctx.replyWithVideo(new InputFile(path));
    } catch (e) {
      await ctx.reply(`❌ falha ao enviar: ${(e as Error).message.slice(0, 200)}`);
    }
  });

  // /reel <caminho> [descrição] [| campos] — atalho explícito pra skill reel, pra não depender do
  // prefixo "reel:" (que se confunde com texto livre). Monta a linha "reel: ..." e entra no MESMO
  // fluxo (parseMessage → parseLine → submit) usado por texto e por legenda de anexo — nenhuma
  // lógica de enfileirar/copiar/mover é duplicada aqui.
  bot.command(['reel', 'reels'], async (ctx) => {
    try {
      const arg = ctx.match?.toString().trim() ?? '';
      if (!arg) {
        await ctx.reply('uso: /reel <caminho do avatar> [descrição] — ex.: /reel /home/user/avatar.mp4 quero com texto e imagem ilustrativa\nou anexe o MP4 com a legenda "/reel" (ou "reel").');
        return;
      }
      await processInstructionText(ctx, `reel: ${arg}`);
    } catch (e) {
      await ctx.reply(`❌ falha ao processar /reel: ${(e as Error).message.slice(0, 200)}`);
    }
  });

  bot.command('reelinematds', async (ctx) => {
    try {
      const arg = ctx.match?.toString().trim() ?? '';
      if (!arg) {
        await ctx.reply('uso: /reelinematds <caminho do bruto> [descrição] — ex.: /reelinematds /home/user/bruto.mp4 sem música\nou anexe o MP4 com a legenda "/reelinematds" (ou "reelinematds").');
        return;
      }
      await processInstructionText(ctx, `reelinematds: ${arg}`);
    } catch (e) {
      await ctx.reply(`❌ falha ao processar /reelinematds: ${(e as Error).message.slice(0, 200)}`);
    }
  });

  // /promoclub — fonte de instrução do pipeline inemaclubpromover (texto → HeyGen → reel → lives).
  bot.command('promoclub', async (ctx) => {
    try {
      if (!deps.promo) return void (await ctx.reply('❌ /promoclub não está configurado neste bot'));
      const cmd = parsePromoclubArg(ctx.match?.toString() ?? '');
      if (cmd.kind === 'error') return void (await safeReply(ctx, `❌ ${cmd.message}`));

      if (cmd.kind === 'status') {
        const states = cmd.assunto ? [loadState(cfg.promoDir, cmd.assunto)].filter((s): s is PromoState => s !== null) : listStates(cfg.promoDir);
        if (cmd.assunto && !states.length) return void (await ctx.reply(`não achei o assunto "${cmd.assunto}" — veja /promoclub status`));
        return void (await safeReply(ctx, statusText(states)));
      }

      if (cmd.kind === 'baixar') {
        const state = loadState(cfg.promoDir, cmd.assunto);
        if (!state) return void (await ctx.reply(`não achei o assunto "${cmd.assunto}" — veja /promoclub status`));
        const avisos = await baixarTick(state, cfg.promoDir, { heygen: deps.promo.heygen, enqueueReel: makeReelEnqueuer(cfg, deps), log });
        return void (await safeReply(ctx, avisos.join('\n') || '⏳ nenhum render novo pronto no HeyGen — nada baixado'));
      }

      // novo assunto
      const existing = loadState(cfg.promoDir, cmd.assunto);
      if (existing && Object.values(existing.publicos).some((i) => i.fase !== 'texto-pendente')) {
        return void (await safeReply(ctx, `já existe um assunto "${existing.assunto}" em andamento:\n\n${statusText([existing])}\n\nuse /promoclub baixar ${existing.assunto} ou apague ${cfg.promoDir}/state/${existing.slug}.json pra recomeçar`));
      }
      const state = existing ?? newPromoState(cmd.assunto, cmd.publicos, cmd.versao, ctx.chat!.id);
      saveState(cfg.promoDir, state);
      // Assunto em mensagem PRÓPRIA (pode ser um texto longo, tipo copy de campanha) — misturado
      // dentro de aspas na mesma linha da confirmação fica ilegível.
      await ctx.reply(cmd.assunto);
      await ctx.reply(`📝 gerando textos (${Object.keys(state.publicos).length} público(s), v${state.versao}) — leva alguns minutos, aviso quando terminar…`);
      const chatId = ctx.chat!.id;
      // Fase 1 roda fora do handler (claude -p demora); o resultado chega por sendMessage. Se a
      // fase 2 estiver configurada (fase2Runner presente), emenda automaticamente em seguida —
      // sem isso, fica só a fase 1 e o operador dispara a fase 2 manualmente como antes.
      void runFase1(state, cfg.promoDir, deps.promo.fase1, log)
        .then(async (msg) => {
          await bot.api.sendMessage(chatId, msg);
          const fase2 = deps.promo?.fase2;
          if (!fase2) return;
          const reloaded = loadState(cfg.promoDir, state.slug) ?? state;
          if (!Object.values(reloaded.publicos).some((i) => i.fase === 'aguardando-render')) return;
          const msg2 = await runFase2(reloaded, cfg.promoDir, fase2, deps.promo!.heygen, log);
          if (msg2) await bot.api.sendMessage(chatId, msg2);
        })
        .catch((e) => {
          log.error(`[promoclub] fase 1 (${state.slug}) não notificou: ${(e as Error).message}`);
          return bot.api.sendMessage(chatId, `❌ fase 1 de "${cmd.assunto}" falhou sem detalhe — veja o log do bot`).catch(() => {});
        });
    } catch (e) {
      await ctx.reply(`❌ falha no /promoclub: ${(e as Error).message.slice(0, 200)}`);
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

    // Ping é checado sob demanda (e só uma vez POR FILA) — uma PERGUNTA não precisa de fila
    // nenhuma viva (log + state local já bastam), e uma fila fora do ar nunca bloqueia a outra:
    // um submit de vídeo funciona normalmente mesmo com a fila de texto indisponível (e vice-versa).
    const pingCache = new Map<Queue, Promise<boolean>>();
    const ensurePing = (queue: Queue): Promise<boolean> => {
      let p = pingCache.get(queue);
      if (!p) { p = clientFor(queue, deps).ping(); pingCache.set(queue, p); }
      return p;
    };

    // `/reel <pasta>` (ou "reel: <pasta>"): o path resolvido é um DIRETÓRIO, não um MP4 — muda pro
    // modo pasta (um job de reel por vídeo, mesma descrição/flags pra todos). Path de arquivo
    // continua no fluxo normal (submit único), comportamento idêntico ao de antes.
    const submitInstr = async (instr: Instruction): Promise<void> => {
      if (instr.skill === 'reel' && isDirectoryPath(instr.input)) {
        replies.push(await submitReelFolder(instr, ctx.chat!.id, cfg, deps, ensurePing));
        return;
      }
      const queue = queueForSkill(instr.skill, deps.defs);
      if (!(await ensurePing(queue))) {
        replies.push(`⚠️ fila ${QUEUE_LABEL[queue]} indisponível — instrução NÃO enfileirada, tenta de novo depois`);
        return;
      }
      replies.push(await submit(instr, ctx.chat!.id, cfg, deps));
    };

    if (jobLines.length) {
      for (const instr of jobLines) {
        await submitInstr(instr);
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
            const answerCtx = await buildAnswerContext(ctx.chat!.id, deps.videoClient, deps.textoClient, deps.state, cfg.logFile, deps.defs, listDests(cfg.projetosDir));
            const answer = await answerQuestion(out.question, answerCtx, deps.claude);
            log.info(`[resposta] chat ${ctx.chat!.id}: ${truncate(answer)}`);
            replies.push(answer);
          } catch (e) {
            log.error(`[resposta] chat ${ctx.chat!.id} falhou: ${(e as Error).message}`);
            replies.push(`❌ não consegui responder agora: ${(e as Error).message.slice(0, 200)}`);
          }
        } else {
          for (const instr of out.instrs) {
            await submitInstr(withNote(instr, fileNote));
          }
          if (out.ignorado) {
            log.info(`[ignorado] chat ${ctx.chat!.id}: ${out.ignorado}`);
            replies.push(`⚠️ não vou fazer: ${out.ignorado}`);
          }
        }
      } catch (e) {
        log.error(`[interpret] chat ${ctx.chat!.id} falhou: ${(e as Error).message}`);
        replies.push(`❌ falha ao interpretar com Claude: ${(e as Error).message.slice(0, 200)}\nveja /help e /skills`);
      }
    }

    await safeReply(ctx, replies.join('\n\n') || 'nada pra fazer — manda /help');
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
      await safeReply(ctx, `recebi "${filename}" mas sem legenda não sei o que fazer com ele — manda de novo com uma instrução na legenda (ex.: "explicativo: resumo desse documento").\n\n${skillsText(deps.defs)}`);
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

    // Anexo de avatar pra `reel` (só funciona <20 MB — MP4 de avatar HeyGen costuma ser maior,
    // aí o caminho no disco é a via primária): legenda "reel" (ou "reel | campos"), SEM
    // "assunto:", já que o "input" do job é o próprio arquivo baixado, não uma nota anexada.
    const reelLine = reelCaptionLine(caption, localPath);
    if (reelLine) {
      await processInstructionText(ctx, reelLine);
      return;
    }
    const reelInematdsLine = reelInematdsCaptionLine(caption, localPath);
    if (reelInematdsLine) {
      await processInstructionText(ctx, reelInematdsLine);
      return;
    }

    await processInstructionText(ctx, caption, documentInstruction(localPath));
  });

  return bot;
}

/** Modo pasta do `/reel`: `instr.input` é um DIRETÓRIO (não um MP4) — lista os vídeos de topo (não
 * recursivo), e enfileira UM job de reel por vídeo, todos com a MESMA descrição/flags de `instr`
 * (visuais/dest/mover/reelDescricao), reusando `submit()` pra cada arquivo — nenhuma lógica de
 * enfileirar é duplicada. `ensurePing` é a mesma cache-por-fila de `processInstructionText`, pra
 * um ping só valer pra pasta inteira (não 1 ping por vídeo). */
export async function submitReelFolder(
  instr: Instruction,
  chatId: number,
  cfg: Config,
  deps: BotDeps,
  ensurePing: (queue: Queue) => Promise<boolean>,
): Promise<string> {
  const dir = instr.input;
  let files: string[];
  try {
    files = listVideoFiles(dir);
  } catch (e) {
    return `❌ não consegui ler a pasta "${dir}": ${(e as Error).message.slice(0, 200)}`;
  }
  if (files.length === 0) {
    return `📁 pasta "${dir}" não tem nenhum vídeo (.mp4/.mov/.m4v/.webm) — nada enfileirado`;
  }
  const queue = queueForSkill(instr.skill, deps.defs);
  if (!(await ensurePing(queue))) {
    return `⚠️ fila ${QUEUE_LABEL[queue]} indisponível — pasta "${dir}" com ${files.length} vídeo(s) NÃO enfileirada, tenta de novo depois`;
  }
  const refs: string[] = [];
  for (const file of files) {
    const result = await submit({ ...instr, input: file }, chatId, cfg, deps);
    const m = result.match(/([VT]#\d+)/);
    refs.push(m ? m[1] : '?');
  }
  const warn = files.length > REEL_BATCH_WARN_THRESHOLD
    ? `⚠️ ${files.length} vídeos — fila serializada (1 por vez), cada reel é um render longo, isso pode levar bastante tempo até o último terminar.\n`
    : '';
  const refsSummary = refs.length > 1 ? `${refs[0]}…${refs[refs.length - 1]}` : refs[0];
  return `${warn}📥 ${files.length} reel${files.length > 1 ? 's' : ''} na fila: ${refsSummary}`;
}

export async function submit(instr: Instruction, chatId: number, cfg: Config, deps: BotDeps): Promise<string> {
  const log = deps.log ?? consoleLogger();
  try {
    if (instr.pesquisa) {
      instr = { ...instr, input: `${instr.input}. ${RESEARCH_INSTRUCTION}` };
    }
    if (instr.transcrever) {
      instr = { ...instr, input: `${instr.input}. ${TRANSCRIPTION_INSTRUCTION}` };
    }
    if (instr.skill === 'reel') {
      const avatarPath = instr.input;
      instr = { ...instr, input: `${instr.input}. ${reelInstruction(avatarPath, Boolean(instr.visuais), instr.reelDescricao)}` };
    }
    if (instr.skill === 'reelinematds') {
      const brutoPath = instr.input;
      instr = { ...instr, input: `${instr.input}. ${reelInematdsInstruction(brutoPath, instr.reelDescricao)}` };
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
    const queue = queueForSkill(instr.skill, deps.defs);
    const jobId = await clientFor(queue, deps).add(buildAddArgs(instr, deps.defs));
    deps.state.track({ queue, jobId, chatId, dest: instr.dest, destToken: instr.destToken, pesquisa: instr.pesquisa, transcrever: instr.transcrever, narracaoPath, mover: instr.mover });
    const ref = formatJobRef({ queue, jobId });
    const isReel = instr.skill === 'reel';
    const isReelLike = isReel || instr.skill === 'reelinematds';
    const extras = [instr.vertical ? '9:16' : '16:9', instr.pesquisa ? 'com pesquisa 🔎' : null,
      instr.narracao ? 'com narração em texto 📝' : null, instr.transcrever ? 'transcrição pedida 🎙️' : null,
      isReel && instr.visuais ? 'modo 3 (visuais) 🎨' : null,
      instr.destToken ? `→ ${instr.destToken}${isReelLike ? (instr.mover ? ' (mover)' : ' (copiar)') : ''}` : null]
      .filter(Boolean).join(' · ');
    log.info(`[enfileirado] chat ${chatId}: ${ref} (${instr.skill})`);
    return `📥 ${ref} na fila (${instr.skill}) ${extras}\naviso aqui quando terminar`;
  } catch (e) {
    log.error(`[falha ao enfileirar] chat ${chatId}: ${(e as Error).message}`);
    return `❌ falhou ao enfileirar "${instr.input.slice(0, 60)}": ${(e as Error).message.slice(0, 200)}`;
  }
}
