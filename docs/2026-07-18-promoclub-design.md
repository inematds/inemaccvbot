# /promoclub — inemaccvbot como fonte de instrução do pipeline inemaclubpromover

Aprovado pelo usuário em 2026-07-18. Objetivo: disparar e acompanhar pelo Telegram
o pipeline texto → HeyGen → reel → lives (projeto `inemaclubpromover`), deixando
humana só a fase 2 (render no estúdio HeyGen, navegador logado — nunca API paga).

## Comandos

- `/promoclub <assunto> [| publicos=a,b,c] [| versao=N]` — inicia um assunto:
  roda a FASE 1 headless (`claude -p` com cwd no inemaclubpromover, skill
  `inemaclub-textos`), commita os textos e responde com a lista de títulos a
  renderizar no HeyGen. Defaults: 11 públicos, versao=1.
- `/promoclub status [assunto]` — funil por público (texto → render → baixado →
  reel → lives). Sem assunto: todos os assuntos ativos.
- `/promoclub baixar <assunto>` — força a fase 2.5 agora: consulta `video.list`
  por título, baixa os `completed` e enfileira a fase 3 de cada um.

## Watcher promoclub

Poll (default 5 min) SÓ quando algum assunto tem público `aguardando-render`.
Título `completed` no HeyGen → baixa (video_status.get → MP4 em
`<promoDir>/output/<slug>/avatares/`) → enfileira reel (skill `reel`,
capa impacto + gatilho do público) no lives do público → avisa no chat.
O aviso de "reel pronto" é do watcher existente (fila mkivideos).

## Estado

Um JSON por assunto em `<promoDir>/state/<slug>.json`:
`{ assunto, slug, versao, chatId, criadoEm, publicos: { <slug>: { lives, titulo,
fase: texto-pendente|aguardando-render|baixado|reel-enfileirado, arquivo?, reelJob? } } }`.
Sobrevive a restart; o watcher retoma de onde parou.

## Mapeamentos fixos (código)

- público → lives21..31 (faixa reservada; pasta faltante → cria o MÍNIMO
  `imports/videos/` e avisa que a config do canal segue pendente).
- público → gatilho (tabela da skill `inemaclub-textos`) → headline da capa.
- Título HeyGen = `<slug-assunto>-<publico>-v<versao>` (contrato entre as fases).

## Config nova (.env, com defaults)

`PROMOCLUB_DIR` (~/projetos/inemaclubpromover), `HEYGEN_ENV_PATH`
(~/projetos/openpcbot/.env — key lida em runtime, nunca no código/repo),
`PROMOCLUB_POLL_SECONDS` (300).

## Fora de escopo

Fase 2 automática (render por API = créditos, vetado); config dos canais
YouTube (setup do usuário); múltiplas versões por público num mesmo assunto.
