# inemaccvbot — backlog v2

Itens decididos mas adiados. O v1 (spec `superpowers/specs/2026-07-16-inemaccvbot-design.md`)
está implementado e revisado; nada aqui é bug, é evolução.

---

## 1. Skill de carrossel

Virá de uma parte do `timesmkt3` (ainda não existe). Quando existir: adicionar entrada em
`config/skills.json` (`{command, mkiSkill, description, example}`) e reiniciar — o registro é
plugável, sem mudança de código. A skill precisa existir na fila mkivideos.

---

## 2. Residuais do review final (não-bloqueadores)

- **`--pasta` é o único slot argv sem guarda de espaço** (`src/skills.ts:24`). Só alcançável via
  `PROJETOS_DIR` (operador, não usuário). Mesma classe do bug de `curso`/`modulo` que o review
  final pegou (o CLI do mkivideos re-junta argv e re-splita por espaço).
  Sugestão: um assert único em `buildAddArgs` cobrindo todos os valores de flag, em vez da
  validação duplicada nos dois chamadores — foi essa duplicação que deixou o bug existir.
- **Assunto com token `--` é engolido** pelo loop de flags do mkivideos (`queue.ts:40-47`).
  Ex.: `explicativo: comparar --vertical vs horizontal` seta vertical e perde o token.
  Pré-existente, cosmético, só usuários da allowlist.
- **`ALLOWED_CHAT_IDS` malformado falha fechado, em silêncio** (`src/config.ts`): entrada
  inválida é descartada por `.filter(Number.isFinite)` → lista vazia → bot ignora todo mundo.
  Seguro (não abre acesso), mas um typo vira "o bot não me responde" sem explicação.
  Sugestão: logar no boot os ids carregados.
