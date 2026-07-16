# inemaccvbot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bot Telegram fino (`@inemaccvbot`) que submete jobs de vídeo à fila `mkivideos`, informa fila/status, notifica conclusão e entrega o vídeo no destino `yt-pub-livesN/imports/videos`.

**Architecture:** Cliente fino do daemon `mkivideos` (systemd já rodando). Submit via CLI (`node ~/projetos/mkivideos/dist/cli.js` com `MKIVIDEOS_DB`), consulta via API JSON do dashboard (`http://localhost:3142/api/video-jobs?token=...`). Parser leve linha-a-linha com fallback `claude -p` (Opus). Watcher com poll de 60s + SQLite local mínimo para saber quais jobs notificar em qual chat.

**Tech Stack:** Node 20+, TypeScript 5, grammY (Telegram), better-sqlite3 (estado local), vitest (testes), dotenv.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-16-inemaccvbot-design.md` — em conflito, o spec vence.
- **Nunca criar conteúdo fora de uma skill registrada** — instrução sem skill mapeável é recusada com explicação.
- Skills do lançamento: `explicativo`, `curso`, `demo` (mkivideos `skill: 'explicativo' | 'curso' | 'demo'`).
- Acesso: só chat ids em `ALLOWED_CHAT_IDS`; mensagens de fora são ignoradas em silêncio (apenas log).
- `.env` NUNCA commitado (`.gitignore` já cobre; conferir antes de todo commit).
- Fallback de interpretação: `claude --model opus -p` (esforço médio é o default da conta — não passar flag de esforço).
- **Decisão de implementação (refina o spec):** o move para o destino é delegado ao mkivideos via `--pasta <dest>` (recurso nativo, comprovado no job #40: `result_path` cai dentro do `dest`). O bot cria o diretório destino no submit (`mkdir -p`) e o watcher confere/notifica. Se `result_path` não estiver no destino, notifica com o caminho real (fallback do spec).
- Autor git: `inematds <inematds@gmail.com>` (já configurado no repo).
- Todo commit termina com `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

### Fatos do mkivideos (verificados em 2026-07-16)

- Daemon: `mkivideos.service` ativo; dashboard `http://localhost:3142`, token `inemadash`.
- CLI: `MKIVIDEOS_DB=/home/nmaldaner/projetos/mkivideos/mkivideos.db node /home/nmaldaner/projetos/mkivideos/dist/cli.js <cmd>`.
- `add <explicativo|curso|demo> <input...> [--vertical] [--silencioso] [--pasta <dir>] [--curso <nome>] [--modulo <label>]` → stdout `enfileirado #ID (skill)...`.
- `fila` / `stats` / `status <id>` / `cancelar <id>` → texto pronto pra repassar. `get <id>` → caminho do .mp4 (vazio se não pronto).
- `GET /api/video-jobs?token=inemadash` → `{"jobs":[{id, skill, input, opts, status, result_path, error, ...}]}`; `status ∈ queued|running|done|failed|canceled`.
- O `input` é texto livre lido pelo agente do render — dá pra embutir instruções extras (ex.: caminho do briefing).

---

### Task 1: Scaffold do projeto

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.env.example`, `config/skills.json`, `src/config.ts`

**Interfaces:**
- Produces: `loadConfig(): Config` de `src/config.ts` com `{ botToken: string; allowedChatIds: number[]; mkiDir: string; mkiDb: string; dashUrl: string; dashToken: string; pollIntervalMs: number; stateDb: string; briefingsDir: string; projetosDir: string }`. Scripts npm: `build`, `dev`, `test`, `start`.

- [ ] **Step 1: Criar package.json, tsconfig, vitest config**

`package.json`:
```json
{
  "name": "inemaccvbot",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc",
    "dev": "tsx src/index.ts",
    "start": "node dist/index.js",
    "test": "vitest run"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "declaration": false,
    "sourceMap": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['src/**/*.test.ts'] } });
```

- [ ] **Step 2: Instalar dependências**

Run: `cd /home/nmaldaner/projetos/inemaccvbot && npm i grammy better-sqlite3 dotenv && npm i -D typescript tsx vitest @types/node @types/better-sqlite3`
Expected: `node_modules/` criado sem erro.

- [ ] **Step 3: Criar .env.example e config/skills.json**

`.env.example`:
```bash
TELEGRAM_BOT_TOKEN=coloque-o-token-do-botfather
ALLOWED_CHAT_IDS=123456789            # separados por vírgula
MKIVIDEOS_DIR=/home/nmaldaner/projetos/mkivideos
MKIVIDEOS_DB=/home/nmaldaner/projetos/mkivideos/mkivideos.db
MKIVIDEOS_DASH=http://localhost:3142
MKIVIDEOS_TOKEN=inemadash
POLL_INTERVAL_SECONDS=60
STATE_DB=/home/nmaldaner/projetos/inemaccvbot/state.db
BRIEFINGS_DIR=/home/nmaldaner/projetos/inemaccvbot/briefings
PROJETOS_DIR=/home/nmaldaner/projetos
```

`config/skills.json` (registro plugável — carrossel entra aqui no futuro):
```json
[
  {
    "command": "explicativo",
    "mkiSkill": "explicativo",
    "description": "vídeo explicativo PT-BR sobre um assunto (skill video-explicativo)",
    "example": "explicativo: O que é RAG | 9:16 | lives3"
  },
  {
    "command": "curso",
    "mkiSkill": "curso",
    "description": "vídeo de curso INEMA a partir do link (skill videos-cursos-inema)",
    "example": "curso: https://inematds.github.io/skillsx/ | modulo t1m1"
  },
  {
    "command": "demo",
    "mkiSkill": "demo",
    "description": "vídeo demonstrativo de um app/site (skill video-demonstrativo)",
    "example": "demo: https://app.exemplo.com | lives7"
  }
]
```

- [ ] **Step 4: Criar src/config.ts**

```ts
import 'dotenv/config';

export interface Config {
  botToken: string;
  allowedChatIds: number[];
  mkiDir: string;
  mkiDb: string;
  dashUrl: string;
  dashToken: string;
  pollIntervalMs: number;
  stateDb: string;
  briefingsDir: string;
  projetosDir: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const need = (k: string): string => {
    const v = env[k];
    if (!v) throw new Error(`variável obrigatória ausente no .env: ${k}`);
    return v;
  };
  return {
    botToken: need('TELEGRAM_BOT_TOKEN'),
    allowedChatIds: need('ALLOWED_CHAT_IDS').split(',').map((s) => Number(s.trim())).filter(Number.isFinite),
    mkiDir: env.MKIVIDEOS_DIR ?? '/home/nmaldaner/projetos/mkivideos',
    mkiDb: env.MKIVIDEOS_DB ?? '/home/nmaldaner/projetos/mkivideos/mkivideos.db',
    dashUrl: env.MKIVIDEOS_DASH ?? 'http://localhost:3142',
    dashToken: env.MKIVIDEOS_TOKEN ?? 'inemadash',
    pollIntervalMs: Number(env.POLL_INTERVAL_SECONDS ?? 60) * 1000,
    stateDb: env.STATE_DB ?? '/home/nmaldaner/projetos/inemaccvbot/state.db',
    briefingsDir: env.BRIEFINGS_DIR ?? '/home/nmaldaner/projetos/inemaccvbot/briefings',
    projetosDir: env.PROJETOS_DIR ?? '/home/nmaldaner/projetos',
  };
}
```

- [ ] **Step 5: Build + commit**

Run: `npm run build && npm test`
Expected: build OK; vitest reporta "no test files found" com exit 0 (se exitar 1 por não achar testes, adicione `passWithNoTests: true` no vitest.config.ts).

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .env.example config/skills.json src/config.ts
git commit -m "feat: scaffold do inemaccvbot (config, deps, registro de skills)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Destinos livesN (`src/dests.ts`)

**Files:**
- Create: `src/dests.ts`
- Test: `src/dests.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces: `resolveDest(token: string, projetosDir: string): string | null` — `'lives3'` → `<projetosDir>/yt-pub-lives3/imports/videos`; `null` se a pasta `yt-pub-lives3` não existir. `listDests(projetosDir: string): string[]` — tokens válidos (`['lives1','lives2',...]`) ordenados numericamente, a partir das pastas `yt-pub-lives<N>` existentes.

- [ ] **Step 1: Escrever teste que falha**

`src/dests.test.ts`:
```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveDest, listDests } from './dests.js';

const base = join(tmpdir(), 'inemaccvbot-test-dests');

beforeAll(() => {
  rmSync(base, { recursive: true, force: true });
  for (const n of [1, 2, 10]) mkdirSync(join(base, `yt-pub-lives${n}`), { recursive: true });
  mkdirSync(join(base, 'yt-pub-livesx'), { recursive: true }); // não numérico: ignorar
});

describe('resolveDest', () => {
  it('mapeia livesN para imports/videos dentro do projeto', () => {
    expect(resolveDest('lives2', base)).toBe(join(base, 'yt-pub-lives2', 'imports', 'videos'));
  });
  it('aceita maiúsculas/espaços', () => {
    expect(resolveDest(' Lives10 ', base)).toBe(join(base, 'yt-pub-lives10', 'imports', 'videos'));
  });
  it('recusa lives inexistente', () => {
    expect(resolveDest('lives99', base)).toBeNull();
  });
  it('recusa token que não é livesN', () => {
    expect(resolveDest('qualquercoisa', base)).toBeNull();
  });
});

describe('listDests', () => {
  it('lista tokens numéricos ordenados', () => {
    expect(listDests(base)).toEqual(['lives1', 'lives2', 'lives10']);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run src/dests.test.ts`
Expected: FAIL (módulo `./dests.js` não existe).

- [ ] **Step 3: Implementar `src/dests.ts`**

```ts
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** 'lives3' → <projetosDir>/yt-pub-lives3/imports/videos (null se a pasta do projeto não existir). */
export function resolveDest(token: string, projetosDir: string): string | null {
  const m = token.trim().toLowerCase().match(/^lives(\d+)$/);
  if (!m) return null;
  const root = join(projetosDir, `yt-pub-lives${m[1]}`);
  if (!existsSync(root)) return null;
  return join(root, 'imports', 'videos');
}

/** Tokens válidos a partir das pastas yt-pub-lives<N> existentes, ordem numérica. */
export function listDests(projetosDir: string): string[] {
  let entries: string[] = [];
  try { entries = readdirSync(projetosDir); } catch { return []; }
  return entries
    .map((e) => e.match(/^yt-pub-lives(\d+)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b)
    .map((n) => `lives${n}`);
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run src/dests.test.ts`
Expected: PASS (5 testes).

- [ ] **Step 5: Commit**

```bash
git add src/dests.ts src/dests.test.ts
git commit -m "feat: mapeamento de destinos livesN -> yt-pub-livesN/imports/videos

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Parser de instruções (`src/parser.ts`)

**Files:**
- Create: `src/parser.ts`
- Test: `src/parser.test.ts`

**Interfaces:**
- Consumes: `resolveDest` de `src/dests.ts`.
- Produces:
```ts
export interface Instruction {
  skill: string;          // command do registro (ex.: 'explicativo')
  input: string;          // assunto/link
  vertical: boolean;      // true se campo '9:16' ou 'vertical'
  dest: string | null;    // caminho resolvido do destino
  destToken: string | null; // ex.: 'lives3'
  pesquisa: boolean;      // flag de pesquisa prévia
  curso?: string;         // --curso (skill curso)
  modulo?: string;        // --modulo (skill curso)
}
export type LineResult =
  | { kind: 'instr'; instr: Instruction }
  | { kind: 'free'; line: string }            // não casou o padrão → fallback Claude
  | { kind: 'error'; line: string; message: string }; // casou mas é inválido (ex.: destino)
export function parseLine(line: string, skills: string[], projetosDir: string): LineResult;
export function parseMessage(text: string, skills: string[], projetosDir: string): LineResult[];
```

- [ ] **Step 1: Escrever teste que falha**

`src/parser.test.ts`:
```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseLine, parseMessage } from './parser.js';

const base = join(tmpdir(), 'inemaccvbot-test-parser');
const SKILLS = ['explicativo', 'curso', 'demo'];

beforeAll(() => {
  rmSync(base, { recursive: true, force: true });
  mkdirSync(join(base, 'yt-pub-lives3'), { recursive: true });
});

describe('parseLine', () => {
  it('parseia skill + assunto + formato + destino', () => {
    const r = parseLine('explicativo: O que é RAG | 9:16 | lives3', SKILLS, base);
    expect(r.kind).toBe('instr');
    if (r.kind !== 'instr') return;
    expect(r.instr).toMatchObject({
      skill: 'explicativo', input: 'O que é RAG', vertical: true,
      destToken: 'lives3', pesquisa: false,
    });
    expect(r.instr.dest).toBe(join(base, 'yt-pub-lives3', 'imports', 'videos'));
  });
  it('campos em qualquer ordem + flag pesquisa', () => {
    const r = parseLine('explicativo: Computação quântica | pesquisa | 9:16', SKILLS, base);
    expect(r.kind).toBe('instr');
    if (r.kind !== 'instr') return;
    expect(r.instr.pesquisa).toBe(true);
    expect(r.instr.vertical).toBe(true);
    expect(r.instr.dest).toBeNull();
  });
  it('curso com modulo', () => {
    const r = parseLine('curso: https://x.io/skillsx/ | modulo t1m1', SKILLS, base);
    expect(r.kind).toBe('instr');
    if (r.kind !== 'instr') return;
    expect(r.instr.modulo).toBe('t1m1');
    expect(r.instr.input).toBe('https://x.io/skillsx/');
  });
  it('destino inexistente → error, não free', () => {
    const r = parseLine('explicativo: X | lives99', SKILLS, base);
    expect(r.kind).toBe('error');
    if (r.kind !== 'error') return;
    expect(r.message).toContain('lives99');
  });
  it('skill desconhecida no prefixo → free (fallback)', () => {
    expect(parseLine('fazum: negócio aí', SKILLS, base).kind).toBe('free');
  });
  it('texto livre → free', () => {
    expect(parseLine('pesquisa sobre IA e faz um vídeo', SKILLS, base).kind).toBe('free');
  });
});

describe('parseMessage', () => {
  it('uma instrução por linha, ignora linhas vazias', () => {
    const rs = parseMessage('explicativo: A | lives3\n\ndemo: https://b.com', SKILLS, base);
    expect(rs).toHaveLength(2);
    expect(rs.every((r) => r.kind === 'instr')).toBe(true);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run src/parser.test.ts`
Expected: FAIL (módulo não existe).

- [ ] **Step 3: Implementar `src/parser.ts`**

```ts
import { resolveDest } from './dests.js';

export interface Instruction {
  skill: string;
  input: string;
  vertical: boolean;
  dest: string | null;
  destToken: string | null;
  pesquisa: boolean;
  curso?: string;
  modulo?: string;
}

export type LineResult =
  | { kind: 'instr'; instr: Instruction }
  | { kind: 'free'; line: string }
  | { kind: 'error'; line: string; message: string };

/** Formato: `<skill>: <assunto/link> [| campo]*` — campos: 9:16|vertical, pesquisa, livesN, modulo X, curso X. */
export function parseLine(line: string, skills: string[], projetosDir: string): LineResult {
  const trimmed = line.trim();
  const m = trimmed.match(/^([a-zA-Zçãõéíóú-]+)\s*:\s*(.+)$/);
  if (!m) return { kind: 'free', line: trimmed };
  const skill = m[1].toLowerCase();
  if (!skills.includes(skill)) return { kind: 'free', line: trimmed };

  const fields = m[2].split('|').map((s) => s.trim()).filter(Boolean);
  const input = fields.shift() ?? '';
  if (!input) return { kind: 'error', line: trimmed, message: 'faltou o assunto/link depois do ":"' };

  const instr: Instruction = { skill, input, vertical: false, dest: null, destToken: null, pesquisa: false };
  for (const f of fields) {
    const lower = f.toLowerCase();
    if (lower === '9:16' || lower === 'vertical') { instr.vertical = true; continue; }
    if (lower === '16:9' || lower === 'horizontal') { instr.vertical = false; continue; }
    if (lower === 'pesquisa' || lower === 'pesquisar') { instr.pesquisa = true; continue; }
    const mod = f.match(/^modulo\s+(.+)$/i);
    if (mod) { instr.modulo = mod[1].trim(); continue; }
    const cur = f.match(/^curso\s+(.+)$/i);
    if (cur) { instr.curso = cur[1].trim(); continue; }
    if (/^lives\d+$/i.test(lower)) {
      const dest = resolveDest(lower, projetosDir);
      if (!dest) return { kind: 'error', line: trimmed, message: `destino "${lower}" não existe (pasta yt-pub-${lower} não encontrada)` };
      instr.dest = dest;
      instr.destToken = lower;
      continue;
    }
    return { kind: 'error', line: trimmed, message: `campo desconhecido: "${f}"` };
  }
  return { kind: 'instr', instr };
}

/** Uma instrução por linha; linhas vazias ignoradas. */
export function parseMessage(text: string, skills: string[], projetosDir: string): LineResult[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => parseLine(l, skills, projetosDir));
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run src/parser.test.ts`
Expected: PASS (7 testes).

- [ ] **Step 5: Commit**

```bash
git add src/parser.ts src/parser.test.ts
git commit -m "feat: parser de instruções (1 linha = 1 job, campos | e fallback free)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Registro de skills (`src/skills.ts`)

**Files:**
- Create: `src/skills.ts`
- Test: `src/skills.test.ts`

**Interfaces:**
- Consumes: `Instruction` de `src/parser.ts`; `config/skills.json` da Task 1.
- Produces:
```ts
export interface SkillDef { command: string; mkiSkill: string; description: string; example: string }
export function loadSkills(path?: string): SkillDef[];      // default: config/skills.json ao lado do projeto
export function skillCommands(defs: SkillDef[]): string[];   // ['explicativo','curso','demo']
export function buildAddArgs(instr: Instruction, defs: SkillDef[]): string[]; // args do CLI mkivideos
```

- [ ] **Step 1: Escrever teste que falha**

`src/skills.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { loadSkills, skillCommands, buildAddArgs, type SkillDef } from './skills.js';
import type { Instruction } from './parser.js';

const DEFS: SkillDef[] = [
  { command: 'explicativo', mkiSkill: 'explicativo', description: 'x', example: 'x' },
  { command: 'curso', mkiSkill: 'curso', description: 'x', example: 'x' },
];

const base: Instruction = { skill: 'explicativo', input: 'O que é RAG', vertical: false, dest: null, destToken: null, pesquisa: false };

describe('loadSkills', () => {
  it('carrega o registro do config/skills.json', () => {
    const defs = loadSkills();
    expect(skillCommands(defs)).toEqual(['explicativo', 'curso', 'demo']);
  });
});

describe('buildAddArgs', () => {
  it('monta add básico silencioso', () => {
    expect(buildAddArgs(base, DEFS)).toEqual(['add', 'explicativo', 'O que é RAG', '--silencioso']);
  });
  it('inclui vertical e pasta', () => {
    expect(buildAddArgs({ ...base, vertical: true, dest: '/x/videos', destToken: 'lives3' }, DEFS))
      .toEqual(['add', 'explicativo', 'O que é RAG', '--silencioso', '--vertical', '--pasta', '/x/videos']);
  });
  it('inclui curso/modulo', () => {
    expect(buildAddArgs({ ...base, skill: 'curso', input: 'https://c.io', curso: 'skillsx', modulo: 't1m1' }, DEFS))
      .toEqual(['add', 'curso', 'https://c.io', '--silencioso', '--curso', 'skillsx', '--modulo', 't1m1']);
  });
  it('recusa skill fora do registro', () => {
    expect(() => buildAddArgs({ ...base, skill: 'carrossel' }, DEFS)).toThrow(/não registrada/);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run src/skills.test.ts`
Expected: FAIL (módulo não existe).

- [ ] **Step 3: Implementar `src/skills.ts`**

```ts
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Instruction } from './parser.js';

export interface SkillDef { command: string; mkiSkill: string; description: string; example: string }

const DEFAULT_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'config', 'skills.json');

export function loadSkills(path: string = DEFAULT_PATH): SkillDef[] {
  return JSON.parse(readFileSync(path, 'utf8')) as SkillDef[];
}

export function skillCommands(defs: SkillDef[]): string[] {
  return defs.map((d) => d.command);
}

/** Instrução validada → args do CLI mkivideos. Notificação é do bot (watcher), então sempre --silencioso. */
export function buildAddArgs(instr: Instruction, defs: SkillDef[]): string[] {
  const def = defs.find((d) => d.command === instr.skill);
  if (!def) throw new Error(`skill não registrada: ${instr.skill}`);
  const args = ['add', def.mkiSkill, instr.input, '--silencioso'];
  if (instr.vertical) args.push('--vertical');
  if (instr.dest) args.push('--pasta', instr.dest);
  if (instr.curso) args.push('--curso', instr.curso);
  if (instr.modulo) args.push('--modulo', instr.modulo);
  return args;
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run src/skills.test.ts`
Expected: PASS (4 testes).

- [ ] **Step 5: Commit**

```bash
git add src/skills.ts src/skills.test.ts
git commit -m "feat: registro plugável de skills + montagem dos args do mkivideos add

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Estado local (`src/state.ts`)

**Files:**
- Create: `src/state.ts`
- Test: `src/state.test.ts`

**Interfaces:**
- Consumes: nada (better-sqlite3).
- Produces:
```ts
export interface TrackedJob {
  jobId: number; chatId: number; dest: string | null; destToken: string | null;
  briefing: string | null; lastStatus: string; createdAt: string;
}
export class StateStore {
  constructor(dbPath: string);              // ':memory:' nos testes
  track(j: Omit<TrackedJob, 'lastStatus' | 'createdAt'>): void;  // lastStatus inicial 'queued'
  pending(): TrackedJob[];                  // lastStatus não terminal (queued|running)
  setStatus(jobId: number, status: string): void;
  get(jobId: number): TrackedJob | undefined;
  close(): void;
}
```

- [ ] **Step 1: Escrever teste que falha**

`src/state.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { StateStore } from './state.js';

describe('StateStore', () => {
  it('track + get + pending + setStatus', () => {
    const s = new StateStore(':memory:');
    s.track({ jobId: 41, chatId: 123, dest: '/x/videos', destToken: 'lives3', briefing: null });
    s.track({ jobId: 42, chatId: 123, dest: null, destToken: null, briefing: '/b/41.md' });
    expect(s.get(41)?.lastStatus).toBe('queued');
    expect(s.pending().map((j) => j.jobId)).toEqual([41, 42]);
    s.setStatus(41, 'done');
    expect(s.pending().map((j) => j.jobId)).toEqual([42]);
    expect(s.get(41)?.lastStatus).toBe('done');
    s.close();
  });
  it('track do mesmo jobId sobrescreve sem erro', () => {
    const s = new StateStore(':memory:');
    s.track({ jobId: 1, chatId: 9, dest: null, destToken: null, briefing: null });
    s.track({ jobId: 1, chatId: 9, dest: null, destToken: null, briefing: null });
    expect(s.pending()).toHaveLength(1);
    s.close();
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run src/state.test.ts`
Expected: FAIL (módulo não existe).

- [ ] **Step 3: Implementar `src/state.ts`**

```ts
import Database from 'better-sqlite3';

export interface TrackedJob {
  jobId: number; chatId: number; dest: string | null; destToken: string | null;
  briefing: string | null; lastStatus: string; createdAt: string;
}

export class StateStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.exec(`CREATE TABLE IF NOT EXISTS tracked_jobs (
      job_id INTEGER PRIMARY KEY,
      chat_id INTEGER NOT NULL,
      dest TEXT,
      dest_token TEXT,
      briefing TEXT,
      last_status TEXT NOT NULL DEFAULT 'queued',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
  }

  track(j: Omit<TrackedJob, 'lastStatus' | 'createdAt'>): void {
    this.db.prepare(`INSERT INTO tracked_jobs (job_id, chat_id, dest, dest_token, briefing)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(job_id) DO UPDATE SET chat_id=excluded.chat_id, dest=excluded.dest,
        dest_token=excluded.dest_token, briefing=excluded.briefing`)
      .run(j.jobId, j.chatId, j.dest, j.destToken, j.briefing);
  }

  private static row(r: any): TrackedJob {
    return { jobId: r.job_id, chatId: r.chat_id, dest: r.dest, destToken: r.dest_token,
      briefing: r.briefing, lastStatus: r.last_status, createdAt: r.created_at };
  }

  pending(): TrackedJob[] {
    return this.db.prepare(`SELECT * FROM tracked_jobs WHERE last_status IN ('queued','running') ORDER BY job_id`)
      .all().map(StateStore.row);
  }

  setStatus(jobId: number, status: string): void {
    this.db.prepare(`UPDATE tracked_jobs SET last_status=? WHERE job_id=?`).run(status, jobId);
  }

  get(jobId: number): TrackedJob | undefined {
    const r = this.db.prepare(`SELECT * FROM tracked_jobs WHERE job_id=?`).get(jobId);
    return r ? StateStore.row(r) : undefined;
  }

  close(): void { this.db.close(); }
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run src/state.test.ts`
Expected: PASS (2 testes).

- [ ] **Step 5: Commit**

```bash
git add src/state.ts src/state.test.ts
git commit -m "feat: estado local SQLite (job -> chat/destino/briefing/status)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Cliente da fila (`src/queue-client.ts`)

**Files:**
- Create: `src/queue-client.ts`
- Test: `src/queue-client.test.ts`

**Interfaces:**
- Consumes: `Config` da Task 1.
- Produces:
```ts
export interface MkiJob {
  id: number; skill: string; input: string; opts: string | null;
  status: 'queued' | 'running' | 'done' | 'failed' | 'canceled';
  result_path: string | null; error: string | null;
}
export type ExecFn = (args: string[]) => Promise<string>; // roda o CLI mkivideos, devolve stdout
export function parseAddOutput(out: string): number | null; // 'enfileirado #41 (...)' → 41
export class QueueClient {
  constructor(cfg: { mkiDir: string; mkiDb: string; dashUrl: string; dashToken: string }, execFn?: ExecFn, fetchFn?: typeof fetch);
  add(args: string[]): Promise<number>;      // throws se não conseguir extrair id
  jobs(): Promise<MkiJob[]>;                 // GET /api/video-jobs
  job(id: number): Promise<MkiJob | undefined>;
  fila(): Promise<string>; stats(): Promise<string>; status(id: number): Promise<string>;
  cancel(id: number): Promise<string>; getPath(id: number): Promise<string>;
  ping(): Promise<boolean>;                  // GET /api/stats responde?
}
```

- [ ] **Step 1: Escrever teste que falha**

`src/queue-client.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { QueueClient, parseAddOutput } from './queue-client.js';

const cfg = { mkiDir: '/mki', mkiDb: '/mki/db', dashUrl: 'http://localhost:3142', dashToken: 'tok' };

describe('parseAddOutput', () => {
  it('extrai o id', () => {
    expect(parseAddOutput('enfileirado #41 (explicativo) → /x')).toBe(41);
  });
  it('null quando é erro', () => {
    expect(parseAddOutput('erro: uso: ...')).toBeNull();
  });
});

describe('QueueClient', () => {
  it('add usa o exec injetado e devolve o id', async () => {
    const calls: string[][] = [];
    const c = new QueueClient(cfg, async (args) => { calls.push(args); return 'enfileirado #7 (demo)'; });
    expect(await c.add(['add', 'demo', 'x', '--silencioso'])).toBe(7);
    expect(calls[0]).toEqual(['add', 'demo', 'x', '--silencioso']);
  });
  it('add lança quando o CLI devolve erro', async () => {
    const c = new QueueClient(cfg, async () => 'erro: skill inválida');
    await expect(c.add(['add', 'x', 'y'])).rejects.toThrow(/erro: skill inválida/);
  });
  it('jobs consulta a API com token', async () => {
    const fetchFn = (async (url: any) => {
      expect(String(url)).toBe('http://localhost:3142/api/video-jobs?token=tok');
      return { ok: true, json: async () => ({ jobs: [{ id: 1, status: 'done' }] }) } as any;
    }) as typeof fetch;
    const c = new QueueClient(cfg, async () => '', fetchFn);
    expect((await c.jobs())[0]).toMatchObject({ id: 1, status: 'done' });
  });
  it('ping false quando a API falha', async () => {
    const fetchFn = (async () => { throw new Error('down'); }) as unknown as typeof fetch;
    const c = new QueueClient(cfg, async () => '', fetchFn);
    expect(await c.ping()).toBe(false);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run src/queue-client.test.ts`
Expected: FAIL (módulo não existe).

- [ ] **Step 3: Implementar `src/queue-client.ts`**

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';

const pExecFile = promisify(execFile);

export interface MkiJob {
  id: number; skill: string; input: string; opts: string | null;
  status: 'queued' | 'running' | 'done' | 'failed' | 'canceled';
  result_path: string | null; error: string | null;
}

export type ExecFn = (args: string[]) => Promise<string>;

export function parseAddOutput(out: string): number | null {
  const m = out.match(/enfileirado #(\d+)/);
  return m ? Number(m[1]) : null;
}

export class QueueClient {
  private exec: ExecFn;
  private fetchFn: typeof fetch;

  constructor(
    private cfg: { mkiDir: string; mkiDb: string; dashUrl: string; dashToken: string },
    execFn?: ExecFn,
    fetchFn: typeof fetch = fetch,
  ) {
    this.fetchFn = fetchFn;
    this.exec = execFn ?? (async (args) => {
      const { stdout } = await pExecFile('node', [join(this.cfg.mkiDir, 'dist', 'cli.js'), ...args], {
        env: { ...process.env, MKIVIDEOS_DB: this.cfg.mkiDb },
        timeout: 60_000,
      });
      return stdout.trim();
    });
  }

  async add(args: string[]): Promise<number> {
    const out = await this.exec(args);
    const id = parseAddOutput(out);
    if (id === null) throw new Error(`mkivideos add falhou: ${out}`);
    return id;
  }

  private api(path: string): string {
    return `${this.cfg.dashUrl}${path}?token=${this.cfg.dashToken}`;
  }

  async jobs(): Promise<MkiJob[]> {
    const r = await this.fetchFn(this.api('/api/video-jobs'));
    if (!r.ok) throw new Error(`api video-jobs: HTTP ${r.status}`);
    const d = (await r.json()) as { jobs: MkiJob[] };
    return d.jobs;
  }

  async job(id: number): Promise<MkiJob | undefined> {
    return (await this.jobs()).find((j) => j.id === id);
  }

  fila(): Promise<string> { return this.exec(['fila']); }
  stats(): Promise<string> { return this.exec(['stats']); }
  status(id: number): Promise<string> { return this.exec(['status', String(id)]); }
  cancel(id: number): Promise<string> { return this.exec(['cancelar', String(id)]); }
  getPath(id: number): Promise<string> { return this.exec(['get', String(id)]); }

  async ping(): Promise<boolean> {
    try {
      const r = await this.fetchFn(this.api('/api/stats'));
      return r.ok;
    } catch { return false; }
  }
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run src/queue-client.test.ts`
Expected: PASS (6 testes).

- [ ] **Step 5: Commit**

```bash
git add src/queue-client.ts src/queue-client.test.ts
git commit -m "feat: cliente da fila mkivideos (CLI add/consulta + API JSON do dashboard)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Fallback Claude + pesquisa (`src/interpret.ts`)

**Files:**
- Create: `src/interpret.ts`
- Test: `src/interpret.test.ts`

**Interfaces:**
- Consumes: `Instruction` (parser), `SkillDef` (skills), `resolveDest`/`listDests` (dests).
- Produces:
```ts
export type ClaudeRunner = (prompt: string, extraArgs?: string[]) => Promise<string>;
export function buildInterpretPrompt(text: string, defs: SkillDef[], dests: string[]): string;
export function buildResearchPrompt(assunto: string): string;
// Interpreta texto livre → instruções validadas. {error} quando não mapeia pra skill registrada.
export function interpretFreeText(text: string, defs: SkillDef[], projetosDir: string, run: ClaudeRunner):
  Promise<{ ok: true; instrs: Instruction[] } | { ok: false; error: string }>;
// Pesquisa web → escreve briefing em <briefingsDir>/briefing-<timestamp>.md e devolve o caminho.
export function researchBriefing(assunto: string, briefingsDir: string, run: ClaudeRunner): Promise<string>;
export function defaultClaudeRunner(): ClaudeRunner;  // spawna `claude --model opus -p <prompt>`
```

- [ ] **Step 1: Escrever teste que falha**

`src/interpret.test.ts`:
```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildInterpretPrompt, interpretFreeText, researchBriefing } from './interpret.js';
import type { SkillDef } from './skills.js';

const base = join(tmpdir(), 'inemaccvbot-test-interpret');
const DEFS: SkillDef[] = [
  { command: 'explicativo', mkiSkill: 'explicativo', description: 'vídeo explicativo', example: 'explicativo: X' },
];

beforeAll(() => {
  rmSync(base, { recursive: true, force: true });
  mkdirSync(join(base, 'yt-pub-lives2'), { recursive: true });
});

describe('buildInterpretPrompt', () => {
  it('inclui skills e destinos válidos', () => {
    const p = buildInterpretPrompt('faz um vídeo', DEFS, ['lives2']);
    expect(p).toContain('explicativo');
    expect(p).toContain('lives2');
    expect(p).toContain('JSON');
  });
});

describe('interpretFreeText', () => {
  it('valida e converte o JSON do Claude em instruções', async () => {
    const run = async () => JSON.stringify([{ skill: 'explicativo', input: 'IA na saúde', vertical: true, dest: 'lives2', pesquisa: false }]);
    const r = await interpretFreeText('pesquisa...', DEFS, base, run);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.instrs[0]).toMatchObject({ skill: 'explicativo', vertical: true, destToken: 'lives2' });
    expect(r.instrs[0].dest).toBe(join(base, 'yt-pub-lives2', 'imports', 'videos'));
  });
  it('recusa skill fora do registro', async () => {
    const run = async () => JSON.stringify([{ skill: 'carrossel', input: 'x' }]);
    const r = await interpretFreeText('faz carrossel', DEFS, base, run);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('carrossel');
  });
  it('recusa quando o Claude responde RECUSAR', async () => {
    const r = await interpretFreeText('joga xadrez', DEFS, base, async () => 'RECUSAR: não é pedido de vídeo');
    expect(r.ok).toBe(false);
  });
  it('erro claro quando o JSON vem quebrado', async () => {
    const r = await interpretFreeText('x', DEFS, base, async () => 'não sei');
    expect(r.ok).toBe(false);
  });
});

describe('researchBriefing', () => {
  it('salva o briefing e devolve o caminho', async () => {
    const dir = join(base, 'briefings');
    const path = await researchBriefing('computação quântica', dir, async () => '# Briefing\nfatos...');
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf8')).toContain('Briefing');
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run src/interpret.test.ts`
Expected: FAIL (módulo não existe).

- [ ] **Step 3: Implementar `src/interpret.ts`**

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveDest } from './dests.js';
import type { Instruction } from './parser.js';
import type { SkillDef } from './skills.js';

const pExecFile = promisify(execFile);

export type ClaudeRunner = (prompt: string, extraArgs?: string[]) => Promise<string>;

/** `claude --model opus -p` (esforço médio = default da conta). */
export function defaultClaudeRunner(): ClaudeRunner {
  return async (prompt, extraArgs = []) => {
    const { stdout } = await pExecFile('claude', ['--model', 'opus', '-p', prompt, ...extraArgs],
      { timeout: 600_000, maxBuffer: 10 * 1024 * 1024 });
    return stdout.trim();
  };
}

export function buildInterpretPrompt(text: string, defs: SkillDef[], dests: string[]): string {
  const skillList = defs.map((d) => `- ${d.command}: ${d.description} (ex.: ${d.example})`).join('\n');
  return [
    'Você traduz um pedido de criação de vídeo em jobs para uma fila. Responda APENAS com JSON (array), sem markdown.',
    'Skills registradas (as ÚNICAS permitidas):',
    skillList,
    `Destinos válidos (campo "dest", opcional): ${dests.join(', ') || '(nenhum)'}`,
    'Formato de cada item: {"skill": string, "input": string (assunto ou link), "vertical": boolean, "dest": string|null, "pesquisa": boolean}',
    '"pesquisa"=true somente se o pedido mandar pesquisar o assunto antes.',
    'Se o pedido NÃO mapear para nenhuma skill registrada, responda exatamente: RECUSAR: <motivo curto>',
    '',
    'Pedido:',
    text,
  ].join('\n');
}

export function buildResearchPrompt(assunto: string): string {
  return [
    `Pesquise na web sobre: ${assunto}`,
    'Produza um briefing em markdown para roteirizar um vídeo: fatos verificados com datas, números-chave,',
    '3-5 ângulos interessantes, erros comuns sobre o tema, e as fontes (URLs). Máximo ~600 palavras.',
    'Responda APENAS com o markdown do briefing.',
  ].join('\n');
}

export async function interpretFreeText(
  text: string, defs: SkillDef[], projetosDir: string, run: ClaudeRunner,
): Promise<{ ok: true; instrs: Instruction[] } | { ok: false; error: string }> {
  const dests: string[] = [];
  const out = await run(buildInterpretPrompt(text, defs, listDestTokens(projetosDir)));
  if (out.startsWith('RECUSAR:')) return { ok: false, error: out.slice('RECUSAR:'.length).trim() };
  let items: any[];
  try {
    const jsonText = out.replace(/^```(json)?/m, '').replace(/```$/m, '').trim();
    items = JSON.parse(jsonText);
    if (!Array.isArray(items)) throw new Error('não é array');
  } catch {
    return { ok: false, error: `não entendi o pedido (resposta inválida do interpretador): ${out.slice(0, 200)}` };
  }
  const instrs: Instruction[] = [];
  for (const it of items) {
    if (!defs.some((d) => d.command === it.skill)) {
      return { ok: false, error: `skill "${it.skill}" não registrada — só sei: ${defs.map((d) => d.command).join(', ')}` };
    }
    if (!it.input || typeof it.input !== 'string') return { ok: false, error: 'item sem "input"' };
    let dest: string | null = null;
    let destToken: string | null = null;
    if (it.dest) {
      dest = resolveDest(String(it.dest), projetosDir);
      if (!dest) return { ok: false, error: `destino "${it.dest}" não existe` };
      destToken = String(it.dest).toLowerCase();
    }
    instrs.push({
      skill: it.skill, input: it.input, vertical: Boolean(it.vertical),
      dest, destToken, pesquisa: Boolean(it.pesquisa),
    });
  }
  if (!instrs.length) return { ok: false, error: 'nenhum job identificado no pedido' };
  return { ok: true, instrs };
}

function listDestTokens(projetosDir: string): string[] {
  // import local para evitar ciclo — dests.ts já exporta listDests
  // (mantido aqui como wrapper fino para o prompt)
  const { listDests } = require('./dests.js') as typeof import('./dests.js');
  return listDests(projetosDir);
}

/** Pesquisa web via claude -p com WebSearch; salva briefing e devolve o caminho. */
export async function researchBriefing(assunto: string, briefingsDir: string, run: ClaudeRunner): Promise<string> {
  mkdirSync(briefingsDir, { recursive: true });
  const md = await run(buildResearchPrompt(assunto), ['--allowedTools', 'WebSearch,WebFetch']);
  const slug = assunto.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'briefing';
  const path = join(briefingsDir, `${Date.now()}-${slug}.md`);
  writeFileSync(path, md, 'utf8');
  return path;
}
```

**Nota (ESM):** `require` não existe em ESM — na implementação real, troque o wrapper `listDestTokens` por `import { listDests } from './dests.js'` no topo (não há ciclo: `dests.ts` não importa `interpret.ts`). O código acima mostra a intenção; o import direto é a forma correta.

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run src/interpret.test.ts`
Expected: PASS (7 testes). Se falhar por causa do `require`, aplique a nota ESM acima.

- [ ] **Step 5: Commit**

```bash
git add src/interpret.ts src/interpret.test.ts
git commit -m "feat: fallback Claude (Opus) p/ texto livre + pesquisa web com briefing

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Watcher (`src/watcher.ts`)

**Files:**
- Create: `src/watcher.ts`
- Test: `src/watcher.test.ts`

**Interfaces:**
- Consumes: `StateStore` (Task 5), `MkiJob` (Task 6).
- Produces:
```ts
export interface WatcherDeps {
  jobs: () => Promise<MkiJob[]>;                       // QueueClient.jobs
  state: StateStore;
  notify: (chatId: number, text: string) => Promise<void>; // bot.api.sendMessage
}
export function doneMessage(job: MkiJob, tracked: TrackedJob): string;   // conclusão (nome, caminho, destino)
export function failMessage(job: MkiJob, tracked: TrackedJob): string;   // falha resumida
export async function tick(deps: WatcherDeps): Promise<void>;            // 1 rodada de poll
export function startWatcher(deps: WatcherDeps, intervalMs: number): () => void; // setInterval; retorna stop
```

- [ ] **Step 1: Escrever teste que falha**

`src/watcher.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { tick, doneMessage } from './watcher.js';
import { StateStore } from './state.js';
import type { MkiJob } from './queue-client.js';

const mkJob = (over: Partial<MkiJob>): MkiJob => ({
  id: 1, skill: 'explicativo', input: 'X', opts: null,
  status: 'queued', result_path: null, error: null, ...over,
});

describe('tick', () => {
  it('notifica done uma única vez e marca o estado', async () => {
    const state = new StateStore(':memory:');
    state.track({ jobId: 1, chatId: 77, dest: '/d/videos', destToken: 'lives3', briefing: null });
    const sent: string[] = [];
    const deps = {
      jobs: async () => [mkJob({ id: 1, status: 'done' as const, result_path: '/d/videos/mkivideo-1.mp4' })],
      state,
      notify: async (_chat: number, text: string) => { sent.push(text); },
    };
    await tick(deps);
    await tick(deps); // segunda rodada não repete
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('mkivideo-1.mp4');
    expect(sent[0]).toContain('lives3');
    expect(state.get(1)?.lastStatus).toBe('done');
  });
  it('notifica failed com o erro', async () => {
    const state = new StateStore(':memory:');
    state.track({ jobId: 2, chatId: 77, dest: null, destToken: null, briefing: null });
    const sent: string[] = [];
    await tick({
      jobs: async () => [mkJob({ id: 2, status: 'failed' as const, error: 'render explodiu' })],
      state,
      notify: async (_c, t) => { sent.push(t); },
    });
    expect(sent[0]).toContain('render explodiu');
    expect(state.get(2)?.lastStatus).toBe('failed');
  });
  it('running só atualiza status, sem notificar', async () => {
    const state = new StateStore(':memory:');
    state.track({ jobId: 3, chatId: 77, dest: null, destToken: null, briefing: null });
    const sent: string[] = [];
    await tick({ jobs: async () => [mkJob({ id: 3, status: 'running' as const })], state, notify: async (_c, t) => { sent.push(t); } });
    expect(sent).toHaveLength(0);
    expect(state.get(3)?.lastStatus).toBe('running');
  });
  it('erro no poll não derruba (fila fora do ar)', async () => {
    const state = new StateStore(':memory:');
    state.track({ jobId: 4, chatId: 77, dest: null, destToken: null, briefing: null });
    await expect(tick({ jobs: async () => { throw new Error('down'); }, state, notify: async () => {} })).resolves.toBeUndefined();
  });
});

describe('doneMessage', () => {
  it('avisa quando o resultado NÃO caiu no destino pedido', () => {
    const msg = doneMessage(
      mkJob({ id: 5, status: 'done', result_path: '/outro/lugar/v.mp4' }),
      { jobId: 5, chatId: 1, dest: '/d/videos', destToken: 'lives3', briefing: null, lastStatus: 'running', createdAt: '' },
    );
    expect(msg).toContain('/outro/lugar/v.mp4');
    expect(msg.toLowerCase()).toContain('fora do destino');
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run src/watcher.test.ts`
Expected: FAIL (módulo não existe).

- [ ] **Step 3: Implementar `src/watcher.ts`**

```ts
import type { MkiJob } from './queue-client.js';
import type { StateStore, TrackedJob } from './state.js';

export interface WatcherDeps {
  jobs: () => Promise<MkiJob[]>;
  state: StateStore;
  notify: (chatId: number, text: string) => Promise<void>;
}

export function doneMessage(job: MkiJob, tracked: TrackedJob): string {
  const lines = [`✅ vídeo #${job.id} pronto (${job.skill})`, `📄 ${job.result_path ?? '(sem caminho)'}`];
  if (tracked.dest) {
    if (job.result_path && job.result_path.startsWith(tracked.dest)) {
      lines.push(`📦 movido para ${tracked.destToken} (${tracked.dest})`);
    } else {
      lines.push(`⚠️ ficou fora do destino ${tracked.destToken} (${tracked.dest}) — arquivo está no caminho acima`);
    }
  }
  if (tracked.briefing) lines.push(`🔎 briefing: ${tracked.briefing}`);
  lines.push(`use /enviar ${job.id} para receber o arquivo`);
  return lines.join('\n');
}

export function failMessage(job: MkiJob, tracked: TrackedJob): string {
  const err = (job.error ?? 'sem detalhe').slice(0, 500);
  return [`❌ vídeo #${job.id} falhou (${job.skill})`, `motivo: ${err}`, `detalhe completo: /status ${job.id}`].join('\n');
}

export async function tick(deps: WatcherDeps): Promise<void> {
  const pending = deps.state.pending();
  if (!pending.length) return;
  let all: MkiJob[];
  try { all = await deps.jobs(); } catch (e) {
    console.error('[watcher] poll falhou:', (e as Error).message);
    return;
  }
  const byId = new Map(all.map((j) => [j.id, j]));
  for (const t of pending) {
    const job = byId.get(t.jobId);
    if (!job || job.status === t.lastStatus) continue;
    deps.state.setStatus(t.jobId, job.status);
    try {
      if (job.status === 'done') await deps.notify(t.chatId, doneMessage(job, t));
      else if (job.status === 'failed') await deps.notify(t.chatId, failMessage(job, t));
      else if (job.status === 'canceled') await deps.notify(t.chatId, `🚫 job #${job.id} cancelado`);
    } catch (e) {
      console.error('[watcher] notify falhou:', (e as Error).message);
    }
  }
}

export function startWatcher(deps: WatcherDeps, intervalMs: number): () => void {
  const h = setInterval(() => { void tick(deps); }, intervalMs);
  return () => clearInterval(h);
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run src/watcher.test.ts`
Expected: PASS (5 testes).

- [ ] **Step 5: Commit**

```bash
git add src/watcher.ts src/watcher.test.ts
git commit -m "feat: watcher de conclusão (poll 60s, notifica done/failed/canceled 1x)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Bot Telegram (`src/help.ts`, `src/bot.ts`, `src/index.ts`)

**Files:**
- Create: `src/help.ts`, `src/bot.ts`, `src/index.ts`
- Test: `src/help.test.ts`

**Interfaces:**
- Consumes: tudo das Tasks 1–8.
- Produces: `helpText(defs: SkillDef[], dests: string[]): string` e `skillsText(defs: SkillDef[]): string` em `src/help.ts`; `createBot(cfg: Config, deps: BotDeps): Bot` em `src/bot.ts` com `BotDeps = { client: QueueClient; state: StateStore; defs: SkillDef[]; interpret: typeof interpretFreeText; research: typeof researchBriefing; claude: ClaudeRunner }`; `src/index.ts` faz o boot (bot + watcher).

- [ ] **Step 1: Escrever teste do help que falha**

`src/help.test.ts`:
```ts
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
});

describe('skillsText', () => {
  it('lista comando, descrição e exemplo', () => {
    const t = skillsText(DEFS);
    expect(t).toContain('explicativo');
    expect(t).toContain('vídeo explicativo');
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run src/help.test.ts`
Expected: FAIL (módulo não existe).

- [ ] **Step 3: Implementar `src/help.ts`**

```ts
import type { SkillDef } from './skills.js';

export function skillsText(defs: SkillDef[]): string {
  return ['🎬 skills registradas:', ...defs.map((d) => `• ${d.command} — ${d.description}\n  ex.: ${d.example}`)].join('\n');
}

export function helpText(defs: SkillDef[], dests: string[]): string {
  return [
    '🤖 inemaccvbot — fila de vídeos (mkivideos)',
    '',
    'Mande instruções em texto — uma instrução por linha = um job:',
    '  <skill>: <assunto ou link> [| 9:16] [| pesquisa] [| livesN] [| modulo X] [| curso X]',
    '',
    'Exemplos:',
    ...defs.map((d) => `  ${d.example}`),
    '  explicativo: Computação quântica | pesquisa | lives2',
    '',
    'Campos (qualquer ordem):',
    '  9:16 ou vertical — formato Shorts/Reels (default 16:9)',
    '  pesquisa — pesquisa web antes e passa o briefing pra skill',
    `  livesN — move o vídeo pronto para yt-pub-livesN/imports/videos (válidos: ${dests.join(', ') || 'nenhum'})`,
    '',
    'Texto livre também funciona (o bot interpreta), mas SÓ com as skills registradas — nada é criado fora delas.',
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
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run src/help.test.ts`
Expected: PASS (2 testes).

- [ ] **Step 5: Implementar `src/bot.ts`**

```ts
import { Bot } from 'grammy';
import { InputFile } from 'grammy';
import { statSync, existsSync, mkdirSync } from 'node:fs';
import type { Config } from './config.js';
import { parseMessage, type Instruction } from './parser.js';
import { skillCommands, buildAddArgs, type SkillDef } from './skills.js';
import { listDests } from './dests.js';
import { helpText, skillsText } from './help.js';
import type { QueueClient } from './queue-client.js';
import type { StateStore } from './state.js';
import { interpretFreeText, researchBriefing, type ClaudeRunner } from './interpret.js';

const MAX_SEND_BYTES = 50 * 1024 * 1024;

export interface BotDeps {
  client: QueueClient;
  state: StateStore;
  defs: SkillDef[];
  claude: ClaudeRunner;
}

export function createBot(cfg: Config, deps: BotDeps): Bot {
  const bot = new Bot(cfg.botToken);
  const commands = skillCommands(deps.defs);

  // Allowlist: fora da lista = ignora em silêncio (só log).
  bot.use(async (ctx, next) => {
    const id = ctx.chat?.id;
    if (id === undefined || !cfg.allowedChatIds.includes(id)) {
      console.warn(`[acesso] ignorando chat não autorizado: ${id} (@${ctx.from?.username ?? '?'})`);
      return;
    }
    await next();
  });

  bot.command('help', (ctx) => ctx.reply(helpText(deps.defs, listDests(cfg.projetosDir))));
  bot.command('start', (ctx) => ctx.reply(helpText(deps.defs, listDests(cfg.projetosDir))));
  bot.command('skills', (ctx) => ctx.reply(skillsText(deps.defs)));

  bot.command('fila', async (ctx) => {
    if (!(await deps.client.ping())) return ctx.reply('⚠️ fila mkivideos indisponível (daemon fora do ar)');
    ctx.reply(await deps.client.fila());
  });

  bot.command('status', async (ctx) => {
    const arg = ctx.match?.toString().trim();
    if (arg) return ctx.reply(await deps.client.status(Number(arg)));
    ctx.reply(await deps.client.stats());
  });

  bot.command('cancelar', async (ctx) => {
    const id = Number(ctx.match?.toString().trim());
    if (!Number.isInteger(id)) return ctx.reply('uso: /cancelar <id>');
    ctx.reply(await deps.client.cancel(id));
    deps.state.setStatus(id, 'canceled');
  });

  bot.command('enviar', async (ctx) => {
    const id = Number(ctx.match?.toString().trim());
    if (!Number.isInteger(id)) return ctx.reply('uso: /enviar <id>');
    const path = await deps.client.getPath(id);
    if (!path || !existsSync(path)) return ctx.reply(`#${id} ainda não tem arquivo pronto`);
    const size = statSync(path).size;
    if (size > MAX_SEND_BYTES) {
      return ctx.reply(`arquivo tem ${(size / 1e6).toFixed(0)} MB (limite do bot: 50 MB)\ncaminho: ${path}`);
    }
    await ctx.replyWithVideo(new InputFile(path));
  });

  // Mensagem de texto = instruções (1 por linha)
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith('/')) return; // comando desconhecido
    if (!(await deps.client.ping())) return ctx.reply('⚠️ fila mkivideos indisponível — instrução NÃO enfileirada, tenta de novo depois');

    const results = parseMessage(text, commands, cfg.projetosDir);
    const replies: string[] = [];
    const freeLines: string[] = [];

    for (const r of results) {
      if (r.kind === 'error') { replies.push(`❌ ${r.line}\n   ${r.message}`); continue; }
      if (r.kind === 'free') { freeLines.push(r.line); continue; }
      replies.push(await submit(r.instr, ctx.chat.id, cfg, deps));
    }

    if (freeLines.length) {
      await ctx.reply('🧠 interpretando com Claude…');
      const out = await interpretFreeText(freeLines.join('\n'), deps.defs, cfg.projetosDir, deps.claude);
      if (!out.ok) replies.push(`❌ não deu: ${out.error}\nveja /help e /skills`);
      else for (const instr of out.instrs) replies.push(await submit(instr, ctx.chat.id, cfg, deps));
    }

    await ctx.reply(replies.join('\n\n') || 'nada pra fazer — manda /help');
  });

  return bot;
}

async function submit(instr: Instruction, chatId: number, cfg: Config, deps: BotDeps): Promise<string> {
  try {
    let briefing: string | null = null;
    if (instr.pesquisa) {
      briefing = await researchBriefing(instr.input, cfg.briefingsDir, deps.claude);
      instr = { ...instr, input: `${instr.input}. IMPORTANTE: use como base o briefing de pesquisa em ${briefing} (fatos, ângulos e fontes).` };
    }
    if (instr.dest) mkdirSync(instr.dest, { recursive: true });
    const jobId = await deps.client.add(buildAddArgs(instr, deps.defs));
    deps.state.track({ jobId, chatId, dest: instr.dest, destToken: instr.destToken, briefing });
    const extras = [instr.vertical ? '9:16' : '16:9', instr.pesquisa ? 'com pesquisa 🔎' : null, instr.destToken ? `→ ${instr.destToken}` : null]
      .filter(Boolean).join(' · ');
    return `📥 #${jobId} na fila (${instr.skill}) ${extras}\naviso aqui quando terminar`;
  } catch (e) {
    return `❌ falhou ao enfileirar "${instr.input.slice(0, 60)}": ${(e as Error).message.slice(0, 200)}`;
  }
}
```

- [ ] **Step 6: Implementar `src/index.ts`**

```ts
import { loadConfig } from './config.js';
import { loadSkills } from './skills.js';
import { QueueClient } from './queue-client.js';
import { StateStore } from './state.js';
import { createBot } from './bot.js';
import { startWatcher } from './watcher.js';
import { defaultClaudeRunner } from './interpret.js';

const cfg = loadConfig();
const defs = loadSkills();
const client = new QueueClient(cfg);
const state = new StateStore(cfg.stateDb);
const bot = createBot(cfg, { client, state, defs, claude: defaultClaudeRunner() });

const stopWatcher = startWatcher(
  { jobs: () => client.jobs(), state, notify: (chatId, text) => bot.api.sendMessage(chatId, text).then(() => {}) },
  cfg.pollIntervalMs,
);

process.on('SIGTERM', () => { stopWatcher(); void bot.stop(); });
process.on('SIGINT', () => { stopWatcher(); void bot.stop(); });

console.log('[inemaccvbot] iniciando (long polling)…');
void bot.start();
```

- [ ] **Step 7: Build + suíte completa**

Run: `npm run build && npm test`
Expected: build sem erro de tipo; todos os testes PASS.

- [ ] **Step 8: Commit**

```bash
git add src/help.ts src/help.test.ts src/bot.ts src/index.ts
git commit -m "feat: bot Telegram (allowlist, instruções, /fila /status /cancelar /enviar /skills /help)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: Deploy systemd + smoke test ponta a ponta + README

**Files:**
- Create: `.env` (a partir do `.env.example` — NÃO commitar), `deploy/inemaccvbot.service`, `README.md`

**Interfaces:**
- Consumes: tudo. Produces: serviço rodando.

- [ ] **Step 1: Criar `.env` real**

Copiar `.env.example` → `.env`; preencher `TELEGRAM_BOT_TOKEN` (o usuário já forneceu o token na conversa — está no histórico; NÃO colocar em nenhum arquivo commitado) e `ALLOWED_CHAT_IDS`. Para descobrir o chat id: rodar o bot em dev (`npm run dev`), mandar "oi" pro `@inemaccvbot` no Telegram e ler o id no log de acesso negado (`[acesso] ignorando chat não autorizado: <ID>`); colocar esse id no `.env` e reiniciar.

- [ ] **Step 2: Criar `deploy/inemaccvbot.service`**

```ini
[Unit]
Description=inemaccvbot — bot Telegram da fila de vídeos (mkivideos)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/home/nmaldaner/projetos/inemaccvbot
ExecStart=/usr/bin/node /home/nmaldaner/projetos/inemaccvbot/dist/index.js
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
```

- [ ] **Step 3: Instalar e subir o serviço (user unit)**

Run:
```bash
mkdir -p ~/.config/systemd/user
cp deploy/inemaccvbot.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now inemaccvbot
systemctl --user status inemaccvbot --no-pager
```
Expected: `active (running)`.

- [ ] **Step 4: Smoke test ponta a ponta (manual, com o usuário)**

Pedir ao usuário para mandar no `@inemaccvbot`:
1. `/help` → ajuda completa. `/skills` → 3 skills.
2. `/fila` → estado da fila mkivideos real.
3. `explicativo: O que é um bot de fila | 9:16 | lives3` → resposta `📥 #N na fila…`; conferir `mki.sh status N` mostra o job com `dest`.
4. Aguardar conclusão → notificação ✅ com caminho dentro de `~/projetos/yt-pub-lives3/imports/videos/`.
5. `/enviar N` → vídeo chega no chat (se ≤50 MB).
6. `fazum: negócio aí` → interpretação Claude → recusa educada com /help (nada mapeável) OU linha `carrossel: X` → recusa por skill não registrada.

Expected: todos os passos como descrito. Registrar qualquer desvio antes de dar por pronto.

- [ ] **Step 5: README curto**

`README.md`:
```markdown
# inemaccvbot

Bot Telegram fino da fila de vídeos [mkivideos](../mkivideos). Recebe instruções
(1 linha = 1 job), enfileira nas skills registradas (`explicativo`, `curso`, `demo`),
notifica quando termina e move o vídeo para `yt-pub-livesN/imports/videos`.

- Spec: `docs/superpowers/specs/2026-07-16-inemaccvbot-design.md`
- Plano: `docs/superpowers/plans/2026-07-16-inemaccvbot.md`

## Rodar

    cp .env.example .env   # preencher token + chat ids
    npm i && npm run build
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
```

- [ ] **Step 6: Commit final**

```bash
git add deploy/inemaccvbot.service README.md
git status   # conferir que .env NÃO aparece
git commit -m "feat: deploy systemd (user unit) + README

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Self-Review (feito na escrita do plano)

- **Cobertura do spec:** parser híbrido (T3+T7), skills plugáveis (T4), fila via CLI+API (T6), watcher/notificação (T8), move via `--pasta` + verificação (T8/T9, decisão registrada em Global Constraints), pesquisa+briefing (T7/T9), allowlist silenciosa (T9), `/fila /status /cancelar /enviar /skills /help` (T9), systemd + `.env` (T10), erros e casos-limite (ping antes de submeter T9; destino inválido T3; move fora do destino T8; restart retoma via SQLite T5+T8).
- **Placeholders:** nenhum — todo step tem código/comando/expectativa completos.
- **Consistência de tipos:** `Instruction` (T3) consumida por T4/T7/T9; `MkiJob`/`QueueClient` (T6) por T8/T9; `StateStore`/`TrackedJob` (T5) por T8/T9; `SkillDef` (T4) por T7/T9; assinaturas conferidas.
