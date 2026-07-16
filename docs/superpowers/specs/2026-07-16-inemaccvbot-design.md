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
| Pesquisa opcional | Flag `pesquisa` na instrução (ou pedido em texto livre) roda pesquisa web antes de enfileirar e gera briefing como contexto pra skill |
| Stack | Node/TypeScript (grammY), mesma stack do openpcbot/mkivideos; integração **modo A** (CLI `mki.sh` + banco compartilhado) |
| Deploy | systemd de usuário `inemaccvbot.service`; token no `.env` (nunca commitado) |

## Arquitetura (~5 módulos)

```
Telegram ⇄ bot.ts ─→ parser.ts ─→ [pesquisa opcional] ─→ queue-client.ts ─→ mkivideos (daemon)
                        │                                        ▲
                        └── fallback claude -p (Opus/médio)      │ poll ~60s
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
- Várias linhas = vários jobs numa mensagem só.
- Texto livre fora do padrão → Claude interpreta (mesmos campos de saída).

## Pesquisa opcional (briefing)

Quando pedida, roda **no submit** (antes de enfileirar): uma chamada `claude -p`
(Opus, esforço médio) com busca web (WebSearch/agent-reach) gera `briefing.md`
(fatos, dados, ângulos, fontes) salvo junto do job e passado como **contexto extra
pra skill** no render. Na fila o job aparece com marcador de pesquisa. O render pesado
continua serializado no mkivideos; a pesquisa é leve e roda no bot.

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
