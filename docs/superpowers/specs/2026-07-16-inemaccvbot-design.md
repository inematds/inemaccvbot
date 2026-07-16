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
