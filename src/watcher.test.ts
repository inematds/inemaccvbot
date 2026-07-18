import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { tick, doneMessage, failMessage, formatDuration, applyReelDest, type WatcherDeps, type QueueSource } from './watcher.js';
import { StateStore } from './state.js';
import type { MkiJob } from './queue-client.js';

const narrDir = join(tmpdir(), 'inemaccvbot-test-watcher-narracoes');
const reelDir = join(tmpdir(), 'inemaccvbot-test-watcher-reel');
beforeEach(() => {
  rmSync(narrDir, { recursive: true, force: true }); mkdirSync(narrDir, { recursive: true });
  rmSync(reelDir, { recursive: true, force: true }); mkdirSync(reelDir, { recursive: true });
});
afterEach(() => {
  rmSync(narrDir, { recursive: true, force: true });
  rmSync(reelDir, { recursive: true, force: true });
});

const mkJob = (over: Partial<MkiJob>): MkiJob => ({
  id: 1, skill: 'explicativo', input: 'X', opts: null,
  status: 'queued', result_path: null, error: null, ...over,
});

/** Helper: watcher com só a fila de vídeo viva (a maioria dos testes é sobre uma fila só).
 * `jobs`/`jobById` seguem a mesma assinatura de antes — só embrulhados em QueueSource[]. */
function videoOnly(src: Partial<QueueSource>, notify: WatcherDeps['notify'], extra: Partial<WatcherDeps> = {}): WatcherDeps {
  return {
    queues: [{ queue: 'video', jobs: src.jobs ?? (async () => []), jobById: src.jobById }],
    state: extra.state as StateStore,
    notify,
    ...extra,
  };
}

describe('tick', () => {
  it('notifica done uma única vez e marca o estado, com id prefixado V#', async () => {
    const state = new StateStore(':memory:');
    state.track({ queue: 'video', jobId: 1, chatId: 77, dest: '/d/videos', destToken: 'lives3', pesquisa: false });
    const sent: string[] = [];
    const deps = videoOnly(
      { jobs: async () => [mkJob({ id: 1, status: 'done' as const, result_path: '/d/videos/mkivideo-1.mp4' })] },
      async (_chat, text) => { sent.push(text); },
      { state },
    );
    await tick(deps);
    await tick(deps); // segunda rodada não repete
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('V#1');
    expect(sent[0]).toContain('mkivideo-1.mp4');
    expect(sent[0]).toContain('lives3');
    expect(state.get('video', 1)?.lastStatus).toBe('done');
  });
  it('notifica failed com o erro, id prefixado', async () => {
    const state = new StateStore(':memory:');
    state.track({ queue: 'video', jobId: 2, chatId: 77, dest: null, destToken: null, pesquisa: false });
    const sent: string[] = [];
    await tick(videoOnly(
      { jobs: async () => [mkJob({ id: 2, status: 'failed' as const, error: 'render explodiu' })] },
      async (_c, t) => { sent.push(t); },
      { state },
    ));
    expect(sent[0]).toContain('V#2');
    expect(sent[0]).toContain('render explodiu');
    expect(state.get('video', 2)?.lastStatus).toBe('failed');
  });
  it('running só atualiza status, sem notificar', async () => {
    const state = new StateStore(':memory:');
    state.track({ queue: 'video', jobId: 3, chatId: 77, dest: null, destToken: null, pesquisa: false });
    const sent: string[] = [];
    await tick(videoOnly({ jobs: async () => [mkJob({ id: 3, status: 'running' as const })] }, async (_c, t) => { sent.push(t); }, { state }));
    expect(sent).toHaveLength(0);
    expect(state.get('video', 3)?.lastStatus).toBe('running');
  });
  it('erro no poll não derruba (fila fora do ar)', async () => {
    const state = new StateStore(':memory:');
    state.track({ queue: 'video', jobId: 4, chatId: 77, dest: null, destToken: null, pesquisa: false });
    await expect(tick(videoOnly({ jobs: async () => { throw new Error('down'); } }, async () => {}, { state }))).resolves.toBeUndefined();
  });
  it('job fora da janela de 50 usa jobById como fallback e notifica', async () => {
    const state = new StateStore(':memory:');
    state.track({ queue: 'video', jobId: 8, chatId: 77, dest: null, destToken: null, pesquisa: false });
    const sent: string[] = [];
    await tick(videoOnly(
      {
        jobs: async () => [], // job #8 caiu fora da janela
        jobById: async (id) => (id === 8 ? mkJob({ id: 8, status: 'done' as const, result_path: '/v/mkivideo-8.mp4' }) : undefined),
      },
      async (_c, t) => { sent.push(t); },
      { state },
    ));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('mkivideo-8.mp4');
    expect(state.get('video', 8)?.lastStatus).toBe('done');
  });
  it('sem jobById e job fora da janela: fica pendente, sem crash', async () => {
    const state = new StateStore(':memory:');
    state.track({ queue: 'video', jobId: 9, chatId: 77, dest: null, destToken: null, pesquisa: false });
    await tick(videoOnly({ jobs: async () => [] }, async () => {}, { state }));
    expect(state.pending().map((p) => p.jobId)).toContain(9);
  });
  it('notify falha em job done: job continua pendente, status não é persistido, e uma tick seguinte com notify funcionando entrega a mensagem exatamente uma vez', async () => {
    const state = new StateStore(':memory:');
    state.track({ queue: 'video', jobId: 6, chatId: 77, dest: '/d/videos', destToken: 'lives3', pesquisa: false });
    const job = mkJob({ id: 6, status: 'done' as const, result_path: '/d/videos/mkivideo-6.mp4' });
    const jobsFn = async () => [job];

    await tick(videoOnly({ jobs: jobsFn }, async () => { throw new Error('rate limit'); }, { state }));
    expect(state.pending().map((p) => p.jobId)).toContain(6);
    expect(state.get('video', 6)?.lastStatus).not.toBe('done');

    const sent: string[] = [];
    await tick(videoOnly({ jobs: jobsFn }, async (_c, t) => { sent.push(t); }, { state }));
    expect(sent).toHaveLength(1);
    expect(state.get('video', 6)?.lastStatus).toBe('done');

    // uma terceira rodada não deve reenviar
    await tick(videoOnly({ jobs: jobsFn }, async (_c, t) => { sent.push(t); }, { state }));
    expect(sent).toHaveLength(1);
  });

  it('job done com narracaoPath existente: notifica e entrega a narração via sendNarration', async () => {
    const state = new StateStore(':memory:');
    const narrPath = join(narrDir, 'roteiro.txt');
    writeFileSync(narrPath, 'era uma vez um roteiro');
    state.track({ queue: 'video', jobId: 20, chatId: 77, dest: null, destToken: null, pesquisa: false, transcrever: false, narracaoPath: narrPath });
    const sent: string[] = [];
    const narrated: string[] = [];
    await tick(videoOnly(
      { jobs: async () => [mkJob({ id: 20, status: 'done' as const, result_path: '/v/v.mp4' })] },
      async (_c, t) => { sent.push(t); },
      { state, sendNarration: async (_c, p) => { narrated.push(p); } },
    ));
    expect(sent[0]).toContain('enviando a seguir');
    expect(narrated).toEqual([narrPath]);
    expect(state.get('video', 20)?.lastStatus).toBe('done');
  });

  it('job done com narracaoPath mas arquivo não existe: avisa claramente e não chama sendNarration', async () => {
    const state = new StateStore(':memory:');
    const narrPath = join(narrDir, 'nao-existe.txt');
    state.track({ queue: 'video', jobId: 21, chatId: 77, dest: null, destToken: null, pesquisa: false, transcrever: false, narracaoPath: narrPath });
    const sent: string[] = [];
    let narrationCalled = false;
    await tick(videoOnly(
      { jobs: async () => [mkJob({ id: 21, status: 'done' as const, result_path: '/v/v.mp4' })] },
      async (_c, t) => { sent.push(t); },
      { state, sendNarration: async () => { narrationCalled = true; } },
    ));
    expect(sent[0]).toContain('não gerou o arquivo');
    expect(sent[0]).not.toContain('enviando a seguir');
    expect(narrationCalled).toBe(false);
  });

  it('sem sendNarration dep, tick continua funcionando normalmente mesmo com narracaoPath', async () => {
    const state = new StateStore(':memory:');
    const narrPath = join(narrDir, 'roteiro2.txt');
    writeFileSync(narrPath, 'texto');
    state.track({ queue: 'video', jobId: 22, chatId: 77, dest: null, destToken: null, pesquisa: false, transcrever: false, narracaoPath: narrPath });
    const sent: string[] = [];
    await tick(videoOnly({ jobs: async () => [mkJob({ id: 22, status: 'done' as const, result_path: '/v/v.mp4' })] }, async (_c, t) => { sent.push(t); }, { state }));
    expect(sent).toHaveLength(1);
    expect(state.get('video', 22)?.lastStatus).toBe('done');
  });

  it('falha no sendNarration não derruba nem reverte a notificação principal já entregue', async () => {
    const state = new StateStore(':memory:');
    const narrPath = join(narrDir, 'roteiro3.txt');
    writeFileSync(narrPath, 'texto');
    state.track({ queue: 'video', jobId: 23, chatId: 77, dest: null, destToken: null, pesquisa: false, transcrever: false, narracaoPath: narrPath });
    const sent: string[] = [];
    await tick(videoOnly(
      { jobs: async () => [mkJob({ id: 23, status: 'done' as const, result_path: '/v/v.mp4' })] },
      async (_c, t) => { sent.push(t); },
      { state, sendNarration: async () => { throw new Error('falha de rede'); } },
    ));
    expect(sent).toHaveLength(1);
    expect(state.get('video', 23)?.lastStatus).toBe('done');
  });

  it('V#5 e T#5 (mesma jobId, filas diferentes) notificam independentemente, cada um exatamente uma vez', async () => {
    const state = new StateStore(':memory:');
    state.track({ queue: 'video', jobId: 5, chatId: 77, dest: null, destToken: null, pesquisa: false });
    state.track({ queue: 'texto', jobId: 5, chatId: 77, dest: null, destToken: null, pesquisa: false });
    const sent: string[] = [];
    const deps: WatcherDeps = {
      queues: [
        { queue: 'video', jobs: async () => [mkJob({ id: 5, status: 'done' as const, result_path: '/v/v.mp4', skill: 'explicativo' })] },
        { queue: 'texto', jobs: async () => [mkJob({ id: 5, status: 'done' as const, result_path: '/t/t.txt', skill: 'transcrever' })] },
      ],
      state,
      notify: async (_c, t) => { sent.push(t); },
    };
    await tick(deps);
    await tick(deps); // segunda rodada não repete nenhum dos dois
    expect(sent).toHaveLength(2);
    expect(sent.some((s) => s.includes('V#5'))).toBe(true);
    expect(sent.some((s) => s.includes('T#5'))).toBe(true);
    expect(state.get('video', 5)?.lastStatus).toBe('done');
    expect(state.get('texto', 5)?.lastStatus).toBe('done');
  });

  it('poll de uma fila falhar não impede a notificação da outra fila', async () => {
    const state = new StateStore(':memory:');
    state.track({ queue: 'video', jobId: 30, chatId: 77, dest: null, destToken: null, pesquisa: false });
    state.track({ queue: 'texto', jobId: 31, chatId: 77, dest: null, destToken: null, pesquisa: false });
    const sent: string[] = [];
    const deps: WatcherDeps = {
      queues: [
        { queue: 'video', jobs: async () => { throw new Error('vídeo fora do ar'); } },
        { queue: 'texto', jobs: async () => [mkJob({ id: 31, status: 'done' as const, result_path: '/t/t.txt' })] },
      ],
      state,
      notify: async (_c, t) => { sent.push(t); },
    };
    await tick(deps);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('T#31');
    expect(state.get('texto', 31)?.lastStatus).toBe('done');
    expect(state.get('video', 30)?.lastStatus).not.toBe('done');
  });
});

describe('doneMessage', () => {
  const trackedVideo = (over: Partial<Parameters<typeof doneMessage>[1]>) => ({
    queue: 'video' as const, jobId: 5, chatId: 1, dest: null, destToken: null, pesquisa: false,
    transcrever: false, narracaoPath: null, mover: false, lastStatus: 'running', createdAt: '', ...over,
  });

  it('sempre inclui o caminho em disco (result_path) claramente rotulado com 📁', () => {
    const msg = doneMessage(
      mkJob({ id: 40, status: 'done', result_path: '/d/videos/mkivideo-40.mp4' }),
      trackedVideo({ jobId: 40 }),
    );
    expect(msg).toContain('📄 /d/videos/mkivideo-40.mp4');
  });

  it('avisa quando o resultado NÃO caiu no destino pedido', () => {
    const msg = doneMessage(
      mkJob({ id: 5, status: 'done', result_path: '/outro/lugar/v.mp4' }),
      trackedVideo({ dest: '/d/videos', destToken: 'lives3' }),
    );
    expect(msg).toContain('/outro/lugar/v.mp4');
    expect(msg.toLowerCase()).toContain('fora do destino');
  });
  it('não trata diretório irmão com prefixo igual como dentro do destino', () => {
    const msg = doneMessage(
      mkJob({ id: 7, status: 'done', result_path: '/x/videos-old/f.mp4' }),
      trackedVideo({ jobId: 7, dest: '/x/videos', destToken: 'lives3' }),
    );
    expect(msg).toContain('/x/videos-old/f.mp4');
    expect(msg.toLowerCase()).toContain('fora do destino');
  });
  it('inclui a duração quando started_at/finished_at estão presentes', () => {
    const msg = doneMessage(
      mkJob({ id: 9, status: 'done', result_path: '/v/v.mp4', started_at: 1000, finished_at: 1000 + 62 }),
      trackedVideo({ jobId: 9 }),
    );
    expect(msg).toContain('1m');
  });
  it('omite a duração quando algum timestamp falta', () => {
    const msg = doneMessage(
      mkJob({ id: 10, status: 'done', result_path: '/v/v.mp4' }),
      trackedVideo({ jobId: 10 }),
    );
    expect(msg).not.toContain('duração');
  });
  it('marca "com pesquisa" quando o job foi enfileirado com pesquisa', () => {
    const msg = doneMessage(
      mkJob({ id: 11, status: 'done', result_path: '/v/v.mp4' }),
      trackedVideo({ jobId: 11, pesquisa: true }),
    );
    expect(msg).toContain('com pesquisa');
  });
  it('não menciona pesquisa quando o job não foi enfileirado com pesquisa', () => {
    const msg = doneMessage(
      mkJob({ id: 12, status: 'done', result_path: '/v/v.mp4' }),
      trackedVideo({ jobId: 12 }),
    );
    expect(msg).not.toContain('pesquisa');
  });
  it('marca transcrição pedida (não afirma sucesso) quando o job foi enfileirado com transcrever', () => {
    const msg = doneMessage(
      mkJob({ id: 16, status: 'done', result_path: '/v/v.mp4' }),
      trackedVideo({ jobId: 16, transcrever: true }),
    );
    expect(msg.toLowerCase()).toContain('transcrição');
    expect(msg.toLowerCase()).toContain('pedida');
  });
  it('não menciona transcrição quando o job não foi enfileirado com transcrever', () => {
    const msg = doneMessage(
      mkJob({ id: 17, status: 'done', result_path: '/v/v.mp4' }),
      trackedVideo({ jobId: 17 }),
    );
    expect(msg.toLowerCase()).not.toContain('transcrição');
  });
  it('narracaoPath setado + disponível: avisa que vai enviar', () => {
    const msg = doneMessage(
      mkJob({ id: 13, status: 'done', result_path: '/v/v.mp4' }),
      trackedVideo({ jobId: 13, narracaoPath: '/x/n.txt' }),
      true,
    );
    expect(msg).toContain('enviando a seguir');
  });
  it('narracaoPath setado + indisponível: avisa claramente que nada foi entregue', () => {
    const msg = doneMessage(
      mkJob({ id: 14, status: 'done', result_path: '/v/v.mp4' }),
      trackedVideo({ jobId: 14, narracaoPath: '/x/n.txt' }),
      false,
    );
    expect(msg).toContain('não gerou o arquivo');
    expect(msg).not.toContain('enviando a seguir');
  });
  it('sem narracaoPath: nenhuma menção à narração', () => {
    const msg = doneMessage(
      mkJob({ id: 15, status: 'done', result_path: '/v/v.mp4' }),
      trackedVideo({ jobId: 15 }),
    );
    expect(msg).not.toContain('narração');
  });
  it('id prefixado com V# pra job de vídeo, T# pra job de texto', () => {
    const msgVideo = doneMessage(mkJob({ id: 5, status: 'done', result_path: '/v/v.mp4' }), trackedVideo({ jobId: 5 }));
    expect(msgVideo).toContain('V#5');
    const msgTexto = doneMessage(mkJob({ id: 5, status: 'done', result_path: '/t/t.txt' }), trackedVideo({ jobId: 5, queue: 'texto' }));
    expect(msgTexto).toContain('T#5');
  });
});

describe('reel — copy vs move (watcher, não CLI)', () => {
  it('applyReelDest COPIA por default: original permanece, cópia aparece no destino', () => {
    const src = join(reelDir, 'origem', 'reel-1.mp4');
    mkdirSync(join(reelDir, 'origem'), { recursive: true });
    writeFileSync(src, 'conteudo do reel');
    const dest = join(reelDir, 'destino');
    const outcome = applyReelDest(src, dest, false);
    expect(outcome).toEqual({ mode: 'copy', ok: true });
    expect(existsSync(src)).toBe(true);
    expect(existsSync(join(dest, 'reel-1.mp4'))).toBe(true);
  });

  it('applyReelDest com mover=true MOVE: original some, arquivo aparece no destino', () => {
    const src = join(reelDir, 'origem2', 'reel-2.mp4');
    mkdirSync(join(reelDir, 'origem2'), { recursive: true });
    writeFileSync(src, 'conteudo do reel');
    const dest = join(reelDir, 'destino2');
    const outcome = applyReelDest(src, dest, true);
    expect(outcome).toEqual({ mode: 'move', ok: true });
    expect(existsSync(src)).toBe(false);
    expect(existsSync(join(dest, 'reel-2.mp4'))).toBe(true);
  });

  it('applyReelDest falha (origem inexistente): reporta erro, não finge sucesso', () => {
    const outcome = applyReelDest(join(reelDir, 'nao-existe.mp4'), join(reelDir, 'destino3'), false);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBeTruthy();
  });

  it('tick(): job "reel" done com dest → copia por default (mover=false no state), notifica "copiado"', async () => {
    const state = new StateStore(':memory:');
    const src = join(reelDir, 'render', 'reel-3.mp4');
    mkdirSync(join(reelDir, 'render'), { recursive: true });
    writeFileSync(src, 'x');
    const dest = join(reelDir, 'lives3');
    state.track({ queue: 'video', jobId: 40, chatId: 77, dest, destToken: 'lives3', pesquisa: false, mover: false });
    const sent: string[] = [];
    await tick(videoOnly(
      { jobs: async () => [mkJob({ id: 40, skill: 'reel', status: 'done' as const, result_path: src })] },
      async (_c, t) => { sent.push(t); },
      { state },
    ));
    expect(sent[0]).toContain('copiado');
    expect(sent[0]).toContain('lives3');
    expect(existsSync(src)).toBe(true); // original preservado
    expect(existsSync(join(dest, 'reel-3.mp4'))).toBe(true);
  });

  it('tick(): job "reel" done com dest e mover=true → move, original desaparece, notifica "movido"', async () => {
    const state = new StateStore(':memory:');
    const src = join(reelDir, 'render2', 'reel-4.mp4');
    mkdirSync(join(reelDir, 'render2'), { recursive: true });
    writeFileSync(src, 'x');
    const dest = join(reelDir, 'lives4');
    state.track({ queue: 'video', jobId: 41, chatId: 77, dest, destToken: 'lives4', pesquisa: false, mover: true });
    const sent: string[] = [];
    await tick(videoOnly(
      { jobs: async () => [mkJob({ id: 41, skill: 'reel', status: 'done' as const, result_path: src })] },
      async (_c, t) => { sent.push(t); },
      { state },
    ));
    expect(sent[0]).toContain('movido');
    expect(existsSync(src)).toBe(false);
    expect(existsSync(join(dest, 'reel-4.mp4'))).toBe(true);
  });

  it('tick(): reel sem dest não mexe em nada (fica em output/, watcher não copia nem move)', async () => {
    const state = new StateStore(':memory:');
    const src = join(reelDir, 'render3', 'reel-5.mp4');
    mkdirSync(join(reelDir, 'render3'), { recursive: true });
    writeFileSync(src, 'x');
    state.track({ queue: 'video', jobId: 42, chatId: 77, dest: null, destToken: null, pesquisa: false, mover: false });
    const sent: string[] = [];
    await tick(videoOnly(
      { jobs: async () => [mkJob({ id: 42, skill: 'reel', status: 'done' as const, result_path: src })] },
      async (_c, t) => { sent.push(t); },
      { state },
    ));
    expect(sent[0]).not.toContain('copiado');
    expect(sent[0]).not.toContain('movido');
    expect(existsSync(src)).toBe(true);
  });

  it('tick(): falha ao copiar (destino inválido) → avisa falha, mantém caminho original, original intacto', async () => {
    const state = new StateStore(':memory:');
    const src = join(reelDir, 'render4', 'reel-6.mp4');
    mkdirSync(join(reelDir, 'render4'), { recursive: true });
    writeFileSync(src, 'x');
    // destino é um ARQUIVO existente, não um diretório — mkdirSync/copyFileSync vão falhar.
    const badDestParent = join(reelDir, 'arquivo-no-lugar-de-pasta');
    writeFileSync(badDestParent, 'sou um arquivo, não uma pasta');
    const dest = join(badDestParent, 'sub');
    state.track({ queue: 'video', jobId: 43, chatId: 77, dest, destToken: 'lives5', pesquisa: false, mover: false });
    const sent: string[] = [];
    await tick(videoOnly(
      { jobs: async () => [mkJob({ id: 43, skill: 'reel', status: 'done' as const, result_path: src })] },
      async (_c, t) => { sent.push(t); },
      { state },
    ));
    expect(sent[0]).toContain('falha ao copiar');
    expect(sent[0]).toContain(src);
    expect(existsSync(src)).toBe(true); // original intacto
  });
});

describe('failMessage', () => {
  it('inclui o id prefixado e a dica de /status com o mesmo prefixo', () => {
    const msg = failMessage(
      mkJob({ id: 9, status: 'failed', error: 'boom' }),
      { queue: 'texto', jobId: 9, chatId: 1, dest: null, destToken: null, pesquisa: false, transcrever: false, narracaoPath: null, mover: false, lastStatus: 'running', createdAt: '' },
    );
    expect(msg).toContain('T#9');
    expect(msg).toContain('/status T#9');
  });
});
