import { describe, it, expect } from 'vitest';
import { helpText, skillsText } from './help.js';
import type { SkillDef } from './skills.js';

const DEFS: SkillDef[] = [
  { command: 'explicativo', mkiSkill: 'explicativo', queue: 'video', description: 'vídeo explicativo', example: 'explicativo: X | 9:16 | lives3' },
  { command: 'transcrever', mkiSkill: 'transcrever', queue: 'texto', description: 'baixa e transcreve', example: 'transcrever: https://vt.tiktok.com/XXXX' },
  { command: 'dublar', mkiSkill: 'dublar', queue: 'texto', description: 'traduz e dubla', example: 'dublar: https://youtube.com/watch?v=XXXX | lives3' },
];

describe('helpText', () => {
  it('cobre formato, exemplos, comandos e destinos', () => {
    const h = helpText(DEFS, ['lives1', 'lives2']);
    for (const s of ['explicativo: X | 9:16 | lives3', '/fila', '/status', '/cancelar', '/enviar', '/skills', '/help', 'lives1', 'pesquisa', 'uma instrução por linha']) {
      expect(h).toContain(s);
    }
  });

  it('documenta o campo transcrever com exemplo, e não afirma que transcrição é impossível', () => {
    const h = helpText(DEFS, ['lives1', 'lives2']);
    expect(h.toLowerCase()).toContain('transcrever');
    expect(h.toLowerCase()).toContain('inemavox');
    expect(h).not.toMatch(/não (transcrevo|consigo transcrever)/i);
  });

  it('documenta as DUAS filas (vídeo e texto)', () => {
    const h = helpText(DEFS, []);
    expect(h.toLowerCase()).toContain('fila de vídeo');
    expect(h.toLowerCase()).toContain('fila de texto');
  });

  it('documenta ids prefixados V#/T#', () => {
    const h = helpText(DEFS, []);
    expect(h).toContain('V#');
    expect(h).toContain('T#');
  });

  it('esclarece a diferença entre o CAMPO transcrever (job de vídeo) e a SKILL transcrever (fila de texto)', () => {
    const h = helpText(DEFS, []);
    const lower = h.toLowerCase();
    expect(lower).toContain('campo');
    expect(lower).toContain('skill');
    expect(lower).toContain('não confundir');
  });
});

describe('skillsText', () => {
  it('lista comando, descrição e exemplo', () => {
    const t = skillsText(DEFS);
    expect(t).toContain('explicativo');
    expect(t).toContain('vídeo explicativo');
  });
});
