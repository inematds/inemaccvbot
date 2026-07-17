import { describe, it, expect } from 'vitest';
import { helpText, skillsText } from './help.js';
import type { SkillDef } from './skills.js';

const DEFS: SkillDef[] = [
  { command: 'explicativo', mkiSkill: 'explicativo', description: 'vídeo explicativo', example: 'explicativo: X | 9:16 | lives3' },
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
});

describe('skillsText', () => {
  it('lista comando, descrição e exemplo', () => {
    const t = skillsText(DEFS);
    expect(t).toContain('explicativo');
    expect(t).toContain('vídeo explicativo');
  });
});
