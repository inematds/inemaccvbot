# inemaccvbot — Design / Spec

**Data:** 2026-07-16
**Status:** aprovado (brainstorming concluído)

## O que é

Bot Telegram dedicado (`@inemaccvbot`), **cliente fino** da fila de vídeos
[`mkivideos`](../../../../mkivideos) (daemon systemd já rodando em `mkivideos.service`).
Recebe instruções em texto, traduz em jobs das skills registradas, informa fila/status,
avisa quando termina e move o MP4 final pro destino pedido.

**O que ele NÃO é:** não renderiza nada, não tem motor de fila próprio, e **nunca cria
conteúdo fora de uma skill registrada** — instrução que não mapeia pra skill é recusada
com explicação.

## Decisões tomadas

| Tema | Decisão |
|---|---|
| Interpretação da instrução | **Híbrido (C):** parser leve primeiro; fallback `claude -p` com **Opus, esforço médio** |
| Skills no lançamento | `video-explicativo`, `videos-cursos-inema`, `video-demonstrativo` (as 3 da fila mkivideos) |
| Carrossel | **Fora do lançamento** — skill virá do `timesmkt3` (ainda não existe); registro de skills é plugável via config, entra depois sem mexer em código |
| Notificação de conclusão | **Só mensagem** (nome, caminho final, duração, destino). MP4 sob demanda via `/enviar <id>` (limite 50 MB do bot) |
| Falha | Mensagem com erro resumido |
| Acesso | Allowlist de chat ids no `.env` (`ALLOWED_CHAT_IDS`); mensagens de fora são **ignoradas silenciosamente** e logadas |
| Pesquisa opcional | Flag `pesquisa` na instrução (ou pedido em texto livre) anexa uma instrução de pesquisa ao input do job; quem pesquisa é o **agente de render do mkivideos**, não o bot (mudou — ver seção "Pesquisa opcional" abaixo) |
| Narração em texto | Flag `narracao`/`texto` faz o bot escolher um caminho absoluto (`NARRACOES_DIR`) e anexar uma instrução ao job pedindo que o agente TAMBÉM salve o roteiro completo ali; o watcher entrega esse texto (mensagem ou documento) quando o job termina — ver seção "Narração em texto" abaixo |
| Interpretação parcial | O fallback Claude extrai todo job que mapeia pra skill registrada e só recusa (`RECUSAR:`) quando NADA mapeia; pedidos extras que não mapeiam viram um aviso `ignorado`, não um bloqueio do pedido inteiro — ver seção "Interpretação parcial" abaixo |
| Perguntas sobre o serviço | Texto livre que não é pedido de vídeo mas pergunta sobre andamento/histórico ("terminou?", "quanto falta?", "você moveu pro lives3?") é classificado como `question` (mesma chamada `claude -p` do fallback, sem round-trip extra) e respondido com base na fila, no state local e no tail do log — nunca enfileira nada — ver seção "Perguntas sobre o serviço" abaixo |
| Log em arquivo | `src/log.ts`: grava em `LOG_FILE` (rotação em `.1`, um backup só) além de stdout/stderr — ver seção "Log" abaixo |
| Stack | Node/TypeScript (grammY), mesma stack do openpcbot/mkivideos; integração **modo A** (CLI `mki.sh` + banco compartilhado) |
| Deploy | systemd de usuário `inemaccvbot.service`; token no `.env` (nunca commitado) |

## Arquitetura (~5 módulos)

```
Telegram ⇄ bot.ts ─→ parser.ts ─────────────→ queue-client.ts ─→ mkivideos (daemon, agente pesquisa se pedido)
                        │                              ▲
                        └── fallback claude -p (Opus/médio, só tradução, sem web)
                                                         │ poll ~60s
                                                    watcher.ts ─→ move + notifica
```

- **`bot.ts`** — long-polling Telegram (grammY). Filtra por `ALLOWED_CHAT_IDS`. Roteia
  comandos e mensagens de texto.
- **`parser.ts`** — parser do formato semi-estruturado, **uma instrução por linha** = um
  job (é assim que se manda vários de uma vez). Linha que não casa → fallback
  `claude -p` (Opus, esforço médio) que devolve JSON
  `{skill, assunto, formato, destino, pesquisa}`. Skill desconhecida → recusa e explica.
- **`skills.ts`** — registro plugável (JSON de config): nome do comando → skill mkivideos
  \+ parâmetros aceitos. Lança com `explicativo`, `curso`, `demo`.
- **`queue-client.ts`** — wrapper do CLI mkivideos: `add`, `fila`, `stats`,
  `status <id>`, `get <id>`, `cancelar <id>`, `ping`.
- **`watcher.ts`** — poll a cada ~60s nos jobs submetidos pelo bot. Estado local mínimo
  (SQLite): `job id ↔ chat id + destino pedido + flags`. Transições:
  - `done` → move o MP4 pra `~/projetos/yt-pub-lives<N>/imports/videos/`
    (cria a pasta se faltar) e notifica (nome, caminho, duração, destino).
  - `failed` → notifica com erro resumido.

## Formato das instruções (parser leve)

```
explicativo: O que é RAG | 9:16 | lives3
explicativo: Computação quântica | pesquisa | lives2
curso: https://inematds.github.io/skillsx/ | modulo t1m1
demo: https://app.exemplo.com | lives7
```

- `<skill>: <assunto/link>` obrigatório; demais campos separados por `|`, em qualquer ordem.
- `livesN` → destino `~/projetos/yt-pub-livesN/imports/videos/`. Opcional — sem ele o
  vídeo fica no output padrão da skill.
- `pesquisa` → ativa o passo de pesquisa.
- `narracao` (sinônimo `texto`) → pede que a narração completa também seja entregue em texto.
- Várias linhas = vários jobs numa mensagem só.
- Texto livre fora do padrão → Claude interpreta (mesmos campos de saída).

## Pesquisa opcional

**Mudou em 2026-07-16 (mesmo dia do lançamento):** o design original rodava a pesquisa
**no bot, no submit** — uma chamada `claude -p` com WebSearch (timeout de 600s) gerava
um `briefing.md` salvo em `BRIEFINGS_DIR` e o caminho era anexado ao input do job.
Problema: grammY processa updates **sequencialmente**; uma única linha com `pesquisa`
travava o bot inteiro (inclusive `/fila`, `/status`) por até 10 minutos, já que a
pesquisa bloqueava o handler de mensagem antes de liberar o próximo update.

**Design atual:** o bot não pesquisa nada. Quando `pesquisa` está marcado, ele só
**anexa uma instrução de pesquisa em PT-BR ao input do job** (uma frase, sem quebra de
linha, sem token `--…` — o CLI do mkivideos re-splita o input em argv). Essa instrução
viaja dentro do `input` até o daemon mkivideos, que roda o agente de render como
`claude -p <prompt>` **sem `--allowedTools`** (`mkivideos/src/cli-lib.ts`) — ou seja,
sessão completa com ferramentas web — e embute o `input` verbatim no prompt do agente
(`buildVideoPrompt` em `mkivideos/src/queue.ts`). O próprio agente que já vai escrever o
roteiro faz a pesquisa como parte do mesmo job, antes de escrever. Resultado: o submit
do bot volta a ser instantâneo (sem chamada bloqueante), e a pesquisa continua
acontecendo — só que dentro do job, não antes dele. O SQLite local guarda apenas um
marcador booleano (`pesquisa`) pra a notificação de conclusão poder indicar `🔎 com
pesquisa`; não existe mais arquivo de briefing nem `BRIEFINGS_DIR`.

## Narração em texto

**Adicionado em 2026-07-16** (feature pedida pelo usuário, junto com o smoke test). As skills de
vídeo já escrevem o roteiro falado como parte do processo (ex.: `video-explicativo` produz
`SCRIPT.md`/`assets/txt/sN.txt`) — só não existia canal pra essa texto chegar até o usuário.

Mecanismo: o `input` do job viaja verbatim pro prompt do agente de render
(`buildVideoPrompt` em `mkivideos/src/queue.ts`), que roda como sessão `claude -p` completa com
acesso a filesystem. Então o **bot** (não o mkivideos) escolhe de antemão um caminho absoluto e
instrui o agente a salvar a narração ali:

- Flag `narracao` (sinônimo `texto`) no parser e no fallback Claude (`interpret.ts`).
- No `submit()` (`bot.ts`), quando `narracao=true`: gera `<NARRACOES_DIR>/<timestamp>-<slug>.txt`
  (slug do assunto, sem espaço/acento), cria o diretório (`mkdirSync`), e anexa ao `input` do job
  uma frase em PT-BR pedindo pro agente TAMBÉM salvar a narração completa (texto puro, em ordem de
  cena) nesse caminho exato. Mesma restrição da instrução de pesquisa: uma frase só, sem quebra de
  linha, sem token começando com `--` (o CLI do mkivideos re-splita o input em argv). O caminho não
  pode ter espaço — se `NARRACOES_DIR` tiver espaço, o submit falha com erro claro em vez de gerar
  um job corrompido.
- **Por que o bot escolhe o caminho, e não o mkivideos**: quando `--pasta` é um diretório, o
  mkivideos renderiza pra `renders/<name>.mp4` e só move o `.mp4` pro destino — um arquivo escrito
  do lado seria abandonado. O bot escolhendo um caminho absoluto de antemão evita qualquer
  acoplamento com os internos de render/move do mkivideos.
- `state.ts` guarda `narracao_path` (nullable) por job.
- `watcher.ts`: quando um job termina em `done` com `narracao_path` setado, checa se o arquivo
  existe. Se sim, a mensagem de conclusão avisa "enviando a seguir" e o watcher chama o dep
  opcional `sendNarration(chatId, path)` — a decisão entre mandar como mensagem (texto cabe em
  ~3500 chars, com folga do limite de 4096 do Telegram) ou como documento é feita na implementação
  desse dep (`index.ts`, `bot.api.sendMessage`/`sendDocument`). Se o arquivo não existe (agente
  ignorou a instrução), a mensagem de conclusão diz isso explicitamente — nunca afirma que a
  narração foi entregue quando não foi. Falha ao entregar a narração é best-effort: nunca derruba
  nem atrasa o aviso principal de conclusão, que já foi persistido antes.

## Transcrição opcional (flag `transcrever`)

**Adicionado em 2026-07-17.** Até aqui o bot respondia "não transcrevo o áudio original de
vídeos" a qualquer pergunta de capacidade — verdade só das *skills registradas* do mkivideos, não
do ecossistema: o `inemavox` (`~/projetos/inemavox`) já baixa vídeo (`baixar_v1.py`, TikTok/
Instagram/YouTube/+1000 sites) e transcreve com Whisper local (`transcrever_v1.py`), e o
`openpcbot` (sibling) já delega isso pro agente de render.

**Mesmo padrão de `pesquisa`/`narracao` — nenhuma skill nova no mkivideos, nenhuma mudança no
mkivideos.** O `input` do job viaja verbatim pro prompt do agente de render (`buildVideoPrompt`
em `mkivideos/src/queue.ts`), que roda como sessão `claude -p` completa (sem `--allowedTools`,
`mkivideos/src/cli-lib.ts`) com acesso a filesystem e ferramentas — inclusive pra rodar os
scripts do inemavox. Uma instrução embutida no `input` chega até esse agente, que decide como
executar.

- Flag `transcrever` (sinônimos `transcricao`/`transcrição`) no parser (`parser.ts`) e no
  fallback Claude (`interpret.ts`), default `false`.
- No `submit()` (`bot.ts`), quando `transcrever=true`, anexa ao `input` do job uma frase em
  PT-BR (`TRANSCRIPTION_INSTRUCTION`) instruindo o agente a, ANTES de escrever o roteiro, baixar
  o áudio do link de origem e transcrever localmente com o inemavox (`baixar_v1.py` +
  `transcrever_v1.py`, Whisper local, em `~/projetos/inemavox`) e usar essa transcrição como base
  factual do vídeo. Mesma restrição das instruções de pesquisa/narração: uma frase só, sem quebra
  de linha, sem token começando com `--` (o CLI do mkivideos re-splita o input em argv). Combina
  livremente com `pesquisa`/`narracao`/`livesN` na mesma instrução.
- `state.ts` guarda `transcrever` (booleano) por job — mesmo padrão de `pesquisa` — só pra a
  notificação de conclusão poder indicar `🎙️ com transcrição pedida`.
- **Honestidade**: a transcrição acontece DENTRO do job de render, fora da visibilidade do bot.
  Se o inemavox falhar, o JOB falha e aparece via `/status`/`/enviar` como qualquer outra falha —
  o bot nunca afirma que uma transcrição foi produzida, só que foi *pedida* (`watcher.ts`:
  "com transcrição pedida", não "transcrito com sucesso").
- `help.ts`/`skillsText`/`helpText` (a mesma fonte real usada por `/help`, `/skills`, e pela
  resposta de perguntas de capacidade em `answer.ts`) documentam a flag — a resposta a "você
  consegue transcrever o áudio de um reel?" deixou de negar a capacidade.

## Interpretação parcial

**Corrigido em 2026-07-16** (bug do smoke test): um pedido como `<url> crie um vídeo explicativo
... e me retorne os vídeos e a narração em texto` batia no fallback Claude, que via a parte "e a
narração em texto" como algo fora do escopo das skills e recusava o pedido **inteiro**, sem
enfileirar nada — mesmo a parte do vídeo mapeando perfeitamente pra skill `explicativo`.

Root cause: o prompt antigo dizia "se o pedido NÃO mapear pra nenhuma skill, responda RECUSAR" e o
Claude interpretava "tem uma parte extra" como "não mapeia".

Fix: o prompt agora instrui o Claude a extrair todo job que consiga mapear e reservar `RECUSAR:`
só pra quando **nada** no pedido mapeia pra skill registrada (ex.: "jogue xadrez comigo"). O
contrato de resposta aceita dois formatos — o array simples de sempre, OU um envelope
`{"jobs": [...], "ignorado": "<texto curto ou null>"}` — pra o Claude poder reportar o que não vai
fazer sem bloquear o que dá pra fazer. `interpretFreeText` devolve `{ok:true, instrs, ignorado?}`
e `bot.ts` acrescenta uma linha `⚠️ não vou fazer: <ignorado>` na resposta, junto com a confirmação
normal dos jobs enfileirados. Com a feature de narração (acima), o próprio exemplo do smoke test
deixou de precisar de `ignorado`: "vídeo + narração em texto" agora mapeia integralmente pra
`explicativo` com `narracao: true`.

A regra que não mudou: o bot nunca cria conteúdo fora de uma skill registrada — enfileirar o que
mapeia e recusar o resto respeita isso tanto quanto recusar o pedido inteiro respeitava.

## Perguntas sobre o serviço

**Adicionado em 2026-07-16/17** (feature pedida pelo usuário: "quero que ele responda quando
alguém perguntar algo relacionado com o serviço, tipo terminou, vc copiou ou moveu, quanto falta —
como vc tem o log pode saber de coisas feitas").

Antes, QUALQUER texto livre que não casasse com o parser leve caía direto em `interpretFreeText`,
que só sabia extrair jobs de vídeo ou recusar. Uma pergunta como "terminou?" virava uma recusa
("não deu: ..."), o que é errado — o bot já tem tudo que precisa pra responder.

**Classificação (`interpret.ts`):** o mesmo prompt/chamada `claude -p` do fallback agora também
classifica o texto em 3 categorias antes de decidir o formato de resposta — pedido de vídeo,
pergunta sobre o serviço, ou nem um nem outro (`RECUSAR:`). Isso é feito **numa única chamada**,
sem round-trip extra: o prompt pede ao Claude que responda `{"pergunta": "<texto da pergunta>"}`
quando for categoria 2, mantendo os formatos já existentes (`{"jobs":[...], "ignorado":...}` e o
array legado) pra categoria 1. `interpretFreeText` devolve um union discriminado:

```ts
type InterpretResult =
  | { ok: true; kind: 'jobs'; instrs: Instruction[]; ignorado?: string }
  | { ok: true; kind: 'question'; question: string }
  | { ok: false; error: string };
```

**Resposta (`src/answer.ts`, módulo novo):**
- `buildAnswerContext(chatId, client, state, logFile, tailLines=150)` junta os fatos disponíveis:
  `fila()`/`stats()` ao vivo do `QueueClient` (se a fila estiver acessível), os jobs rastreados
  **desse chat** via `StateStore.forChat(chatId)` (novo método — nunca inclui jobs de outro chat,
  mesmo allowlisted), e o **tail do log** via `readLogTail()`. `readLogTail` nunca lê o arquivo
  inteiro pra memória — abre um file descriptor e lê só os últimos `chunkBytes` (default
  200 KB, bem abaixo do teto de 5 MB do log) a partir do fim, corta a primeira linha (pode estar
  truncada no meio) e mantém só as últimas `maxLines` (default 150), truncando linhas individuais
  muito compridas. Tolerante a log ausente/vazio/ilegível — nunca lança.
- `answerQuestion(question, ctx, run: ClaudeRunner)` manda um prompt pro `ClaudeRunner` injetado
  pedindo resposta em PT-BR, curta e factual, **só com base no contexto fornecido** — instruído a
  dizer explicitamente quando não sabe, em vez de inventar, e a nunca expor caminhos de `.env`,
  tokens/credenciais, ou o log cru (resume em linguagem natural). Reusa o mesmo `ClaudeRunner`
  injetado em `deps.claude` — nenhum teste dispara o binário `claude` real.
- **`bot.ts`**: quando `interpret()` devolve `kind: 'question'`, chama `buildAnswerContext` +
  `answerQuestion` e responde com o texto — nunca cai no caminho de `submit()`, então uma pergunta
  **nunca enfileira nada** (uma das 4 garantias de "nada é criado fora de uma skill registrada").
  Pergunta e resposta (truncadas) são logadas.
- **Gate do `ping()` não bloqueia perguntas**: antes, um único `ping()` no topo do handler
  `message:text` recusava a mensagem inteira ("fila indisponível") sempre que o mkivideos estava
  fora do ar, mesmo pra uma pergunta — que não depende da fila viva (log + state local já bastam).
  Agora o `ping()` é checado **sob demanda** (helper `ensurePing()`, memoizado por mensagem — no
  máximo uma chamada) só quando existe de fato um job pra submeter (linha estruturada `skill:` ou
  resultado `kind:'jobs'` do fallback). Uma pergunta é respondida mesmo com a fila fora do ar;
  `buildAnswerContext` marca `queueUnreachable: true` nesse caso e o prompt instrui o Claude a
  avisar isso na resposta em vez de inventar dados da fila.

## Log

**Adicionado em 2026-07-16.** Antes disso o bot só escrevia em stdout e nunca registrava as
instruções recebidas — durante o smoke test isso tornou um bug real difícil de diagnosticar.

`src/log.ts` (sem dependência nova): grava linhas com timestamp em `LOG_FILE` **e** ainda em
stdout/stderr (`console.log`/`console.error`), então `journalctl` continua funcionando sob
systemd. Guarda de tamanho: antes de cada append, se o arquivo já passou de `LOG_MAX_BYTES`, ele é
renomeado pra `<file>.1` (substituindo qualquer `.1` anterior) e um arquivo novo começa vazio —
mantém exatamente UM backup, nunca mais, então o disco fica limitado a ~2× o máximo. Nunca lança
pro chamador: se o log em disco falhar (disco cheio, permissão), o erro é engolido e o bot segue
rodando. Configuração: `LOG_FILE` (default `<projeto>/inemaccvbot.log`), `LOG_MAX_BYTES` (default
5.000.000). O token do bot e qualquer segredo nunca são logados.

Pontos instrumentados: início do bot, cada instrução recebida (chat id + texto truncado), cada
resultado de enfileiramento (job id ou erro), cada recusa + motivo, cada notificação enviada ou
falha, tentativas de acesso não autorizado (antes só `console.warn` no middleware de allowlist), e
erros capturados por `bot.catch()`.

## Documentos anexados (bug: anexo ficava sem resposta nenhuma)

**Corrigido em 2026-07-17.** Um `.md` (ou qualquer outro arquivo) mandado como anexo caía direto
no vazio: `bot.ts` só registrava `bot.on('message:text')`, e um documento chega como
`message:document` — o handler nunca disparava, o usuário não recebia nem erro nem confirmação
(indistinguível de o bot ter travado).

**Handler novo (`bot.on('message:document')`):**
- Passa pelo mesmo `bot.use()` de allowlist (roda antes de todo handler) — chat fora da lista
  continua sem NENHUMA resposta, igual ao texto.
- Loga chat id, nome do arquivo e tamanho (nunca o token).
- Tamanho: recusa (`❌`) acima de 5 MB **sem baixar nada** — o `file_size` já vem no update do
  Telegram, então o cap é checado antes de qualquer chamada de rede (é um anexo de instrução,
  texto, não mídia grande).
- Sem legenda: nunca inventa um job — responde perguntando o que fazer com o arquivo e lista
  `/skills`.
- Com legenda: baixa o arquivo (`src/media.ts`, `downloadDocument` injetado — mesmo padrão de
  `ClaudeRunner`/`QueueClient`: implementação real só em `index.ts`, testes usam fake, nenhum
  teste bate na API do Telegram) pra `ANEXOS_DIR` (config nova, default
  `<projeto>/anexos`), com nome sanitizado + prefixo de timestamp (`src/media.ts`,
  `sanitizeAnexoFilename`/`anexoFilename`): `basename()` mata path traversal, remove espaço e
  acento, tira qualquer `-` do início do nome (evita virar um token `--flag` quando o CLI do
  mkivideos re-splita o input em argv), mantém a extensão original em minúsculo.
- A legenda + o caminho baixado reusam o MESMO pipeline do texto (`processInstructionText`,
  função interna compartilhada entre `message:text` e `message:document` — não existe um segundo
  caminho de submit): se a legenda casar o formato estrito (`explicativo: ...`), vira job
  estruturado; senão vai pro fallback Claude como texto livre. Em ambos os casos, uma frase é
  anexada ao "input" do job resolvido (`documentInstruction`, mesma restrição de
  `RESEARCH_INSTRUCTION`/`narrationInstruction`: uma frase só, sem quebra de linha, sem token
  `--…`) apontando o agente de render pro caminho absoluto do arquivo como fonte/base do vídeo.
- `ANEXOS_DIR` com espaço no caminho recusa o anexo com erro claro (mesma guarda que
  `NARRACOES_DIR`).

## Perguntas sobre capacidades (bug: recusadas mesmo sendo respondíveis)

**Corrigido em 2026-07-17.** Uma pergunta como "você consegue transcrever o áudio de um reel do
Instagram?" caía em `RECUSAR:` — o classificador (`interpret.ts`) só sabia 3 categorias (pedido de
vídeo, pergunta sobre fila/jobs, ou recusa) e uma pergunta sobre CAPACIDADE do bot não casava com
nenhuma, apesar do bot ter tudo que precisa pra responder (skills registradas + texto do `/help`).

**Fix:** a categoria 2 do prompt de classificação (`buildInterpretPrompt`) foi ampliada pra cobrir
"pergunta sobre o serviço/jobs OU sobre as capacidades do bot (o que ele consegue ou não fazer)" —
mesmo formato de resposta `{"pergunta": ...}`, sem novo `kind` no union (menos superfície). `
RECUSAR:` continua reservado só pra quando nada mapeia pra skill E não é pergunta de nenhum tipo
(ex.: "jogue xadrez comigo").

`buildAnswerContext` (`src/answer.ts`) ganhou os parâmetros `defs`/`dests` e um campo novo
`capabilitiesText` (= `skillsText(defs)` + `helpText(defs, dests)`, a MESMA fonte real usada pelos
comandos `/skills` e `/help`) — assim a resposta de "o que você sabe fazer" é sempre ancorada nas
skills de verdade, nunca inventada. O prompt de `buildAnswerPrompt` instrui o Claude a responder
com base SOMENTE nessa seção quando a pergunta for de capacidade, e a dizer PLANAMENTE o que ele
NÃO faz em vez de prometer algo fora das skills registradas.

## Comandos

| Comando | Ação |
|---|---|
| `/fila` | running + queued com posição |
| `/status [id]` | detalhe de um job; sem id, visão geral + stats |
| `/cancelar <id>` | cancela job ainda na fila |
| `/enviar <id>` | manda o MP4 no chat (≤50 MB; acima, responde só o caminho) |
| `/skills` | lista as skills registradas e o formato de cada uma |
| `/help` | ajuda: formato das instruções, exemplos, todos os comandos |
| (texto) | uma instrução por linha → um job por linha |

## Configuração (`.env`, fora do git)

```
TELEGRAM_BOT_TOKEN=...
ALLOWED_CHAT_IDS=123456789          # separados por vírgula
MKIVIDEOS_CLI=~/projetos/mkivideos  # caminho do cliente CLI/banco
POLL_INTERVAL_SECONDS=60
NARRACOES_DIR=~/projetos/inemaccvbot/narracoes  # default; sem espaço no caminho
ANEXOS_DIR=~/projetos/inemaccvbot/anexos        # default; documentos anexados por usuário, sem espaço no caminho
LOG_FILE=~/projetos/inemaccvbot/inemaccvbot.log
LOG_MAX_BYTES=5000000
```

## Erros e casos-limite

- mkivideos fora do ar (`ping` falha) → responde na hora "fila indisponível", não perde a
  instrução silenciosamente.
- Destino `livesN` inexistente (ex.: `lives99`) → recusa no submit listando os válidos
  (descobertos por glob em `~/projetos/yt-pub-lives*`).
- Move falha (disco, permissão) → notifica falha do move mas mantém o caminho original
  do vídeo na mensagem.
- Fallback Claude não mapeia pra skill registrada → recusa com explicação + `/help`.
- Restart do bot → watcher retoma dos jobs pendentes no SQLite local (nada em memória).

## Testes

- **vitest**: parser (formato, múltiplas linhas, campos em ordem variada, destino
  inválido, flag pesquisa), mapeamento `livesN` → caminho, registro de skills.
- **Smoke manual**: fluxo ponta a ponta com 1 job real (submit → fila → done → move →
  notificação) e 1 recusa (skill inexistente).

## Fora de escopo (agora)

- Skill de carrossel (aguarda `timesmkt3`); entra depois via config.
- Cliente HTTP v2 do mkivideos (quando existir `POST /jobs`, trocar o wrapper é isolado
  em `queue-client.ts`).
- Dashboard próprio (o mkivideos já tem).
