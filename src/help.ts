import type { SkillDef } from './skills.js';

export function skillsText(defs: SkillDef[]): string {
  return ['🎬 skills registradas:', ...defs.map((d) => `• ${d.command} — ${d.description}\n  ex.: ${d.example}`)].join('\n');
}

export function helpText(defs: SkillDef[], dests: string[]): string {
  return [
    '🤖 inemaccvbot — fila de vídeos (mkivideos)',
    '',
    'Mande instruções em texto — uma instrução por linha = um job:',
    '  <skill>: <assunto ou link> [| 9:16] [| pesquisa] [| narracao] [| transcrever] [| livesN] [| modulo X] [| curso X]',
    '',
    'Exemplos:',
    ...defs.map((d) => `  ${d.example}`),
    '  explicativo: Computação quântica | pesquisa | lives2',
    '  explicativo: O que é RAG | narracao',
    '  explicativo: https://instagram.com/reel/XYZ | transcrever',
    '',
    'Campos (qualquer ordem):',
    '  9:16 ou vertical — formato Shorts/Reels (default 16:9)',
    '  pesquisa — o agente que gera o vídeo pesquisa o assunto na web antes de escrever o roteiro',
    '  narracao ou texto — além do vídeo, manda aqui a narração completa em texto (mensagem se couber, senão como arquivo)',
    '  transcrever ou transcricao — o agente que gera o vídeo baixa o áudio do link de origem e transcreve localmente (inemavox, Whisper local) ANTES de escrever o roteiro, usando essa transcrição como base — pedido é enfileirado, não confirmado: se a transcrição falhar, o job falha e aparece em /status',
    `  livesN — move o vídeo pronto para yt-pub-livesN/imports/videos (válidos: ${dests.join(', ') || 'nenhum'})`,
    '',
    'Texto livre também funciona (o bot interpreta), mas SÓ com as skills registradas — nada é criado fora delas.',
    '',
    'Também dá pra mandar um arquivo (ex.: .md) anexado, com uma legenda dizendo o que fazer com ele',
    '(ex.: "explicativo: resumo desse documento") — o bot baixa o arquivo e passa pro agente de render',
    'como fonte do vídeo. Sem legenda, o bot só pergunta o que fazer, sem enfileirar nada.',
    '',
    'Também dá pra perguntar em linguagem natural sobre o andamento do serviço, ou sobre o que o bot',
    'sabe fazer — o bot responde com base na fila, no que já foi feito e nas skills registradas, sem',
    'criar nenhum job novo. Exemplos:',
    '  terminou?',
    '  quanto falta pro #12?',
    '  você já moveu o vídeo pro lives3?',
    '  você consegue transcrever o áudio de um reel?',
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
