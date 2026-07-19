import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parsePromoclubArg, slugAssunto, newPromoState, saveState, loadState, listStates,
  runFase1, baixarTick, statusText, reelDescricaoFor, buildFase1Prompt,
  isComplete, extractFala, textosText,
  TODOS_PUBLICOS, type PromoState, type HeygenClient,
} from './promoclub.js';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'promoclub-'));

describe('parsePromoclubArg', () => {
  it('assunto simples → novo com defaults (11 públicos, versao 1)', () => {
    const r = parsePromoclubArg('avatar digital');
    expect(r).toMatchObject({ kind: 'novo', assunto: 'avatar digital', versao: 1 });
    if (r.kind === 'novo') expect(r.publicos).toEqual(TODOS_PUBLICOS);
  });
  it('publicos= e versao= filtram', () => {
    const r = parsePromoclubArg('IA no trabalho | publicos=jovens,40mais | versao=2');
    expect(r).toMatchObject({ kind: 'novo', assunto: 'IA no trabalho', publicos: ['jovens', '40mais'], versao: 2 });
  });
  it('público inválido → erro com a lista', () => {
    const r = parsePromoclubArg('x | publicos=marcianos');
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.message).toContain('marcianos');
  });
  it('versao fora de 1..3 → erro', () => {
    expect(parsePromoclubArg('x | versao=4').kind).toBe('error');
  });
  it('status sem assunto e com assunto', () => {
    expect(parsePromoclubArg('status')).toEqual({ kind: 'status', assunto: null });
    expect(parsePromoclubArg('status avatar digital')).toEqual({ kind: 'status', assunto: 'avatar digital' });
  });
  it('statuslog (não confunde com status)', () => {
    expect(parsePromoclubArg('statuslog')).toEqual({ kind: 'statuslog' });
  });
  it('statustext exige assunto', () => {
    expect(parsePromoclubArg('statustext').kind).toBe('error');
    expect(parsePromoclubArg('statustext avatar digital')).toEqual({ kind: 'statustext', assunto: 'avatar digital' });
  });
  it('baixar exige assunto', () => {
    expect(parsePromoclubArg('baixar').kind).toBe('error');
    expect(parsePromoclubArg('baixar avatar digital')).toEqual({ kind: 'baixar', assunto: 'avatar digital' });
  });
  it('vazio → uso', () => {
    expect(parsePromoclubArg('').kind).toBe('error');
  });
  it('campo desconhecido → erro', () => {
    expect(parsePromoclubArg('x | formato=9:16').kind).toBe('error');
  });
});

describe('slugAssunto', () => {
  it('remove acento/espaço', () => {
    expect(slugAssunto('Vídeos enquanto você dorme!')).toBe('videos-enquanto-voce-dorme');
  });
});

describe('state', () => {
  it('newPromoState monta título no contrato <slug>-<publico>-v<versao>', () => {
    const s = newPromoState('Avatar Digital', ['jovens'], 2, 42);
    expect(s.publicos.jovens.titulo).toBe('avatar-digital-jovens-v2');
    expect(s.publicos.jovens.lives).toBe('lives22');
    expect(s.publicos.jovens.fase).toBe('texto-pendente');
  });
  it('save/load/list roundtrip por slug OU assunto', () => {
    const dir = tmp();
    const s = newPromoState('Avatar Digital', ['jovens'], 1, 42);
    saveState(dir, s);
    expect(loadState(dir, 'Avatar Digital')?.slug).toBe('avatar-digital');
    expect(loadState(dir, 'avatar-digital')?.chatId).toBe(42);
    expect(listStates(dir)).toHaveLength(1);
    expect(loadState(dir, 'outro')).toBeNull();
  });
});

describe('runFase1', () => {
  it('marca aguardando-render só pra quem ganhou arquivo, lista títulos', async () => {
    const dir = tmp();
    const s = newPromoState('Avatar', ['jovens', 'criadores'], 1, 42);
    const runner = vi.fn(async () => {
      mkdirSync(join(dir, 'textos', 'avatar'), { recursive: true });
      writeFileSync(join(dir, 'textos', 'avatar', 'jovens.md'), '# ok');
    });
    const msg = await runFase1(s, dir, runner);
    expect(runner).toHaveBeenCalledOnce();
    expect(s.publicos.jovens.fase).toBe('aguardando-render');
    expect(s.publicos.criadores.fase).toBe('texto-pendente');
    expect(msg).toContain('avatar-jovens-v1');
    expect(msg).toContain('criadores');
    expect(loadState(dir, 'avatar')?.publicos.jovens.fase).toBe('aguardando-render');
  });
  it('runner que lança → mensagem de falha com instrução de conserto, sem lançar', async () => {
    const dir = tmp();
    const s = newPromoState('Avatar', ['jovens'], 1, 42);
    const msg = await runFase1(s, dir, vi.fn(async () => { throw new Error('claude explodiu'); }), { info: vi.fn(), warn: vi.fn(), error: vi.fn() });
    expect(msg).toContain('❌');
    expect(msg).toContain('claude explodiu');
    expect(s.publicos.jovens.fase).toBe('texto-pendente');
  });
});

function fakeHeygen(overrides: Partial<HeygenClient> = {}): HeygenClient {
  return {
    listByTitle: async () => new Map(),
    videoUrl: async () => 'https://cdn/x.mp4',
    download: async (_url, dest) => writeFileSync(dest, 'mp4'),
    ...overrides,
  };
}

describe('baixarTick', () => {
  const ready = (dir: string): PromoState => {
    const s = newPromoState('Avatar', ['jovens'], 1, 42);
    s.publicos.jovens.fase = 'aguardando-render';
    saveState(dir, s);
    return s;
  };

  it('completed → baixa, enfileira reel, avança fase e persiste', async () => {
    const dir = tmp();
    const s = ready(dir);
    const heygen = fakeHeygen({
      listByTitle: async () => new Map([['avatar-jovens-v1', { videoId: 'abc', status: 'completed' }]]),
    });
    const enqueueReel = vi.fn(async () => 77);
    const avisos = await baixarTick(s, dir, { heygen, enqueueReel });
    expect(avisos.join('\n')).toContain('V#77');
    expect(s.publicos.jovens.fase).toBe('reel-enfileirado');
    expect(s.publicos.jovens.reelJob).toBe(77);
    expect(existsSync(join(dir, 'output', 'avatar', 'avatares', 'avatar-jovens-v1.mp4'))).toBe(true);
    expect(loadState(dir, 'avatar')?.publicos.jovens.fase).toBe('reel-enfileirado');
    expect(enqueueReel).toHaveBeenCalledWith(join(dir, 'output', 'avatar', 'avatares', 'avatar-jovens-v1.mp4'), 'jovens', s);
  });

  it('render ainda processando → não faz nada', async () => {
    const dir = tmp();
    const s = ready(dir);
    const heygen = fakeHeygen({ listByTitle: async () => new Map([['avatar-jovens-v1', { videoId: 'abc', status: 'processing' }]]) });
    const avisos = await baixarTick(s, dir, { heygen, enqueueReel: vi.fn() });
    expect(avisos).toEqual([]);
    expect(s.publicos.jovens.fase).toBe('aguardando-render');
  });

  it('enfileirar falha → fica em "baixado" (arquivo preservado) e avisa com conserto', async () => {
    const dir = tmp();
    const s = ready(dir);
    const heygen = fakeHeygen({ listByTitle: async () => new Map([['avatar-jovens-v1', { videoId: 'abc', status: 'completed' }]]) });
    const avisos = await baixarTick(s, dir, {
      heygen, enqueueReel: vi.fn(async () => { throw new Error('fila fora'); }),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    expect(avisos.join('\n')).toContain('❌');
    expect(avisos.join('\n')).toContain('/promoclub baixar');
    expect(s.publicos.jovens.fase).toBe('baixado');
  });

  it('nenhum público pendente → nem consulta o HeyGen', async () => {
    const dir = tmp();
    const s = newPromoState('Avatar', ['jovens'], 1, 42);
    const listByTitle = vi.fn(async () => new Map());
    await baixarTick(s, dir, { heygen: fakeHeygen({ listByTitle }), enqueueReel: vi.fn() });
    expect(listByTitle).not.toHaveBeenCalled();
  });
});

describe('statusText / descrições', () => {
  it('funil por público', () => {
    const s = newPromoState('Avatar', ['jovens', 'criadores'], 1, 42);
    s.publicos.jovens.fase = 'reel-enfileirado';
    s.publicos.jovens.reelJob = 9;
    const txt = statusText([s]);
    expect(txt).toContain('📣 Avatar');
    expect(txt).toContain('(v1 · 1/2 reels na fila)');
    expect(txt).toContain('jovens: 🎞 reel na fila (V#9 → lives22)');
    expect(txt).toContain('criadores: ✍️ texto pendente');
  });
  it('divisória NUMERADA separa cada assunto (1/2, 2/2)', () => {
    const a = newPromoState('Assunto A', ['jovens'], 1, 42);
    const b = newPromoState('Assunto B', ['jovens'], 1, 42);
    const txt = statusText([a, b]);
    expect(txt).toContain('1/2');
    expect(txt).toContain('2/2');
    expect(txt).toContain('📣 Assunto A');
    expect(txt).toContain('📣 Assunto B');
  });
  it('vazio → dica de uso', () => {
    expect(statusText([])).toContain('/promoclub');
  });
  it('reelDescricao embute o gatilho do público', () => {
    expect(reelDescricaoFor('jovens')).toContain('profissão que ainda está nascendo');
  });
  it('prompt da fase 1 cita skill, slug e commit sem push', () => {
    const s = newPromoState('Avatar', ['jovens'], 1, 42);
    const p = buildFase1Prompt(s);
    expect(p).toContain('inemaclub-textos');
    expect(p).toContain('textos/avatar/');
    expect(p).toContain('NÃO faça push');
  });
});

describe('isComplete', () => {
  it('true só quando todos os públicos estão em reel-enfileirado', () => {
    const s = newPromoState('X', ['jovens', 'criadores'], 1, 42);
    expect(isComplete(s)).toBe(false);
    s.publicos.jovens.fase = 'reel-enfileirado';
    expect(isComplete(s)).toBe(false);
    s.publicos.criadores.fase = 'reel-enfileirado';
    expect(isComplete(s)).toBe(true);
  });
});

describe('extractFala / textosText', () => {
  const md = [
    '# Título — jovens', '',
    'Assunto: contexto qualquer.', '',
    '## Versão 1 — "gancho"',
    '### FALA (texto para o HeyGen — falar exatamente isto)',
    'Esta é a fala da versão um, uma frase só.',
    '### SOBREPOSIÇÕES DE TELA (fase do reel — NÃO falar)',
    '- Headline: NÃO DEVE APARECER',
    '', '## Versão 2 — "outro"',
    '### FALA (texto para o HeyGen)',
    'Fala da versão dois.',
    '### SOBREPOSIÇÕES', '- x',
  ].join('\n');

  it('extractFala pega só a FALA da versão pedida, sem sobreposições', () => {
    expect(extractFala(md, 1)).toBe('Esta é a fala da versão um, uma frase só.');
    expect(extractFala(md, 2)).toBe('Fala da versão dois.');
    expect(extractFala(md, 3)).toBeNull();
  });

  it('textosText lista a FALA por canal e ignora quem não tem arquivo', () => {
    const dir = tmp();
    const s = newPromoState('Avatar', ['jovens', 'criadores'], 1, 42);
    mkdirSync(join(dir, 'textos', 'avatar'), { recursive: true });
    writeFileSync(join(dir, 'textos', 'avatar', 'jovens.md'), md);
    const txt = textosText(s, dir);
    expect(txt).toContain('jovens → lives22');
    expect(txt).toContain('Esta é a fala da versão um');
    expect(txt).not.toContain('NÃO DEVE APARECER');
    expect(txt).toContain('criadores → lives30');
    expect(txt).toContain('sem texto'); // criadores não tem arquivo
  });
});
