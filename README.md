# inemaccvbot

Bot Telegram fino da fila de vídeos [mkivideos](../mkivideos). Recebe instruções
(1 linha = 1 job), enfileira nas skills registradas (`explicativo`, `curso`, `demo`),
notifica quando termina e move o vídeo para `yt-pub-livesN/imports/videos`.

- Spec: `docs/superpowers/specs/2026-07-16-inemaccvbot-design.md`
- Plano: `docs/superpowers/plans/2026-07-16-inemaccvbot.md`

## Rodar

    cp .env.example .env   # preencher token + chat ids
    npm i && npm run build
    mkdir -p ~/.config/systemd/user
    cp deploy/inemaccvbot.service ~/.config/systemd/user/
    systemctl --user daemon-reload
    systemctl --user enable --now inemaccvbot   # ou: npm run dev

## Uso (no Telegram)

    explicativo: O que é RAG | 9:16 | lives3
    curso: https://inematds.github.io/skillsx/ | modulo t1m1
    demo: https://app.exemplo.com | lives7

Comandos: `/fila`, `/status [id]`, `/cancelar <id>`, `/enviar <id>`, `/skills`, `/help`.
Texto livre também funciona (interpretado por Claude Opus) — mas só com skills registradas.

## Adicionar uma skill (ex.: carrossel futuro)

Editar `config/skills.json` com `{command, mkiSkill, description, example}` e reiniciar.
A skill precisa existir na fila mkivideos.
