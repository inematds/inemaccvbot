# inemaccvbot

Bot Telegram (`@inemaccvbot`) que serve de **cliente fino** da fila de vídeos
[mkivideos](../mkivideos). Recebe instruções em texto (uma por linha = um job), traduz para
comandos da fila, acompanha o andamento e avisa quando cada vídeo fica pronto.

- Spec: [`docs/superpowers/specs/2026-07-16-inemaccvbot-design.md`](docs/superpowers/specs/2026-07-16-inemaccvbot-design.md)
- Plano: `docs/superpowers/plans/2026-07-16-inemaccvbot.md`
- Guia publicado (landing + passo a passo): https://inematds.github.io/inemaccvbot/guia/

## 1. O que é / o que não é

O inemaccvbot **não renderiza vídeo nenhum**. Ele não tem motor de fila próprio, não sabe
gerar roteiro, imagem ou narração — tudo isso é feito pelo daemon **mkivideos**, que roda como
serviço systemd separado e é o dono de verdade da fila (`video_jobs`), do worker e do render.

O bot faz três coisas:

1. **Traduz** uma instrução de texto (formato semi-estruturado, ou texto livre interpretado por
   Claude) em um comando `mkivideos add`.
2. **Consulta** a fila (posição, status, stats) via CLI/API do mkivideos.
3. **Vigia** os jobs que ele mesmo enfileirou e avisa no Telegram quando terminam — com nome,
   caminho, duração, destino e (se pedido) a narração em texto.

E o bot **nunca cria conteúdo fora de uma skill registrada**: uma instrução que não mapeia para
nenhuma das skills em `config/skills.json` é recusada com explicação, nunca "inventada" via
texto livre.

## 2. Dependências

| Dependência | Por quê |
|---|---|
| **Node** | testado com Node 24 (`v24.13.0` no ambiente de desenvolvimento); `tsconfig.json` compila para `ES2022`/`NodeNext`, então qualquer Node ≥ 20 (LTS ativo) deve funcionar. O guia publicado recomenda Node 20+. |
| **npm** | instala as dependências e roda os scripts do `package.json`. |
| **DUAS instâncias do daemon mkivideos rodando** — `mkivideos.service` (`systemctl --user status mkivideos`, fila de vídeo: `explicativo`/`curso`/`demo`, dashboard `:3142`) **e** `mkitexto.service` (`systemctl --user status mkitexto`, fila de texto: `transcrever`/`dublar` via inemavox, dashboard `:3143`) | são o motor das duas filas e donos do render/download. O bot faz `ping()` (`GET /api/stats` de cada dashboard) SEPARADAMENTE por fila antes de aceitar uma instrução — se só uma das duas estiver fora do ar, o bot **recusa apenas as instruções dessa fila** e segue aceitando normalmente as da outra. Repositório: [`~/projetos/mkivideos`](../mkivideos) (mesmo binário pras duas instâncias, só o `MKIVIDEOS_DB`/dashboard mudam — ver seção 8 "Instalar o `mkitexto.service`" abaixo). |
| **CLI `claude`** | usado em dois pontos: (1) o bot chama `claude --model opus -p <prompt>` para interpretar texto livre que não bate no parser leve (`src/interpret.ts`); (2) o próprio agente de render do mkivideos roda como uma sessão `claude -p` — é essa sessão, sem `--allowedTools`, que dá ao vídeo acesso à web quando a flag `pesquisa` é usada, e que baixa/transcreve via inemavox para `transcrever`/`dublar`. Sem o `claude` no PATH, nada disso funciona. |
| **Skills instaladas** — vídeo: `video-explicativo`, `videos-cursos-inema`, `video-demonstrativo`; texto: os scripts do **inemavox** (`~/projetos/inemavox`, download + Whisper local + dublagem) | o bot só **nomeia** essas skills nos comandos que manda pro mkivideos/mkitexto (`config/skills.json`, campo `queue` decide qual fila); quem precisa tê-las instaladas e utilizáveis é o agente de render, não o bot. |
| **Token de bot do Telegram** (`@BotFather`) + **seu chat id** | credenciais de acesso — ver seção de instalação para como obter cada um. |
| **Pastas `yt-pub-lives<N>`** | só são necessárias se você usar o campo `livesN` (destino) numa instrução. Sem elas, o vídeo fica no output padrão da skill mesmo. |
| **`better-sqlite3`, `dotenv`, `grammy`** (deps de produção) | `grammy` é o client de Telegram (long-polling); `dotenv` carrega o `.env`; `better-sqlite3` guarda o estado local (`job id ↔ chat id/flags`) num `state.db` — é um binário nativo, então `npm i` compila um addon C++ para a sua plataforma (precisa de toolchain de build; em geral já vem pronto via prebuilt binary do pacote). |

## 3. Instalação passo a passo

```bash
git clone <url-do-repo> inemaccvbot
cd inemaccvbot
npm i
cp .env.example .env
```

Edite o `.env` preenchendo pelo menos `TELEGRAM_BOT_TOKEN` e `ALLOWED_CHAT_IDS` (ver tabela
completa na seção 4). O token vem do **@BotFather** no Telegram (`/newbot` ou `/token` num bot
já existente).

### Descobrindo seu chat id

**Cuidado com a armadilha**: o bot **exige** `ALLOWED_CHAT_IDS` para sequer subir (ver
`src/config.ts` — `loadConfig` lança erro se a variável estiver ausente). Ou seja, você **não
consegue** descobrir seu chat id rodando o bot e olhando o log dele, porque ele nem inicia sem
essa variável já preenchida.

O jeito que funciona é perguntar direto pra API do Telegram, usando o próprio token do bot:

1. Mande qualquer mensagem para o seu bot no Telegram (ele ainda não vai responder, tudo bem).
2. Rode:

   ```bash
   curl "https://api.telegram.org/bot<SEU-TOKEN>/getUpdates?timeout=25"
   ```

   Note o `?timeout=25` — é um long-poll. Um `getUpdates` simples (sem `timeout`) costuma
   voltar vazio; o long-poll é o que confiavelmente traz o update com a sua mensagem.
3. No JSON de resposta, o chat id está em `result[0].message.chat.id`.

Preencha `ALLOWED_CHAT_IDS` com esse número (ou vários, separados por vírgula, se mais de uma
pessoa/chat vai falar com o bot).

### Build e execução manual (teste rápido)

```bash
npm run build
npm run start     # roda dist/index.js
# ou, sem buildar, direto do TypeScript:
npm run dev        # tsx src/index.ts
```

### Instalação como serviço systemd (uso contínuo)

```bash
mkdir -p ~/.config/systemd/user
cp deploy/inemaccvbot.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now inemaccvbot
```

Ver a seção 4 (**Operação do serviço**) para o que cada comando faz, como deixar o bot
realmente sempre ativo (inclusive depois de deslogar/reiniciar a máquina) e o dia a dia de
reiniciar/parar/depurar.

### Instalar o `mkitexto.service` (segunda fila, texto)

O bot fala com DUAS instâncias do daemon mkivideos — a fila de vídeo (`mkivideos.service`, já
citada acima) e uma segunda instância, **`mkitexto.service`**, dedicada às skills `transcrever`/
`dublar` (minutos, contra ~15min de um render — por isso são filas separadas, ver seção "Duas
filas" do spec). O unit file e o passo a passo de instalação de `mkitexto.service` vivem no
repositório do próprio daemon, [`~/projetos/mkivideos`](../mkivideos) (fora do escopo deste repo
— o `inemaccvbot` só é CLIENTE das duas filas, nunca dono delas). Depois de instalado e ativo
(`systemctl --user status mkitexto`), o bot já enxerga a segunda fila automaticamente via
`MKITEXTO_DB`/`MKITEXTO_DASH` no `.env` (defaults já apontam pro banco/porta certos — ver seção 5).
Sem `mkitexto.service` no ar, o bot continua funcionando normalmente para a fila de vídeo; só as
instruções `transcrever:`/`dublar:` ficam recusadas com "fila indisponível" até o serviço subir.

## 4. Operação do serviço (systemd --user)

O `deploy/inemaccvbot.service` roda `node ~/projetos/inemaccvbot/dist/index.js`
(`ExecStart=/usr/bin/node %h/projetos/inemaccvbot/dist/index.js`), com `WorkingDirectory` no
repo e um `PATH` explícito — necessário porque uma unit de usuário do systemd **não herda o
PATH do seu shell**, e o bot chama `claude` e `node` via shell-out (`execFile`).

### Deixar o bot sempre ativo (sobe sozinho no boot, volta sozinho se cair)

```bash
mkdir -p ~/.config/systemd/user
cp deploy/inemaccvbot.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now inemaccvbot
loginctl enable-linger $USER
```

- `daemon-reload` — recarrega as units do systemd de usuário depois de copiar/editar o arquivo.
- `enable` — é o que faz o bot **subir sozinho** em todo boot/login (registra a unit em
  `WantedBy=default.target`, presente no `deploy/inemaccvbot.service`). `--now` já inicia o
  processo imediatamente, sem esperar o próximo boot.
- `Restart=on-failure` + `RestartSec=10` (já no unit) — é o que faz o bot **voltar sozinho** se
  o processo morrer (exceção não tratada, `node` crashou etc.): o systemd tenta de novo 10s
  depois.
- **`loginctl enable-linger $USER` é o passo fácil de esquecer, e importa de verdade.** Uma
  unit `--user` normalmente só existe enquanto **você tem uma sessão de login aberta** — sem
  linger, o bot **morre quando você desloga** e **não sobe num boot sem ninguém logado** (ex.:
  reboot da máquina sem abrir sessão gráfica/SSH). Com o linger habilitado para o seu usuário,
  o systemd mantém os serviços `--user` rodando independente de sessão. Sem esse passo, `enable
  --now` sobe o bot agora, mas ele não sobrevive ao próximo logout/reboot como você provavelmente
  espera.

Conferir que está ativo:

```bash
systemctl --user status inemaccvbot
```

### Dia a dia: reiniciar, parar, depurar

```bash
systemctl --user restart inemaccvbot   # reinicia
systemctl --user stop inemaccvbot      # para
systemctl --user start inemaccvbot     # inicia de novo (sem reiniciar boot/enable)
systemctl --user disable --now inemaccvbot   # para de subir sozinho E para agora
```

- **Depois de mudar código-fonte**, o restart sozinho não basta — o serviço roda `dist/`, não
  `src/`: rode `npm run build && systemctl --user restart inemaccvbot`.
- **Depois de mudar só o `.env`**, um `systemctl --user restart inemaccvbot` já é suficiente
  (o `.env` é lido no boot do processo, via `loadConfig`/`dotenv/config`, não precisa rebuild).
- Logs ao vivo:

  ```bash
  journalctl --user -u inemaccvbot -f      # log do systemd (stdout/stderr)
  tail -f inemaccvbot.log                   # arquivo de log próprio do bot (LOG_FILE), com rotação (ver seção 5)
  ```

### Se o serviço não sobe

O erro aparece no `journalctl --user -u inemaccvbot -f`. As causas mais comuns:

- **Variável obrigatória faltando no `.env`** — `loadConfig` (`src/config.ts`) lança
  `variável obrigatória ausente no .env: <NOME>` explicitamente, então o motivo costuma estar
  ali mesmo no log, sem precisar adivinhar.
- **Daemon mkivideos fora do ar** — o bot ainda assim sobe (ele não depende do mkivideos para
  iniciar), mas toda instrução vai ser recusada com "fila mkivideos indisponível" até o
  `systemctl --user status mkivideos` voltar a ficar ativo.

## 5. Configuração — variáveis do `.env`

Todas as variáveis abaixo são lidas em `src/config.ts` (`loadConfig`). As marcadas como
**obrigatória** fazem o bot **lançar erro no boot** se ausentes.

| Variável | Obrigatória? | Default | O que é |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | **sim** | — | token do bot, do @BotFather. |
| `ALLOWED_CHAT_IDS` | **sim** | — | ids de chat autorizados a falar com o bot, separados por vírgula. Qualquer chat fora dessa lista é **ignorado em silêncio** (só logado). Entradas malformadas são descartadas silenciosamente (`Number.isFinite`) — se a lista ficar vazia por um typo, o bot sobe mas não responde a ninguém. |
| `MKIVIDEOS_DIR` | não | `/home/nmaldaner/projetos/mkivideos` | onde fica o repo do mkivideos — usado para chamar `dist/cli.js` via `node`, compartilhado pelas DUAS filas. |
| `MKIVIDEOS_DB` | não | `/home/nmaldaner/projetos/mkivideos/mkivideos.db` | banco SQLite da **fila de vídeo**, passado como env `MKIVIDEOS_DB` para o CLI invocado. |
| `MKIVIDEOS_DASH` | não | `http://localhost:3142` | URL base do dashboard/API da **fila de vídeo** (`/api/stats`, `/api/video-jobs`). |
| `MKITEXTO_DB` | não | `/home/nmaldaner/projetos/mkivideos/mkitexto.db` | banco SQLite da **fila de texto** (`transcrever`/`dublar`) — mesmo binário, banco separado. |
| `MKITEXTO_DASH` | não | `http://localhost:3143` | URL base do dashboard/API da **fila de texto**. |
| `MKIVIDEOS_TOKEN` | **sim** | — (sem default no código, de propósito) | token de autenticação da API dos dois dashboards (mesmo token pras duas filas). O código comenta explicitamente que essa credencial **vive só no `.env`**, nunca em código-fonte. |
| `POLL_INTERVAL_SECONDS` | não | `60` | intervalo (em segundos) do watcher que pergunta ao mkivideos o status dos jobs em andamento. |
| `STATE_DB` | não | `/home/nmaldaner/projetos/inemaccvbot/state.db` | SQLite local próprio do bot: mapeia `job id ↔ chat id + destino + flags (pesquisa/narração)`. É o que permite retomar o watcher depois de um restart. |
| `PROJETOS_DIR` | não | `/home/nmaldaner/projetos` | raiz onde o bot procura as pastas `yt-pub-lives<N>` para resolver o campo `livesN`. |
| `NARRACOES_DIR` | não | `/home/nmaldaner/projetos/inemaccvbot/narracoes` | pasta onde o bot grava o caminho que pede ao agente de render para salvar a narração em texto (flag `narracao`/`texto`). **Não pode conter espaço** — se contiver, o submit falha com erro explícito em vez de gerar um job corrompido. |
| `LOG_FILE` | não | `/home/nmaldaner/projetos/inemaccvbot/inemaccvbot.log` | arquivo de log próprio do bot (além de stdout/stderr). |
| `LOG_MAX_BYTES` | não | `5000000` | tamanho máximo do `LOG_FILE` antes de rotacionar; mantém exatamente **um** backup (`<arquivo>.1`), nunca mais que isso. |

## 6. Como usar

### Formato das instruções

Uma linha = uma instrução = um job. Várias linhas na mesma mensagem enfileiram vários jobs de
uma vez.

```
<skill>: <assunto ou link> [| campo] [| campo] ...
```

- `<skill>` precisa ser um comando registrado em `config/skills.json` (hoje: `explicativo`,
  `curso`, `demo`, `transcrever`, `dublar`, `reel`) — case-insensitive.
- O que vem logo depois do `:` (antes do primeiro `|`) é o assunto/link, obrigatório. Vazio
  → recusa com mensagem explicando o motivo.
- Os demais campos, separados por `|`, podem vir em **qualquer ordem**.

Campos aceitos (`src/parser.ts`):

| Campo | Sinônimos | Efeito |
|---|---|---|
| `9:16` | `vertical` | formato Shorts/Reels (default é `16:9`/horizontal). |
| `16:9` | `horizontal` | força horizontal explicitamente (raramente necessário, já é o default). |
| `pesquisa` | `pesquisar` | anexa ao input do job uma instrução para o agente de render pesquisar o assunto na web antes de escrever o roteiro. |
| `narracao` | `narração`, `texto` | pede que a narração completa (texto do roteiro falado) também seja entregue, além do vídeo. |
| `modulo <valor>` | — | rótulo de módulo (skill `curso`). O `<valor>` **não pode conter espaço** — o CLI do mkivideos re-junta e re-splita o argv, e um valor com espaço corromperia o comando. Ex.: `modulo t1m1`. |
| `curso <valor>` | — | rótulo de curso, mesma regra de "sem espaço". Ex.: `curso skillsx`. |
| `lives<N>` | — | destino em `~/projetos/yt-pub-lives<N>/imports/videos/`. Só aceito se a pasta `yt-pub-lives<N>` existir; senão a instrução é recusada listando os destinos válidos encontrados. Para todo comando **exceto `reel`**, isso MOVE o vídeo pronto (`--pasta` passado ao mkivideos). Para `reel`, ver seção "reel: avatar → vídeo" abaixo — é CÓPIA por default. |
| `mover` | — | só tem efeito na skill `reel`: troca o default de CÓPIA para MOVER o resultado pro destino `lives<N>`. Ignorado por qualquer outra skill. |
| `visuais` | — | só tem efeito na skill `reel`: usa o Modo 3 (visuais) da skill `reel-edita-inema` em vez do explicador (Modo 2, default). |

Qualquer campo que não bata em nenhuma dessas formas → a linha inteira é **recusada** com
`campo desconhecido: "<texto>"`.

### Exemplos reais

```
explicativo: O que é RAG | 9:16 | lives3
explicativo: Computação quântica | pesquisa | lives2
explicativo: O que é RAG | narracao
curso: https://inematds.github.io/skillsx/ | modulo t1m1
curso: https://inematds.github.io/skillsx/ | curso skillsx | modulo t1m1
demo: https://app.exemplo.com | lives7
reel: /home/nmaldaner/projetos/output/avatar/avatar.mp4 | lives3
reel: /home/nmaldaner/projetos/output/avatar/avatar.mp4 | lives3 | mover
reel: /home/nmaldaner/projetos/output/avatar/avatar.mp4 | visuais
```

### `reel`: avatar → vídeo 9:16 empilhado (skill `reel-edita-inema`)

O `input` do comando `reel` **não é um assunto/link — é o caminho de um MP4 de avatar HeyGen**.
Duas formas de mandar esse avatar:

- **caminho no texto** (forma primária) — `reel: /caminho/para/avatar.mp4 | lives3`. Avatares
  costumam passar dos 20 MB que o Telegram permite um bot baixar, então o caminho no disco é a
  via confiável. O bot recusa na hora, com mensagem clara, se o arquivo não existir.
- **anexo** — só funciona **<20 MB**. Mande o `.mp4` anexado com a legenda **`reel`** (bare, sem
  `assunto:`) ou `reel | lives3 | mover` — o caminho baixado vira o input automaticamente.

**Cópia por default, move só com `mover`** — diferente de toda outra skill do bot (que sempre
MOVE via `--pasta`). A skill `reel-edita-inema` escreve o resultado em
`~/projetos/output/<slug>/`; se um destino `lives<N>` foi pedido, é o **watcher do bot** (não o
CLI do mkivideos) quem copia (default, mantém o original) ou move (com `| mover`) o arquivo pra
lá depois do job terminar `done`. Sem destino nenhum, o reel fica só em `~/projetos/output/`. A
mensagem de conclusão diz o que realmente aconteceu: `📋 copiado para lives3` / `📦 movido para
lives3` — ou, se a cópia/move falhar, avisa a falha sem nunca perder o caminho original.

Mensagem com dois jobs de uma vez:

```
explicativo: O que é RAG | 9:16
demo: https://app.exemplo.com | lives7
```

### Texto livre

Qualquer linha que não bata no formato acima (não começa com `<skill>:` reconhecido) é
acumulada e mandada, junto com as demais linhas livres da mensagem, para `claude --model opus
-p` interpretar (`src/interpret.ts`). O prompt instrui o Claude a:

- extrair **todo pedido que mapeia** para uma skill registrada e gerar o job correspondente;
- reportar em `ignorado` a parte do pedido que não mapeia (ex.: "e me manda por e-mail") **sem**
  bloquear o resto — a resposta ao usuário mostra `⚠️ não vou fazer: <ignorado>` junto com a
  confirmação dos jobs que foram enfileirados;
- só recusar o pedido **inteiro** (`RECUSAR: <motivo>`) quando nada nele mapear para nenhuma
  skill registrada.

Ou seja: texto livre nunca "inventa" um vídeo fora das três skills — ele só encaixa o pedido no
que já existe, ou avisa que não vai fazer.

### Comandos

| Comando | Faz |
|---|---|
| `/fila` | lista jobs `running` + `queued` com posição na fila. |
| `/status [id]` | detalhe de um job específico; sem `id`, mostra visão geral + estatísticas. |
| `/cancelar <id>` | cancela um job ainda na fila. |
| `/enviar <id>` | manda o `.mp4` no chat, **se ≤ 50 MB** (limite do próprio Telegram); acima disso, responde só o caminho do arquivo no disco. |
| `/skills` | lista as skills registradas, descrição e exemplo de cada uma. |
| `/help` (ou `/start`) | ajuda completa: formato, campos, exemplos, comandos. |

## 7. O que acontece depois que você manda

```
Telegram → parser.ts → queue-client.ts (mkivideos add) → daemon mkivideos → watcher.ts (poll)
```

1. **Antes de qualquer coisa**, o bot chama `ping()` no dashboard do mkivideos
   (`GET /api/stats`). Se falhar, a mensagem inteira é recusada com "fila mkivideos
   indisponível" — nada é enfileirado silenciosamente.
2. Cada instrução válida vira um comando `mkivideos add <mkiSkill> <input> --silencioso
   [--vertical] [--pasta <dest>] [--curso <valor>] [--modulo <valor>]` (`src/skills.ts`,
   `buildAddArgs`). O bot sempre passa `--silencioso` porque é ele mesmo — via watcher — quem
   avisa a conclusão, não o mkivideos.
3. O daemon mkivideos **serializa** o render (concorrência 1, FIFO) — é ele quem de fato
   dispara o agente `claude -p` que escreve o roteiro, gera as cenas e renderiza o vídeo.
4. O `watcher.ts` do bot faz **poll a cada `POLL_INTERVAL_SECONDS` (default 60s)** nos jobs que
   ele mesmo submeteu (rastreados em `STATE_DB`). Quando um job muda para um status terminal:
   - **`done`**: mensagem com nome/skill, caminho do arquivo (`result_path`), duração
     (calculada de `started_at`/`finished_at`, ou omitida se algum timestamp faltar), e — se um
     destino `livesN` foi pedido — se o arquivo realmente caiu dentro daquela pasta (o watcher
     **verifica de fato** com `path.relative`, não assume; o `--pasta` é passado ao mkivideos,
     que é quem move o arquivo, mas o bot confirma o resultado antes de afirmar sucesso). Se
     `narracao` foi pedida, avisa se o arquivo de narração existe (e manda a seguir) ou admite
     que o agente não gerou o arquivo — nunca afirma entrega que não aconteceu.
   - **`failed`**: mensagem com o motivo resumido do erro (até 500 caracteres) e um lembrete de
     `/status <id>` para o detalhe completo.
   - **`canceled`**: aviso simples de cancelamento.
5. Um restart do bot não perde nada: o watcher retoma do que está pendente no `STATE_DB` — não
   há estado em memória.

## 8. Adicionar uma skill nova

O registro de skills é plugável via `config/skills.json`, sem mudar código:

```json
{
  "command": "meucomando",
  "mkiSkill": "explicativo",
  "description": "descrição curta que aparece em /skills e /help",
  "example": "meucomando: assunto | 9:16"
}
```

Depois de editar, reinicie o bot (`systemctl --user restart inemaccvbot` ou `npm run dev`/
`npm run start`).

**Atenção**: o campo `mkiSkill` precisa ser um valor que o **mkivideos** já reconhece. Hoje o
tipo `VideoJob['skill']` em `~/projetos/mkivideos/src/types.ts` é a union literal
`'explicativo' | 'curso' | 'demo'` — **só esses três valores**. Ou seja, registrar uma skill
nova aqui (ex.: um futuro comando de carrossel) só funciona de ponta a ponta se o mkivideos
também ganhar suporte a esse valor — editar só `config/skills.json` não basta para uma skill
verdadeiramente nova, apenas para expor um **comando novo** no Telegram que aponte para uma das
três skills já existentes no mkivideos (com uma descrição/exemplo diferentes).

## 9. Limites e pegadinhas conhecidos

- **`pesquisa` não bloqueia o bot.** A pesquisa acontece *dentro* do job de render (o agente do
  mkivideos roda `claude -p` sem `--allowedTools`, com acesso à web), não no bot. O submit no
  Telegram é instantâneo; o que muda é que o job em si demora mais para terminar.
- **`curso`/`modulo` não podem ter espaço.** O CLI do mkivideos re-junta o argv recebido e
  re-splita por espaço internamente — um valor com espaço corromperia o job. O bot recusa a
  instrução em vez de arriscar um job quebrado.
- **`/enviar` tem teto de 50 MB** (limite do próprio Telegram para bots). Acima disso, o bot
  responde só o caminho do arquivo no disco.
- **`ALLOWED_CHAT_IDS` malformado falha fechado, em silêncio.** Um id inválido na lista é
  descartado (`Number.isFinite`); se sobrar uma lista vazia, o bot sobe normalmente mas não
  responde a ninguém, sem aviso — vale conferir a variável se o bot "não responder" depois de
  configurado (item conhecido em `docs/V2-BACKLOG.md`).
- **`--pasta` é o único slot de argv sem guarda de espaço** (`src/skills.ts`). Só alcançável via
  `PROJETOS_DIR`, que é configuração de operador, não entrada de usuário — mas é um resíduo
  documentado no backlog.
- **Um token `--` dentro do assunto é engolido** pelo parser de flags do mkivideos (ex.:
  `explicativo: comparar --vertical vs horizontal` ativa o modo vertical e perde o texto
  literal `--vertical`). Cosmético, só afeta quem já está na allowlist.
- **Skill de carrossel ainda não existe** — está fora do lançamento, depende de uma peça do
  `timesmkt3` que ainda não foi construída (ver `docs/V2-BACKLOG.md`).

## 10. Desenvolvimento

```bash
npm test          # vitest run — 88 testes, 10 arquivos, todos passando neste momento
npm run build      # tsc — compila src/ para dist/ (ES2022/NodeNext)
npm run dev         # tsx src/index.ts — roda direto do TypeScript, sem build
```

Os testes ficam junto do código-fonte em `src/*.test.ts` (um arquivo de teste por módulo:
`bot`, `config` — via os demais —, `dests`, `help`, `interpret`, `parser`, `queue-client`,
`skills`, `state`, `watcher`).

Mapa da documentação:

- Spec: [`docs/superpowers/specs/2026-07-16-inemaccvbot-design.md`](docs/superpowers/specs/2026-07-16-inemaccvbot-design.md)
- Plano: `docs/superpowers/plans/2026-07-16-inemaccvbot.md`
- Backlog v2 (itens adiados, não bugs): [`docs/V2-BACKLOG.md`](docs/V2-BACKLOG.md)
- Guia publicado (landing + passo a passo, GitHub Pages): https://inematds.github.io/inemaccvbot/guia/

## 11. Segurança

- **Allowlist é a única barreira de acesso.** Todo update do Telegram passa por um middleware
  que confere `chat.id` contra `ALLOWED_CHAT_IDS`; fora da lista, a mensagem é **ignorada em
  silêncio** (sem resposta ao remetente) e só fica registrada no log.
- **`.env` nunca é versionado** (`.gitignore`) e nenhuma credencial vive em código-fonte —
  `MKIVIDEOS_TOKEN`, por exemplo, é declarado sem default justamente para forçar que a
  credencial exista só no `.env` local.
- O token do bot e qualquer segredo **nunca são escritos no log** (`src/log.ts` só grava
  instrução truncada, ids de chat/job e mensagens de erro).
