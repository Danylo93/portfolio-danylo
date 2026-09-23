# Authoring labs

Labs run in a simulated shell (`src/labs/shell.ts`). CLI tools are plugins registered in
`src/labs/registry.ts`. A track is one module in `src/labs/tracks/` that exports `track` and
`labs`, and imports the tool modules it needs, which registers them.

## Layout

```
src/labs/
  shell.ts        core shell: builtins, pipes, &&, > / >>, $VARS, aliases, ssh, systemctl, apt-get, vi/nano, curl/wget
  types.ts        shared types (Lab, Step, Track, Tool, ToolCtx, LabState, Host…)
  util.ts         tokenize, parseFlags, table, age, rand, hexId, closest, paths
  registry.ts     registerTool / getTool
  coach.ts        mentor: explains commands and errors, diagnoses failed checks
  k8s/            Kubernetes model (cluster.ts), kubectl.ts, manifest.ts, controlplane.ts (etcdctl, kubeadm)
  tools/<x>.ts    one CLI plugin per file (docker, terraform, git, ansible, trivy, helm…)
  tracks/<x>.ts   track definition + labs
  tracks/<x>.test.ts
  test-utils.ts   expectSolvable / expectWellFormed / podName
  data.ts         aggregates every track (the only place a new track is registered)
```

## Writing a tool

```ts
import { registerTool } from "../registry";

registerTool({
  name: "trivy",
  summary: "scanner de vulnerabilidades",            // shown by `help` and the command explainer
  subcommands: { image: "escaneia uma imagem", fs: "escaneia um diretório" }, // explainer + "did you mean"
  flags: { "--severity": "filtra por severidade" },  // explainer
  valueFlags: ["--severity", "-f", "-o"],            // flags that take the next token as value
  run: ({ sh, args, flags, pos, rest, env, stdin }) => {
    const [sub, target] = pos;
    if (sub !== "image") return `Error: unknown command "${sub}" for "trivy"`;
    return "...realistic output...";
  },
  explainError: (cmd, output, sh) => (/some error/.test(output) ? "Explicação amigável em pt-BR" : null),
  http: ({ host, port, path }, sh) => null, // answer curl/wget (return null if not yours)
});
```

- `flags` keys have no leading dashes: `--severity=HIGH` → `flags.severity === "HIGH"`,
  `-f json` → `flags.f === "json"` (only when listed in `valueFlags`). `valueFlags` is
  authoritative: when a tool declares it, the default short flags (`-o -n -p -l -f -c`) are not used.
- Everything after a bare `--` is in `rest`.
- Return a string, or `{ output, ok?: boolean, edit?: { path, content } }`. An output counts as a
  failure when a line starts with `error`, `Error`, `ERROR`, `fatal:`, `FATAL`, `E: `, `Failed to `,
  `bash:` and similar. Otherwise pass `ok: false`.
- For subcommand typos, use the convention `Error: unknown command "<sub>" for "<tool>"`. The mentor
  then suggests the closest subcommand.
- Tool-private state: `sh.ext("myTool", () => initialState)`. It is created lazily per shell.
- Linux hosts: `sh.hostOf("web1")` creates or returns `{ services, packages }`. `ssh web1` works for
  any host in `sh.state.hosts`. `systemctl` and `journalctl` act on `sh.host`.
- Files: `sh.readFile(p)`, `sh.writeFile(p, c)`, `sh.isDir(p)`, `sh.listDir(p)`, `sh.mkdir(p)`,
  `sh.resolve(p)`. Relative paths resolve from `sh.cwd` (starts at `/home/danylo/project`).
- Markers for checks: `sh.flags.add("scan:done")`.
- Kubernetes helpers (for helm, argocd, …): `createDeployment`, `createService`, `findDeployment`,
  `deploymentReady`, `reconcile`, `upsertObj`, `findObj` from `k8s/cluster.ts`.
- Tools take precedence over builtins with the same name.

## Writing a lab

```ts
{
  id: "trivy-image-scan",                 // globally unique, kebab-case, prefixed by track
  track: "devsecops",
  kind: "lab" | "challenge",
  title, summary, level: "Iniciante" | "Intermediário" | "Avançado", minutes,
  skills: ["trivy image", "CVE triage"],  // short skill names (skill tree)
  seed: { files: { "Dockerfile": "..." }, setup: (sh) => { /* any initial state */ } },
  intro, outro,
  steps: [{
    title, body: ["..."],
    code: ["trivy image nginx:1.25"],     // FIRST command = the expected one (used to diagnose "wrong verb/target")
    hints: ["conceito (sem resposta)", "sintaxe com <placeholders>", "trivy image nginx:1.25"], // last = solution
    explain: ["o que aconteceu", "por que importa / dica de produção"],
    diagnose: (sh) => /* specific reason, or null */ null,
    check: (sh) => sh.ran(/^trivy image /),
  }],
}
```

- All learner-facing text is pt-BR. CLI output stays in English, as the real tools print it.
- The last hint is the solution. When it is a single plain command (no `(`, `<`, `—`, `&&`,
  "troque" or "depois") the learner can click it to paste it into the terminal.
- `check` must be false before the step's actions (the tests enforce this) and must look at the
  real outcome (state, files, markers), not only `sh.ran`, where that makes sense.
- Learners edit files with `vi`/`nano` (an editor overlay). Tests simulate it with
  `sh.saveEdit(path, content)`. `sed -i`, `echo … >> file` and `cat file` also work.
- Pods take 2.5 s to become Running. Tests advance fake timers 5 s after every action.

## Tests

```ts
import { beforeEach, afterEach, describe, it, vi } from "vitest";
import { labs } from "./devsecops";
import { expectSolvable, expectWellFormed, type Solution } from "../test-utils";

const SOLUTIONS: Record<string, Solution> = { "trivy-image-scan": [[() => "trivy image nginx:1.25"], /* one array per step */] };

describe("devsecops", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it.each(labs.map((l) => [l.id, l] as const))("%s", (_, lab) => {
    expectWellFormed(lab);
    expectSolvable(lab, SOLUTIONS[lab.id]);
  });
});
```

Run: `npx vitest run src/labs/tracks/<track>.test.ts`, `npx tsc --noEmit -p tsconfig.app.json`,
`npx eslint src/labs`.

## Lessons

Every track also has 3–5 short theory lessons (`Lesson` in types.ts), exported as
`export const lessons: Lesson[]` from the track module. A lesson has `before: "<lab id>"` so the
catalog shows it right before the lab it prepares for, like the LabEx/KodeKloud learning paths.

- 4–8 minutes of reading, pt-BR, written for a Senior Infrastructure/SRE audience (no fluff).
- Blocks: `heading`, `text` (supports **bold** and `inline code`), `list`, `code` (real config or
  commands), `callout` (tone tip | warn | exam), `flow` (a left-to-right diagram of 3–6 steps),
  `table`.
- Include at least one `flow` or `table` and one `callout` per lesson.
- `quiz`: 3 questions with 3–4 options, `answer` = correct index, `explain` = why. Make the wrong
  options plausible (typical misconceptions), not silly.
- Test with `expectLessonWellFormed(lesson)` from test-utils.
