import type { SkillDef } from './skills.js';

export function skillsText(defs: SkillDef[]): string {
  return ['🎬 skills registradas:', ...defs.map((d) => `• ${d.command} — ${d.description}\n  ex.: ${d.example}`)].join('\n');
}

export function helpText(defs: SkillDef[], dests: string[]): string {
  return [
    '🤖 inemaccvbot — fila de vídeos (mkivideos)',
    '',
    'Mande instruções em texto — uma instrução por linha = um job:',
    '  <skill>: <assunto ou link> [| 9:16] [| pesquisa] [| narracao] [| livesN] [| modulo X] [| curso X]',
    '',
    'Exemplos:',
    ...defs.map((d) => `  ${d.example}`),
    '  explicativo: Computação quântica | pesquisa | lives2',
    '  explicativo: O que é RAG | narracao',
    '',
    'Campos (qualquer ordem):',
    '  9:16 ou vertical — formato Shorts/Reels (default 16:9)',
    '  pesquisa — o agente que gera o vídeo pesquisa o assunto na web antes de escrever o roteiro',
    '  narracao ou texto — além do vídeo, manda aqui a narração completa em texto (mensagem se couber, senão como arquivo)',
    `  livesN — move o vídeo pronto para yt-pub-livesN/imports/videos (válidos: ${dests.join(', ') || 'nenhum'})`,
    '',
    'Texto livre também funciona (o bot interpreta), mas SÓ com as skills registradas — nada é criado fora delas.',
    '',
    'Também dá pra perguntar em linguagem natural sobre o andamento do serviço — o bot responde com',
    'base na fila e no que já foi feito, sem criar nenhum job novo. Exemplos:',
    '  terminou?',
    '  quanto falta pro #12?',
    '  você já moveu o vídeo pro lives3?',
    '',
    'Comandos:',
    '  /fila — running + queued com posição',
    '  /status [id] — detalhe do job (sem id: visão geral + stats)',
    '  /cancelar <id> — cancela job na fila',
    '  /enviar <id> — recebe o MP4 aqui (≤50 MB; acima, só o caminho)',
    '  /skills — o que o bot sabe fazer',
    '  /help — esta ajuda',
  ].join('\n');
}
