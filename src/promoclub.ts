import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { consoleLogger, type Logger } from './log.js';

const pExecFile = promisify(execFile);

/** Faixa reservada pelo usuário (2026-07-18): lives21..31, um canal por público. */
export const PUBLICO_LIVES: Record<string, string> = {
  'pessoa-comum': 'lives21', jovens: 'lives22', profissionais: 'lives23', mulheres: 'lives24',
  empreendedores: 'lives25', tecnicos: 'lives26', '40mais': 'lives27', '60mais': 'lives28',
  educadores: 'lives29', criadores: 'lives30', recolocacao: 'lives31',
};

/** Gatilho/promessa de cada público (tabela da skill inemaclub-textos) — vira a
 * headline-choque da capa de impacto do reel. */
export const PUBLICO_GATILHO: Record<string, string> = {
  'pessoa-comum': 'Você usa IA do jeito preguiçoso; dá pra fazer muito melhor com truques simples.',
  jovens: 'Você pode começar uma profissão que ainda está nascendo.',
  profissionais: 'Não abandone sua profissão. Aprenda a ampliá-la com IA.',
  mulheres: 'Use a IA para conquistar autonomia, produtividade e novas oportunidades.',
  empreendedores: 'Transforme IA em redução de custos, vendas e novos negócios.',
  tecnicos: 'Pare de apenas testar ferramentas. Aprenda a construir sistemas e agentes.',
  '40mais': 'Sua experiência vale mais quando é multiplicada pela IA.',
  '60mais': 'A IA pode transformar sua experiência de vida em conhecimento, renda e propósito.',
  educadores: 'Você não vai ser substituído pela IA — mas pode ser o professor que ensina com ela.',
  criadores: 'Pare de pagar ferramenta cara. Monte sua própria fábrica de conteúdo com IA.',
  recolocacao: 'Perdeu o emprego ou quer mudar de área? A IA pode ser o atalho do seu recomeço.',
};

export const TODOS_PUBLICOS = Object.keys(PUBLICO_LIVES);

export type PromoFase = 'texto-pendente' | 'aguardando-render' | 'baixado' | 'reel-enfileirado';

export interface PromoPublico {
  lives: string;
  titulo: string;
  fase: PromoFase;
  arquivo?: string;
  reelJob?: number;
}

export interface PromoState {
  assunto: string;
  slug: string;
  versao: number;
  chatId: number;
  criadoEm: string;
  publicos: Record<string, PromoPublico>;
}

export function slugAssunto(assunto: string): string {
  return assunto
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'sem-assunto';
}

export type PromoclubCmd =
  | { kind: 'novo'; assunto: string; publicos: string[]; versao: number }
  | { kind: 'status'; assunto: string | null }
  | { kind: 'baixar'; assunto: string }
  | { kind: 'error'; message: string };

/** `/promoclub <assunto> [| publicos=a,b] [| versao=N]` · `/promoclub status [assunto]` ·
 * `/promoclub baixar <assunto>`. */
export function parsePromoclubArg(arg: string): PromoclubCmd {
  const trimmed = arg.trim();
  if (!trimmed) {
    return { kind: 'error', message: 'uso: /promoclub <assunto> [| publicos=a,b] [| versao=N]\nou /promoclub status [assunto] · /promoclub baixar <assunto>' };
  }
  const sub = trimmed.match(/^(status|baixar)\b\s*(.*)$/i);
  if (sub) {
    const rest = sub[2].trim();
    if (sub[1].toLowerCase() === 'status') return { kind: 'status', assunto: rest || null };
    if (!rest) return { kind: 'error', message: 'uso: /promoclub baixar <assunto>' };
    return { kind: 'baixar', assunto: rest };
  }
  const fields = trimmed.split('|').map((s) => s.trim());
  const assunto = fields.shift() ?? '';
  if (!assunto) return { kind: 'error', message: 'faltou o assunto' };
  let publicos = TODOS_PUBLICOS;
  let versao = 1;
  for (const f of fields.filter(Boolean)) {
    const pub = f.match(/^publicos?\s*=\s*(.+)$/i);
    if (pub) {
      const list = pub[1].split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
      const invalid = list.filter((p) => !PUBLICO_LIVES[p]);
      if (invalid.length) return { kind: 'error', message: `público(s) desconhecido(s): ${invalid.join(', ')} — válidos: ${TODOS_PUBLICOS.join(', ')}` };
      publicos = list;
      continue;
    }
    const ver = f.match(/^versao\s*=\s*(\d+)$/i);
    if (ver) {
      versao = Number(ver[1]);
      if (versao < 1 || versao > 3) return { kind: 'error', message: 'versao deve ser 1, 2 ou 3' };
      continue;
    }
    return { kind: 'error', message: `campo desconhecido: "${f}" — use publicos=a,b e/ou versao=N` };
  }
  return { kind: 'novo', assunto, publicos, versao };
}

export function newPromoState(assunto: string, publicos: string[], versao: number, chatId: number): PromoState {
  const slug = slugAssunto(assunto);
  const state: PromoState = { assunto, slug, versao, chatId, criadoEm: new Date().toISOString(), publicos: {} };
  for (const p of publicos) {
    state.publicos[p] = { lives: PUBLICO_LIVES[p], titulo: `${slug}-${p}-v${versao}`, fase: 'texto-pendente' };
  }
  return state;
}

// ---------- persistência (um JSON por assunto em <promoDir>/state/) ----------

function stateDir(promoDir: string): string { return join(promoDir, 'state'); }
function statePath(promoDir: string, slug: string): string { return join(stateDir(promoDir), `${slug}.json`); }

export function saveState(promoDir: string, state: PromoState): void {
  mkdirSync(stateDir(promoDir), { recursive: true });
  writeFileSync(statePath(promoDir, state.slug), JSON.stringify(state, null, 2));
}

export function loadState(promoDir: string, slugOrAssunto: string): PromoState | null {
  const slug = slugAssunto(slugOrAssunto);
  const p = statePath(promoDir, slug);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8')) as PromoState;
}

export function listStates(promoDir: string): PromoState[] {
  const dir = stateDir(promoDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as PromoState)
    .sort((a, b) => a.criadoEm.localeCompare(b.criadoEm));
}

// ---------- fase 1 (textos headless) ----------

export function buildFase1Prompt(state: PromoState): string {
  const pubs = Object.keys(state.publicos).join(', ');
  return [
    `Use a skill inemaclub-textos para gerar os roteiros do assunto "${state.assunto}" (slug ${state.slug})`,
    `para os públicos: ${pubs}. 3 versões por público, em textos/${state.slug}/<publico>.md`,
    '(seções FALA / SOBREPOSIÇÕES / ESTRUTURA, como a skill manda).',
    'Ao final, faça git add dos arquivos gerados e um commit (autor inematds <inematds@gmail.com>)',
    'com mensagem curta descrevendo o assunto. NÃO faça push. NÃO gere vídeos (fase 2 é outra etapa).',
  ].join(' ');
}

export type Fase1Runner = (prompt: string, cwd: string) => Promise<void>;

/** `claude -p` com cwd no inemaclubpromover — mesmo padrão do agente de render do mkivideos.
 * Timeout largo: escrever 11 arquivos de roteiro leva vários minutos. */
export function defaultFase1Runner(): Fase1Runner {
  return async (prompt, cwd) => {
    await pExecFile('claude', ['-p', prompt], { cwd, timeout: 30 * 60_000, maxBuffer: 100 * 1024 * 1024 });
  };
}

/** Roda a fase 1 e marca os públicos que ganharam arquivo de texto. Não lança: devolve o
 * resumo pro chamador responder no chat (falha inclui a instrução de conserto — regra do projeto). */
export async function runFase1(
  state: PromoState, promoDir: string, runner: Fase1Runner, log: Logger = consoleLogger(),
): Promise<string> {
  log.info(`[promoclub] fase 1 iniciando (${state.slug}): ${Object.keys(state.publicos).length} público(s)`);
  try {
    await runner(buildFase1Prompt(state), promoDir);
  } catch (e) {
    log.error(`[promoclub] fase 1 falhou (${state.slug}): ${(e as Error).message}`);
    return `❌ fase 1 (textos) falhou pra "${state.assunto}": ${(e as Error).message.slice(0, 200)}\nconserta e roda de novo: /promoclub ${state.assunto}`;
  }
  const ok: string[] = [];
  const faltou: string[] = [];
  for (const [pub, info] of Object.entries(state.publicos)) {
    if (existsSync(join(promoDir, 'textos', state.slug, `${pub}.md`))) {
      info.fase = 'aguardando-render';
      ok.push(pub);
    } else {
      faltou.push(pub);
    }
  }
  saveState(promoDir, state);
  log.info(`[promoclub] fase 1 concluída (${state.slug}): ${ok.length} ok, ${faltou.length} faltando`);
  const titulos = ok.map((p) => `  • ${state.publicos[p].titulo}`).join('\n');
  const lines = [`📝 textos prontos (${ok.length}/${Object.keys(state.publicos).length} públicos) — assunto "${state.slug}"`];
  if (faltou.length) lines.push(`⚠️ sem arquivo de texto: ${faltou.join(', ')} — roda de novo ou confere no repo`);
  if (ok.length) {
    lines.push('', '🎬 iniciando a fase 2 automaticamente (render no HeyGen, Avatar III) dos títulos:', titulos,
      '', 'o watcher detecta cada render pronto e segue sozinho (baixar + reel). /promoclub status pra acompanhar.');
  }
  return lines.join('\n');
}

// ---------- fase 2 (avatar HeyGen, via navegador) ----------

export function buildFase2Prompt(state: PromoState, publicos: string[]): string {
  const titulos = publicos.map((p) => `  • ${state.publicos[p].titulo} (público: ${p})`).join('\n');
  return [
    `Use a skill heygen-avatar-nei-III para gerar os vídeos de avatar do assunto "${state.assunto}"`,
    `(slug ${state.slug}), para os públicos: ${publicos.join(', ')}, versão v${state.versao}`,
    `(seção FALA de textos/${state.slug}/<publico>.md). Troque o look da cena pelo look de cada`,
    'público (tabela da skill) antes de gerar cada vídeo. Gere todos os vídeos listados, um de',
    'cada vez, sem pedir confirmação a cada um — já está autorizado pelo usuário. Títulos exatos',
    `a usar:\n${titulos}\n`,
    'Se qualquer render travar (navegador não conecta, HeyGen deslogado, aba presa em hidden,',
    'Avatar III indisponível), pare e reporte exatamente o que travou — não insista em loop nem',
    'falhe em silêncio. IMPORTANTE: só afirme que um vídeo foi gerado se você de fato usou as',
    'tools de navegador e viu o vídeo aparecer em Meus Projetos do HeyGen. Se você não tiver',
    'acesso a tools de navegador nesta execução, NÃO diga que gerou nada — reporte exatamente',
    'isso ("sem acesso a navegador nesta execução") e pare. Nunca declare sucesso sem ter',
    'verificado de fato.',
  ].join(' ');
}

/** Devolve o stdout do processo — usado só pra log em caso de sucesso "fantasma" (ver runFase2). */
export type Fase2Runner = (prompt: string, cwd: string) => Promise<string>;

/** Traz a janela do Chromium pra frente/foco (via wmctrl) antes de disparar a fase 2 — sem isso a
 * aba do HeyGen fica `document.visibilityState === 'hidden'` e a skill se recusa a digitar
 * (visto em produção, 2026-07-19). Best-effort: se `wmctrl` faltar ou não achar a janela, só loga
 * e segue — o subagente ainda reporta o bloqueio, e a verificação no HeyGen pega o resto. */
async function raiseChromiumWindow(log: Logger): Promise<void> {
  try {
    await pExecFile('wmctrl', ['-a', 'Chromium'], { timeout: 10_000 });
  } catch (e) {
    log.error(`[promoclub] fase 2: não consegui focar o Chromium via wmctrl (${(e as Error).message}) — seguindo mesmo assim`);
  }
}

/** `claude --chrome -p` — a fase 2 é sempre navegador (extensão Claude in Chrome/Edge pareada,
 * Chromium aberto e logado no HeyGen); sem isso o comando falha e o erro vira aviso no chat.
 * Timeout bem largo: até 11 renders manuais no estúdio, um de cada vez. */
export function defaultFase2Runner(log: Logger = consoleLogger()): Fase2Runner {
  return async (prompt, cwd) => {
    await raiseChromiumWindow(log);
    const { stdout } = await pExecFile('claude', ['--chrome', '-p', prompt], { cwd, timeout: 120 * 60_000, maxBuffer: 100 * 1024 * 1024 });
    return stdout;
  };
}

/** Roda a fase 2 pros públicos que ficaram 'aguardando-render' após a fase 1. Não lança: devolve
 * o resumo pro chamador responder no chat (falha inclui a instrução de conserto). String vazia =
 * nada a fazer (nenhum público pendente).
 *
 * IMPORTANTE: o subagente (`claude --chrome -p`) pode reportar sucesso sem ter feito nada de
 * verdade — ex.: o navegador não conectou de fato numa chamada headless, mas a IA "declarou
 * sucesso" em vez de reportar a falha (visto em produção, 2026-07-19). Por isso NUNCA confiar só
 * no retorno do processo: sempre verificar direto na API do HeyGen se os títulos realmente
 * apareceram antes de dizer "concluído". */
export async function runFase2(
  state: PromoState, promoDir: string, runner: Fase2Runner, heygen: HeygenClient, log: Logger = consoleLogger(),
): Promise<string> {
  const publicos = Object.entries(state.publicos).filter(([, i]) => i.fase === 'aguardando-render').map(([p]) => p);
  if (!publicos.length) return '';
  log.info(`[promoclub] fase 2 iniciando (${state.slug}): ${publicos.length} público(s) — disparando claude --chrome -p`);
  let stdout = '';
  try {
    stdout = await runner(buildFase2Prompt(state, publicos), promoDir);
    log.info(`[promoclub] fase 2 (${state.slug}): processo terminou, verificando no HeyGen. saída (início): ${stdout.slice(0, 500)}`);
  } catch (e) {
    log.error(`[promoclub] fase 2 falhou (${state.slug}): ${(e as Error).message}`);
    return `❌ fase 2 (avatar) falhou pra "${state.assunto}": ${(e as Error).message.slice(0, 200)}\nconfira o navegador (Chromium aberto + logado no HeyGen) e rode de novo, ou renderize manualmente e depois use /promoclub baixar ${state.assunto}`;
  }
  const titulos = publicos.map((p) => state.publicos[p].titulo);
  let found: Map<string, { videoId: string; status: string }>;
  try {
    found = await heygen.listByTitle(titulos);
  } catch (e) {
    log.error(`[promoclub] fase 2 (${state.slug}): verificação no HeyGen falhou: ${(e as Error).message}`);
    return `⚠️ fase 2 (avatar) rodou pra "${state.assunto}", mas não consegui confirmar no HeyGen (consulta falhou: ${(e as Error).message.slice(0, 120)}) — confira manualmente com /promoclub status ou no site.`;
  }
  const criados = titulos.filter((t) => found.has(t));
  const faltando = titulos.filter((t) => !found.has(t));
  log.info(`[promoclub] fase 2 (${state.slug}): verificação HeyGen — ${criados.length}/${titulos.length} confirmados`);
  if (!criados.length) {
    log.error(`[promoclub] fase 2 (${state.slug}): claude reportou sucesso mas NENHUM vídeo apareceu no HeyGen — saída completa do processo:\n${stdout.slice(0, 5000)}`);
    return `❌ fase 2 (avatar) de "${state.assunto}" reportou sucesso mas nenhum vídeo apareceu no HeyGen — o navegador provavelmente não conectou de verdade. Renderize manualmente (skill heygen-avatar-nei-III numa sessão \`claude --chrome\` interativa) ou tente de novo. Detalhe no log do bot.`;
  }
  if (faltando.length) {
    return `⚠️ fase 2 (avatar) parcial pra "${state.assunto}": ${criados.length}/${titulos.length} apareceram no HeyGen. Faltando: ${faltando.join(', ')}. O watcher segue os que já apareceram; rode de novo ou renderize manualmente os que faltaram.`;
  }
  return `✅ fase 2 (avatar) concluída pra "${state.assunto}" — ${criados.length} renders confirmados no HeyGen (não só reportados, verificados de verdade). O watcher segue sozinho (baixar + reel) assim que cada um terminar. /promoclub status pra acompanhar.`;
}

// ---------- HeyGen (fase 2.5 — consulta e download, sem custo) ----------

export interface HeygenClient {
  /** título → status ('completed' | outro) dos vídeos mais recentes da conta. */
  listByTitle: (titles: string[]) => Promise<Map<string, { videoId: string; status: string }>>;
  /** video_url de um vídeo pronto. */
  videoUrl: (videoId: string) => Promise<string | null>;
  download: (url: string, destPath: string) => Promise<void>;
}

function heygenKey(envPath: string): string {
  const env: Record<string, string> = {};
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  const key = env.HEYGEN_API_KEY;
  if (!key) throw new Error(`HEYGEN_API_KEY não encontrada em ${envPath}`);
  return key;
}

export function defaultHeygenClient(envPath: string): HeygenClient {
  return {
    listByTitle: async (titles) => {
      const key = heygenKey(envPath);
      const r = await fetch('https://api.heygen.com/v1/video.list?limit=100', { headers: { 'X-Api-Key': key, Accept: 'application/json' } });
      if (!r.ok) throw new Error(`video.list HTTP ${r.status}`);
      const data = (await r.json()) as { data?: { videos?: { video_id: string; video_title: string; status: string }[] } };
      const wanted = new Set(titles);
      const out = new Map<string, { videoId: string; status: string }>();
      for (const v of data.data?.videos ?? []) {
        if (wanted.has(v.video_title) && !out.has(v.video_title)) out.set(v.video_title, { videoId: v.video_id, status: v.status });
      }
      return out;
    },
    videoUrl: async (videoId) => {
      const key = heygenKey(envPath);
      const r = await fetch(`https://api.heygen.com/v1/video_status.get?video_id=${videoId}`, { headers: { 'X-Api-Key': key } });
      if (!r.ok) throw new Error(`video_status.get HTTP ${r.status}`);
      const data = (await r.json()) as { data?: { video_url?: string } };
      return data.data?.video_url ?? null;
    },
    download: async (url, destPath) => {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`download HTTP ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      if (!buf.length) throw new Error('download vazio');
      writeFileSync(destPath, buf);
    },
  };
}

// ---------- fase 2.5 + 3 (baixar e enfileirar reel) ----------

/** Enfileira o reel de um avatar baixado — implementado no index.ts via submit() do bot
 * (skill `reel`, capa impacto + gatilho do público, dest livesN). Devolve o jobId ou lança. */
export type ReelEnqueuer = (arquivo: string, publico: string, state: PromoState) => Promise<number>;

export interface BaixarDeps {
  heygen: HeygenClient;
  enqueueReel: ReelEnqueuer;
  log?: Logger;
}

/** Instrução extra do job de reel — capa de impacto personalizada pelo gatilho do público. */
export function reelDescricaoFor(publico: string): string {
  const gatilho = PUBLICO_GATILHO[publico] ?? '';
  return `capa impacto, público ${publico}: headline-choque baseada no gatilho "${gatilho}", use as SOBREPOSIÇÕES do texto da fase 1 quando disponíveis, legenda palavra-a-palavra, CTA fixo Saiba mais no inema.club`;
}

/** Uma passada de fase 2.5+3 num assunto: baixa cada render `completed` ainda não baixado e
 * enfileira o reel. Muta e salva o state. Devolve as linhas de aviso (vazio = nada mudou). */
export async function baixarTick(state: PromoState, promoDir: string, deps: BaixarDeps): Promise<string[]> {
  const log = deps.log ?? consoleLogger();
  const pendentes = Object.entries(state.publicos).filter(([, i]) => i.fase === 'aguardando-render');
  if (!pendentes.length) return [];
  let found: Map<string, { videoId: string; status: string }>;
  try {
    found = await deps.heygen.listByTitle(pendentes.map(([, i]) => i.titulo));
  } catch (e) {
    log.error(`[promoclub] video.list falhou (${state.slug}): ${(e as Error).message}`);
    return [`⚠️ consulta ao HeyGen falhou: ${(e as Error).message.slice(0, 150)}`];
  }
  const avisos: string[] = [];
  for (const [pub, info] of pendentes) {
    const hit = found.get(info.titulo);
    if (!hit || hit.status !== 'completed') continue;
    try {
      const url = await deps.heygen.videoUrl(hit.videoId);
      if (!url) { avisos.push(`⚠️ ${info.titulo}: completed mas sem video_url (tenta de novo no próximo tick)`); continue; }
      const dir = join(promoDir, 'output', state.slug, 'avatares');
      mkdirSync(dir, { recursive: true });
      const destPath = join(dir, `${info.titulo}.mp4`);
      await deps.heygen.download(url, destPath);
      info.arquivo = destPath;
      info.fase = 'baixado';
      saveState(promoDir, state);
      const jobId = await deps.enqueueReel(destPath, pub, state);
      info.reelJob = jobId;
      info.fase = 'reel-enfileirado';
      saveState(promoDir, state);
      avisos.push(`🎬 ${info.titulo}: render detectado → baixado → reel V#${jobId} na fila (${info.lives})`);
    } catch (e) {
      log.error(`[promoclub] baixar/enfileirar falhou (${info.titulo}): ${(e as Error).message}`);
      avisos.push(`❌ ${info.titulo}: ${(e as Error).message.slice(0, 150)} — vou tentar de novo no próximo tick; se persistir, conserta e usa /promoclub baixar ${state.assunto}`);
    }
  }
  return avisos;
}

// ---------- status ----------

const FASE_ICON: Record<PromoFase, string> = {
  'texto-pendente': '✍️ texto pendente',
  'aguardando-render': '⏳ aguardando render no HeyGen',
  baixado: '📥 baixado',
  'reel-enfileirado': '🎞 reel na fila',
};

export function statusText(states: PromoState[]): string {
  if (!states.length) return 'nenhum assunto ativo — comece com /promoclub <assunto>';
  const blocks = states.map((s) => {
    const lines = Object.entries(s.publicos).map(([pub, i]) => {
      const extra = i.fase === 'reel-enfileirado' && i.reelJob != null ? ` (V#${i.reelJob} → ${i.lives})` : '';
      return `  ${pub}: ${FASE_ICON[i.fase]}${extra}`;
    });
    return [`📣 ${s.assunto} (v${s.versao})`, ...lines].join('\n');
  });
  return blocks.join('\n\n');
}

// ---------- watcher ----------

export interface PromoWatcherDeps {
  promoDir: string;
  baixar: BaixarDeps;
  notify: (chatId: number, text: string) => Promise<void>;
  log?: Logger;
}

export async function promoTick(deps: PromoWatcherDeps): Promise<void> {
  const log = deps.log ?? consoleLogger();
  for (const state of listStates(deps.promoDir)) {
    const temPendente = Object.values(state.publicos).some((i) => i.fase === 'aguardando-render');
    if (!temPendente) continue;
    const avisos = await baixarTick(state, deps.promoDir, deps.baixar);
    // Só o que MUDOU vira notificação — "⚠️ consulta falhou" a cada tick viraria spam, então
    // avisos de erro transiente só entram no log; falha persistente aparece no /promoclub status.
    const relevantes = avisos.filter((a) => a.startsWith('🎬') || a.startsWith('❌'));
    if (!relevantes.length) continue;
    try {
      await deps.notify(state.chatId, relevantes.join('\n'));
    } catch (e) {
      log.error(`[promoclub] notify falhou (${state.slug}): ${(e as Error).message}`);
    }
  }
}

export function startPromoWatcher(deps: PromoWatcherDeps, intervalMs: number): () => void {
  const h = setInterval(() => { void promoTick(deps).catch((e) => (deps.log ?? consoleLogger()).error(`[promoclub] tick: ${(e as Error).message}`)); }, intervalMs);
  return () => clearInterval(h);
}
