import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { submit, createBot, type BotDeps } from './bot.js';
import { StateStore } from './state.js';
import type { Config } from './config.js';
import type { Instruction } from './parser.js';
import type { SkillDef } from './skills.js';

const DEFS: SkillDef[] = [
  { command: 'explicativo', mkiSkill: 'explicativo', description: 'vídeo explicativo', example: 'explicativo: X' },
];

const narracoesDir = join(tmpdir(), 'inemaccvbot-test-narracoes');
const cfg = { projetosDir: '/tmp', narracoesDir } as Config;

beforeEach(() => rmSync(narracoesDir, { recursive: true, force: true }));
afterEach(() => rmSync(narracoesDir, { recursive: true, force: true }));

function makeDeps(addedArgs: string[][]): BotDeps {
  return {
    client: { add: async (args: string[]) => { addedArgs.push(args); return 1; }, ping: async () => true } as any,
    state: new StateStore(':memory:'),
    defs: DEFS,
    interpret: (async () => ({ ok: false, error: 'n/a' })) as any,
    claude: (async () => '') as any,
  };
}

const baseInstr: Instruction = {
  skill: 'explicativo', input: 'IA na saúde', vertical: false, dest: null, destToken: null, pesquisa: false, narracao: false, transcrever: false,
};

describe('submit', () => {
  it('anexa a instrução de pesquisa ao input do job quando pesquisa=true', async () => {
    const addedArgs: string[][] = [];
    const deps = makeDeps(addedArgs);
    await submit({ ...baseInstr, pesquisa: true }, 1, cfg, deps);
    const jobInput = addedArgs[0][2]; // ['add', mkiSkill, input, ...]
    expect(jobInput).toContain('IA na saúde');
    expect(jobInput.toLowerCase()).toContain('pesquise');
    expect(jobInput).not.toMatch(/\n/);
    expect(jobInput.split(/\s+/).some((tok) => tok.startsWith('--'))).toBe(false);
  });

  it('não anexa nada ao input quando pesquisa=false', async () => {
    const addedArgs: string[][] = [];
    const deps = makeDeps(addedArgs);
    await submit({ ...baseInstr, pesquisa: false }, 1, cfg, deps);
    const jobInput = addedArgs[0][2];
    expect(jobInput).toBe('IA na saúde');
  });

  it('narracao=true anexa instrução com caminho absoluto sem espaço, sem quebra de linha e sem token "--"', async () => {
    const addedArgs: string[][] = [];
    const deps = makeDeps(addedArgs);
    await submit({ ...baseInstr, narracao: true }, 1, cfg, deps);
    const jobInput = addedArgs[0][2];
    expect(jobInput).toContain('IA na saúde');
    expect(jobInput.toLowerCase()).toContain('narração');
    expect(jobInput).not.toMatch(/\n/);
    expect(jobInput.split(/\s+/).some((tok) => tok.startsWith('--'))).toBe(false);
    const match = jobInput.match(/"([^"]+)"/);
    expect(match).not.toBeNull();
    const path = match![1];
    expect(path).not.toMatch(/\s/);
    expect(path.startsWith(narracoesDir)).toBe(true);
    expect(path.endsWith('.txt')).toBe(true);
    expect(existsSync(narracoesDir)).toBe(true); // mkdirSync criou o diretório
  });

  it('narracao=true grava o caminho da narração no state', async () => {
    const addedArgs: string[][] = [];
    const deps = makeDeps(addedArgs);
    await submit({ ...baseInstr, narracao: true }, 1, cfg, deps);
    const tracked = deps.state.get(1);
    expect(tracked?.narracaoPath).toBeTruthy();
    expect(tracked!.narracaoPath!.startsWith(narracoesDir)).toBe(true);
  });

  it('narracao=false não grava caminho de narração no state', async () => {
    const addedArgs: string[][] = [];
    const deps = makeDeps(addedArgs);
    await submit({ ...baseInstr, narracao: false }, 1, cfg, deps);
    expect(deps.state.get(1)?.narracaoPath).toBeNull();
  });

  it('NARRACOES_DIR com espaço falha o submit em vez de corromper o job', async () => {
    const addedArgs: string[][] = [];
    const deps = makeDeps(addedArgs);
    const badCfg = { ...cfg, narracoesDir: '/tmp/dir com espaco' } as Config;
    const result = await submit({ ...baseInstr, narracao: true }, 1, badCfg, deps);
    expect(result).toContain('❌');
    expect(addedArgs).toHaveLength(0);
  });

  it('transcrever=true anexa a instrução de transcrição ao input do job, sem quebra de linha e sem token "--"', async () => {
    const addedArgs: string[][] = [];
    const deps = makeDeps(addedArgs);
    await submit({ ...baseInstr, transcrever: true }, 1, cfg, deps);
    const jobInput = addedArgs[0][2];
    expect(jobInput).toContain('IA na saúde');
    expect(jobInput.toLowerCase()).toContain('transcreva');
    expect(jobInput.toLowerCase()).toContain('inemavox');
    expect(jobInput).not.toMatch(/\n/);
    expect(jobInput.split(/\s+/).some((tok) => tok.startsWith('--'))).toBe(false);
  });

  it('transcrever=false não anexa nada ao input do job', async () => {
    const addedArgs: string[][] = [];
    const deps = makeDeps(addedArgs);
    await submit({ ...baseInstr, transcrever: false }, 1, cfg, deps);
    const jobInput = addedArgs[0][2];
    expect(jobInput).toBe('IA na saúde');
  });

  it('transcrever grava a flag no state', async () => {
    const addedArgs: string[][] = [];
    const deps = makeDeps(addedArgs);
    await submit({ ...baseInstr, transcrever: true }, 1, cfg, deps);
    expect(deps.state.get(1)?.transcrever).toBe(true);
  });

  it('combina transcrever + narracao + destino (livesN) num único job, sem newline e sem token "--"', async () => {
    const addedArgs: string[][] = [];
    const deps = makeDeps(addedArgs);
    await submit({ ...baseInstr, transcrever: true, narracao: true, destToken: 'lives3' }, 1, cfg, deps);
    const jobInput = addedArgs[0][2];
    expect(jobInput).toContain('IA na saúde');
    expect(jobInput.toLowerCase()).toContain('transcreva');
    expect(jobInput.toLowerCase()).toContain('narração');
    expect(jobInput).not.toMatch(/\n/);
    expect(jobInput.split(/\s+/).some((tok) => tok.startsWith('--'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Testes de integração do bot: usamos bot.handleUpdate() (sem long polling, sem rede) com um
// transformer no bot.api que intercepta TODA chamada à API do Telegram (sendMessage etc.) — nunca
// bate na rede real. `botInfo` é setado manualmente pra pular o `getMe()` que `bot.init()` faria.
// ---------------------------------------------------------------------------------------------
const anexosDir = join(tmpdir(), 'inemaccvbot-test-anexos');
const fullCfg = {
  botToken: 'TEST:TOKEN', allowedChatIds: [1], projetosDir: '/tmp',
  narracoesDir, anexosDir, logFile: join(tmpdir(), 'inemaccvbot-test.log'),
} as Config;

let msgId = 0;
function textUpdate(chatId: number, text: string): any {
  msgId += 1;
  return {
    update_id: msgId,
    message: {
      message_id: msgId, date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: 'private' }, from: { id: chatId, is_bot: false, first_name: 'u' },
      text,
    },
  };
}

function documentUpdate(chatId: number, doc: { file_name?: string; file_size?: number; file_id?: string }, caption?: string): any {
  msgId += 1;
  return {
    update_id: msgId,
    message: {
      message_id: msgId, date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: 'private' }, from: { id: chatId, is_bot: false, first_name: 'u' },
      document: { file_id: doc.file_id ?? 'FILE_ID', file_unique_id: 'U1', file_name: doc.file_name, file_size: doc.file_size },
      caption,
    },
  };
}

function wireBot(botDeps: BotDeps): { bot: ReturnType<typeof createBot>; sent: string[] } {
  const bot = createBot(fullCfg, botDeps);
  bot.botInfo = { id: 999, is_bot: true, first_name: 'bot', username: 'inemaccvbot', can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false } as any;
  const sent: string[] = [];
  bot.api.config.use((_prev, method, payload) => {
    if (method === 'sendMessage') sent.push((payload as any).text ?? '');
    return Promise.resolve({ ok: true, result: {} } as any);
  });
  return { bot, sent };
}

describe('bot — pergunta sobre capacidades (bug: recusada mesmo sendo respondível)', () => {
  it('"você consegue transcrever o áudio de um reel?" é respondida, NÃO recusada, e NÃO enfileira nada', async () => {
    const addedArgs: string[][] = [];
    const deps = makeDeps(addedArgs);
    deps.interpret = (async () => ({ ok: true, kind: 'question', question: 'você consegue transcrever o áudio de um reel do Instagram?' })) as any;
    deps.claude = (async () => 'Não, hoje eu só crio vídeos das skills registradas (explicativo) — não transcrevo áudio nem vídeo de terceiros.') as any;
    const { bot, sent } = wireBot(deps);
    await bot.handleUpdate(textUpdate(1, 'você consegue transcrever o áudio de um reel do Instagram?'));
    const finalReply = sent[sent.length - 1];
    expect(finalReply).not.toContain('❌');
    expect(finalReply.toLowerCase()).toContain('não');
    expect(addedArgs).toHaveLength(0);
  });

  it('"jogue xadrez comigo" continua recusado', async () => {
    const addedArgs: string[][] = [];
    const deps = makeDeps(addedArgs);
    deps.interpret = (async () => ({ ok: false, error: 'não é pedido de vídeo nem pergunta sobre o serviço/capacidades' })) as any;
    const { bot, sent } = wireBot(deps);
    await bot.handleUpdate(textUpdate(1, 'jogue xadrez comigo'));
    const finalReply = sent[sent.length - 1];
    expect(finalReply).toContain('❌');
    expect(addedArgs).toHaveLength(0);
  });
});

describe('bot — message:document (bug: anexo sem resposta nenhuma)', () => {
  beforeEach(() => rmSync(anexosDir, { recursive: true, force: true }));
  afterEach(() => rmSync(anexosDir, { recursive: true, force: true }));

  it('documento com legenda no formato estrito enfileira com o caminho do arquivo anexado ao input', async () => {
    const addedArgs: string[][] = [];
    const deps = makeDeps(addedArgs);
    deps.client = { ...deps.client, ping: async () => true } as any;
    deps.downloadDocument = (async (_fileId: string, filename: string) => join(anexosDir, `123-${filename}`)) as any;
    const { bot, sent } = wireBot(deps);
    await bot.handleUpdate(documentUpdate(1, { file_name: 'notas.md', file_size: 1000 }, 'explicativo: resumo desse documento'));
    expect(addedArgs).toHaveLength(1);
    const jobInput = addedArgs[0][2];
    expect(jobInput).toContain('resumo desse documento');
    expect(jobInput).toContain(join(anexosDir, '123-notas.md'));
    expect(jobInput).not.toMatch(/\n/);
    expect(jobInput.split(/\s+/).some((tok) => tok.startsWith('--'))).toBe(false);
    expect(sent.some((s) => s.includes('📥'))).toBe(true);
  });

  it('documento SEM legenda pergunta o que fazer e NÃO enfileira nada', async () => {
    const addedArgs: string[][] = [];
    const deps = makeDeps(addedArgs);
    let downloadCalled = false;
    deps.downloadDocument = (async () => { downloadCalled = true; return '/never'; }) as any;
    const { bot, sent } = wireBot(deps);
    await bot.handleUpdate(documentUpdate(1, { file_name: 'notas.md', file_size: 1000 }));
    expect(addedArgs).toHaveLength(0);
    expect(downloadCalled).toBe(false);
    expect(sent.some((s) => s.toLowerCase().includes('legenda'))).toBe(true);
  });

  it('documento GRANDE demais é recusado com mensagem clara e NÃO enfileira nada nem baixa', async () => {
    const addedArgs: string[][] = [];
    const deps = makeDeps(addedArgs);
    let downloadCalled = false;
    deps.downloadDocument = (async () => { downloadCalled = true; return '/never'; }) as any;
    const { bot, sent } = wireBot(deps);
    await bot.handleUpdate(documentUpdate(1, { file_name: 'video-gigante.md', file_size: 6 * 1024 * 1024 }, 'explicativo: resumo'));
    expect(addedArgs).toHaveLength(0);
    expect(downloadCalled).toBe(false);
    expect(sent.some((s) => s.includes('❌'))).toBe(true);
  });

  it('chat fora do allowlist não recebe NENHUMA resposta a um documento (mantém o silêncio do allowlist)', async () => {
    const addedArgs: string[][] = [];
    const deps = makeDeps(addedArgs);
    const { bot, sent } = wireBot(deps);
    await bot.handleUpdate(documentUpdate(999, { file_name: 'notas.md', file_size: 1000 }, 'explicativo: x'));
    expect(sent).toHaveLength(0);
    expect(addedArgs).toHaveLength(0);
  });
});
