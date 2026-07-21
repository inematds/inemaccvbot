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
  /** ID curto e estável pra referência (ex.: P#3). Atribuído na criação; backfill por criadoEm. */
  id?: number;
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
  | { kind: 'statuslog' }
  | { kind: 'statustext'; assunto: string }
  | { kind: 'baixar'; assunto: string }
  | { kind: 'error'; message: string };

/** `/promoclub <assunto> [| publicos=a,b] [| versao=N]` · `/promoclub status [assunto]` ·
 * `/promoclub statuslog` · `/promoclub statustext <assunto>` · `/promoclub baixar <assunto>`.
 * (statuslog/statustext vêm ANTES de status na alternância porque "status" é prefixo deles.) */
export function parsePromoclubArg(arg: string): PromoclubCmd {
  const trimmed = arg.trim();
  if (!trimmed) {
    return { kind: 'error', message: 'uso: /promoclub <assunto> [| publicos=a,b] [| versao=N]\nou /promoclub status · statuslog · statustext <assunto> · baixar <assunto>' };
  }
  const sub = trimmed.match(/^(statuslog|statustext|status|baixar)\b\s*(.*)$/i);
  if (sub) {
    const kw = sub[1].toLowerCase();
    const rest = sub[2].trim();
    if (kw === 'status') return { kind: 'status', assunto: rest || null };
    if (kw === 'statuslog') return { kind: 'statuslog' };
    if (kw === 'statustext') {
      if (!rest) return { kind: 'error', message: 'uso: /promoclub statustext <assunto>' };
      return { kind: 'statustext', assunto: rest };
    }
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
  const states = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as PromoState)
    .sort((a, b) => a.criadoEm.localeCompare(b.criadoEm));
  // Backfill de IDs faltantes (states antigos): numera por ordem de criação, salvando no disco.
  let max = states.reduce((m, s) => Math.max(m, s.id ?? 0), 0);
  for (const s of states) {
    if (s.id == null) { s.id = ++max; saveState(promoDir, s); }
  }
  return states;
}

/** Próximo ID livre pro pipeline promoclub (max existente + 1). */
export function nextPromoId(promoDir: string): number {
  return listStates(promoDir).reduce((m, s) => Math.max(m, s.id ?? 0), 0) + 1;
}

/** Resolve uma referência do usuário a um assunto: "P#3"/"#3"/"3" (por ID) ou slug/assunto. */
export function loadStateByRef(promoDir: string, ref: string): PromoState | null {
  const m = ref.trim().match(/^p?#?\s*(\d+)$/i);
  if (m) {
    const id = Number(m[1]);
    return listStates(promoDir).find((s) => s.id === id) ?? null;
  }
  return loadState(promoDir, ref);
}

// ---------- fase 1 (textos headless) ----------

export function buildFase1Prompt(state: PromoState): string {
  const pubs = Object.keys(state.publicos).join(', ');
  return [
    `Use a skill inemaclub-textos para gerar os roteiros do assunto P#${state.id ?? '?'} (${state.slug}) (slug ${state.slug})`,
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
    // Fase 1 = texto/copy: barata em token, qualidade importa. Fable em teste (alvo pode virar sonnet).
    await pExecFile('claude', ['--model', 'claude-fable-5', '--effort', 'low', '-p', prompt], { cwd, timeout: 30 * 60_000, maxBuffer: 100 * 1024 * 1024 });
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
    return `❌ fase 1 (textos) falhou pra P#${state.id ?? '?'} (${state.slug}): ${(e as Error).message.slice(0, 200)}\nconserta e roda de novo: /promoclub ${state.assunto}`;
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
  const lines = [`📝 P#${state.id ?? '?'} · textos prontos (${ok.length}/${Object.keys(state.publicos).length} públicos) — assunto "${state.slug}"`];
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
    `Use a skill heygen-avatar-nei-III para gerar os vídeos de avatar do assunto P#${state.id ?? '?'} (${state.slug})`,
    `(slug ${state.slug}), para os públicos: ${publicos.join(', ')}, versão v${state.versao}`,
    `(seção FALA de textos/${state.slug}/<publico>.md). Troque o look da cena pelo look de cada`,
    'público (tabela da skill) antes de gerar cada vídeo. Gere todos os vídeos listados, um de',
    'cada vez, sem pedir confirmação a cada um — já está autorizado pelo usuário. Títulos exatos',
    `a usar:\n${titulos}\n`,
    'SELEÇÃO DE NAVEGADOR — regra dura (você está HEADLESS, ninguém responde pergunta):',
    'se houver MAIS DE UM navegador conectado, NÃO pergunte qual usar — selecione',
    'AUTOMATICAMENTE o navegador LOCAL/Linux desta máquina (o que tem uma aba em',
    'app.heygen.com aberta; o remoto/Windows NÃO é ele) via list_connected_browsers +',
    'select_browser, e siga. Perguntar aqui = falhar, porque não há humano pra responder.',
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

/** `claude --chrome -p` — a fase 2 é sempre navegador (extensão Claude pareada, Chromium logado no
 * HeyGen). Com a Opção B (Xvfb dedicado no :99) o navegador vive num display virtual sempre ativo,
 * então NÃO é preciso focar janela (o antigo passo `wmctrl` foi removido — não funcionava sob
 * mutter e é inútil no :99). A seleção do navegador certo (local/Linux) é instruída no prompt.
 * Timeout bem largo: até 11 renders no estúdio, um de cada vez. */
export function defaultFase2Runner(log: Logger = consoleLogger()): Fase2Runner {
  return async (prompt, cwd) => {
    // RESET obrigatório do :99 antes de cada fase 2: sem isso, abas de runs anteriores se
    // acumulam e o editor do HeyGen abre em aba de fundo (hidden) → digitação rejeitada
    // (visto em produção 2026-07-19). Restart volta o Chromium pra UMA aba (Projects).
    try {
      await pExecFile('systemctl', ['--user', 'restart', 'stack99.service'], { timeout: 60_000 });
      // 45s: Chromium bootar (~12s) + extensão reconectar ao native host + HeyGen carregar.
      // 15s era curto → claude --chrome achava "sem navegador conectado" (visto em produção 2026-07-20).
      await new Promise((r) => setTimeout(r, 45_000));
    } catch (e) {
      log.error(`[promoclub] fase 2: falha ao resetar stack99 (${(e as Error).message}) — seguindo mesmo assim`);
    }
    // Fase 2 = navegador+visão: Sonnet (forte em computer-use, mais barato/token que Opus/Fable).
    const { stdout } = await pExecFile('claude', ['--chrome', '--model', 'sonnet', '--effort', 'low', '-p', prompt], { cwd, timeout: 120 * 60_000, maxBuffer: 100 * 1024 * 1024 });
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
/** FILA da fase 2 (série): o navegador :99 é EXCLUSIVO — só uma fase 2 pode usar por vez. Sem
 * isso, N assuntos mandados juntos disparam N `claude --chrome -p` concorrentes que brigam pelo
 * navegador e todos falham (visto em produção 2026-07-21: 5 assuntos → 5 colisões, 0 vídeos).
 * Este promise-chain garante que cada runFase2 só começa quando a anterior terminou. */
let fase2Fila: Promise<unknown> = Promise.resolve();
/** slug do assunto cuja fase 2 está EXECUTANDO agora (null = nenhuma). Pra /fila mostrar. */
let fase2Rodando: string | null = null;
export function fase2Atual(): string | null { return fase2Rodando; }

export async function runFase2(
  state: PromoState, promoDir: string, runner: Fase2Runner, heygen: HeygenClient, log: Logger = consoleLogger(),
): Promise<string> {
  const publicos = Object.entries(state.publicos).filter(([, i]) => i.fase === 'aguardando-render').map(([p]) => p);
  if (!publicos.length) return '';
  // Entra na fila: espera qualquer fase 2 em andamento terminar antes de tocar no navegador.
  const anterior = fase2Fila;
  let liberar!: () => void;
  fase2Fila = new Promise<void>((r) => { liberar = r; });
  await anterior.catch(() => {});
  fase2Rodando = state.slug;
  try {
    return await runFase2Interno(state, promoDir, publicos, runner, heygen, log);
  } finally {
    fase2Rodando = null;
    liberar();
  }
}

/** Resumo do pipeline promoclub para /fila e /status: o que está rodando (fase 2) e o que falta. */
export function filaPromoText(states: PromoState[]): string {
  const incompletos = states.filter((s) => !isComplete(s));
  const rodando = fase2Rodando;
  const lines = [`📣 Pipeline INEMA.club — ${incompletos.length} assunto(s) em andamento`];
  if (rodando) lines.push(`▶️ fase 2 rodando: ${rodando}`);
  else if (incompletos.length) lines.push('▶️ fase 2 rodando: — (aguardando disparo)');
  for (const s of incompletos) {
    const c: Record<string, number> = {};
    for (const v of Object.values(s.publicos)) c[v.fase] = (c[v.fase] || 0) + 1;
    const feitos = c['reel-enfileirado'] || 0;
    const total = Object.keys(s.publicos).length;
    const marca = s.slug === rodando ? '▶️' : '⏳';
    const detalhe = Object.entries(c).map(([f, n]) => `${n} ${FASE_ICON[f as PromoFase]}`).join(' · ');
    lines.push(`${marca} P#${s.id ?? '?'} · ${s.slug} — ${feitos}/${total} reels\n     ${detalhe}`);
  }
  if (!incompletos.length) lines.push('(nenhum assunto pendente — tudo completo)');
  return lines.join('\n');
}

async function runFase2Interno(
  state: PromoState, promoDir: string, publicos: string[], runner: Fase2Runner, heygen: HeygenClient, log: Logger,
): Promise<string> {
  log.info(`[promoclub] fase 2 iniciando (${state.slug}): ${publicos.length} público(s) — disparando claude --chrome -p`);
  let stdout = '';
  try {
    stdout = await runner(buildFase2Prompt(state, publicos), promoDir);
    log.info(`[promoclub] fase 2 (${state.slug}): processo terminou, verificando no HeyGen. saída (início): ${stdout.slice(0, 500)}`);
  } catch (e) {
    log.error(`[promoclub] fase 2 falhou (${state.slug}): ${(e as Error).message}`);
    return `❌ fase 2 (avatar) falhou pra P#${state.id ?? '?'} (${state.slug}): ${(e as Error).message.slice(0, 200)}\nconfira o navegador (Chromium aberto + logado no HeyGen) e rode de novo, ou renderize manualmente e depois use /promoclub baixar P#${state.id ?? state.slug}`;
  }
  const titulos = publicos.map((p) => state.publicos[p].titulo);
  let found: Map<string, { videoId: string; status: string }>;
  try {
    found = await heygen.listByTitle(titulos);
  } catch (e) {
    log.error(`[promoclub] fase 2 (${state.slug}): verificação no HeyGen falhou: ${(e as Error).message}`);
    return `⚠️ fase 2 (avatar) rodou pra P#${state.id ?? '?'} (${state.slug}), mas não consegui confirmar no HeyGen (consulta falhou: ${(e as Error).message.slice(0, 120)}) — confira manualmente com /promoclub status ou no site.`;
  }
  const criados = titulos.filter((t) => found.has(t));
  const faltando = titulos.filter((t) => !found.has(t));
  log.info(`[promoclub] fase 2 (${state.slug}): verificação HeyGen — ${criados.length}/${titulos.length} confirmados`);
  if (!criados.length) {
    log.error(`[promoclub] fase 2 (${state.slug}): claude reportou sucesso mas NENHUM vídeo apareceu no HeyGen — saída completa do processo:\n${stdout.slice(0, 5000)}`);
    return `❌ fase 2 (avatar) de P#${state.id ?? '?'} (${state.slug}) reportou sucesso mas nenhum vídeo apareceu no HeyGen — o navegador provavelmente não conectou de verdade. Renderize manualmente (skill heygen-avatar-nei-III numa sessão \`claude --chrome\` interativa) ou tente de novo. Detalhe no log do bot.`;
  }
  if (faltando.length) {
    return `⚠️ fase 2 (avatar) parcial pra P#${state.id ?? '?'} (${state.slug}): ${criados.length}/${titulos.length} apareceram no HeyGen. Faltando: ${faltando.join(', ')}. O watcher segue os que já apareceram; rode de novo ou renderize manualmente os que faltaram.`;
  }
  return `✅ fase 2 (avatar) concluída pra P#${state.id ?? '?'} (${state.slug}) — ${criados.length} renders confirmados no HeyGen (não só reportados, verificados de verdade). O watcher segue sozinho (baixar + reel) assim que cada um terminar. /promoclub status pra acompanhar.`;
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
      avisos.push(`❌ ${info.titulo}: ${(e as Error).message.slice(0, 150)} — vou tentar de novo no próximo tick; se persistir, conserta e usa /promoclub baixar P#${state.id ?? state.slug}`);
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

/** Um assunto está COMPLETO quando todos os públicos chegaram ao estado final (reel na fila). */
export function isComplete(state: PromoState): boolean {
  const pubs = Object.values(state.publicos);
  return pubs.length > 0 && pubs.every((i) => i.fase === 'reel-enfileirado');
}

const FASE_LABEL_CURTO: Record<PromoFase, string> = {
  'texto-pendente': 'fase 1 (textos)',
  'aguardando-render': 'fase 2 (avatares)',
  baixado: 'fase 2.5 (baixando)',
  'reel-enfileirado': 'fase 3 (reels)',
};

/** Uma linha de estágio/% de um assunto: "45% · 5/11 reels · fase 2 (avatares)". */
export function estagioResumo(s: PromoState): string {
  const c: Record<string, number> = {};
  for (const v of Object.values(s.publicos)) c[v.fase] = (c[v.fase] || 0) + 1;
  const total = Object.keys(s.publicos).length;
  const feitos = c['reel-enfileirado'] || 0;
  const pct = total ? Math.round((feitos / total) * 100) : 0;
  if (feitos === total && total > 0) return `✅ 100% pronto (${total}/${total} reels)`;
  const ordem: PromoFase[] = ['texto-pendente', 'aguardando-render', 'baixado', 'reel-enfileirado'];
  const atras = ordem.find((f) => (c[f] || 0) > 0 && f !== 'reel-enfileirado') ?? 'reel-enfileirado';
  return `${pct}% · ${feitos}/${total} reels · ${FASE_LABEL_CURTO[atras]}`;
}

/** Lista COMPACTA (id + slug + estágio/%), uma linha por assunto. Com 1 assunto, mostra o detalhe
 * por público (drill-down de `/promoclub status P#N`). */
export function statusText(states: PromoState[]): string {
  if (!states.length) return 'nenhum assunto ativo — comece com /promoclub <assunto>';
  if (states.length === 1) return statusDetalhe(states[0]);
  const lines = states.map((s) => `P#${s.id ?? '?'} · ${s.slug.slice(0, 46)}\n   ${estagioResumo(s)}`);
  return [`📣 ${states.length} assunto(s):`, ...lines].join('\n');
}

/** Detalhe por público de UM assunto (id no topo + fase de cada público). */
export function statusDetalhe(s: PromoState): string {
  const total = Object.keys(s.publicos).length;
  const feitos = Object.values(s.publicos).filter((i) => i.fase === 'reel-enfileirado').length;
  const lines = Object.entries(s.publicos).map(([pub, i]) => {
    const extra = i.fase === 'reel-enfileirado' && i.reelJob != null ? ` (V#${i.reelJob} → ${i.lives})` : '';
    return `  ${pub}: ${FASE_ICON[i.fase]}${extra}`;
  });
  return [
    `📣 P#${s.id ?? '?'} · ${s.slug} (v${s.versao})`,
    `${feitos}/${total} reels · ${estagioResumo(s)}`,
    ...lines,
  ].join('\n');
}

// ---------- statustext (roteiros / FALA por canal) ----------

/** Extrai a seção FALA da versão `versao` de um arquivo de texto da fase 1. O arquivo tem
 * `## Versão N`, e dentro de cada versão um `### FALA ...` seguido do texto até o próximo `###`.
 * Devolve null se a versão ou a FALA não forem encontradas. */
export function extractFala(md: string, versao: number): string | null {
  const verRe = new RegExp(`^##\\s*Vers[aã]o\\s*${versao}\\b`, 'im');
  const verMatch = verRe.exec(md);
  if (!verMatch) return null;
  const afterVer = md.slice(verMatch.index + verMatch[0].length);
  const falaRe = /^###\s*FALA\b[^\n]*\n/im;
  const falaMatch = falaRe.exec(afterVer);
  if (!falaMatch) return null;
  const afterFala = afterVer.slice(falaMatch.index + falaMatch[0].length);
  const endRe = /^\s*#{2,3}\s/m; // próximo cabeçalho (### SOBREPOSIÇÕES, ## Versão, ## ESTRUTURA…)
  const endMatch = endRe.exec(afterFala);
  const fala = (endMatch ? afterFala.slice(0, endMatch.index) : afterFala).trim();
  return fala || null;
}

/** Lista SÓ as FALAs (roteiros da fase 1) de cada público/canal de um assunto, uma seção por
 * canal, com divisória clara. Pode passar do limite do Telegram — o chamador usa safeReply. */
export function textosText(state: PromoState, promoDir: string): string {
  const blocks = Object.entries(state.publicos).map(([pub, info]) => {
    const file = join(promoDir, 'textos', state.slug, `${pub}.md`);
    let fala: string | null = null;
    if (existsSync(file)) {
      try { fala = extractFala(readFileSync(file, 'utf8'), state.versao); } catch { fala = null; }
    }
    const canal = `━━━ ${pub} → ${info.lives} ━━━`;
    return `${canal}\n${fala ?? `(sem texto — arquivo ausente ou FALA v${state.versao} não encontrada)`}`;
  });
  return [`📝 P#${state.id ?? '?'} · roteiros (FALA v${state.versao}) — ${state.slug}`, '', ...blocks].join('\n\n');
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
