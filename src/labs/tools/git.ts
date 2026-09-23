// Simulated git + a GitHub-like remote. Everything is in memory (sh.ext("git")): nothing touches a real repository.
import { registerTool } from "../registry";
import type { Shell } from "../shell";
import type { ToolResult } from "../types";
import { closest, hexId } from "../util";

export type Tree = Record<string, string>;
export type Commit = { sha: string; parents: string[]; message: string; author: string; date: number; tree: Tree };
export type Tag = { name: string; sha: string; annotated: boolean; message?: string; date: number };
/** The hosted repository (GitHub). Shared by every clone and read by gh/argocd. */
export type Server = { url: string; slug: string; branches: Record<string, string>; tags: Record<string, Tag>; defaultBranch: string };
export type Repo = {
  root: string;
  head: string;
  branches: Record<string, string>;
  index: Tree;
  tags: Record<string, Tag>;
  remotes: Record<string, string>;
  /** remote-tracking refs, e.g. "origin/main" */
  tracking: Record<string, string>;
  /** branch → remote name */
  upstream: Record<string, string>;
  mergeHead?: string;
};
type GitState = { repos: Repo[]; commits: Record<string, Commit>; servers: Record<string, Server>; clock: number; config: Record<string, string> };

export type PushEvent = { server: Server; ref: string; refName: string; refType: "branch" | "tag"; sha: string; before?: string };
/** Called after every successful push (GitHub Actions, Argo CD auto-sync…). */
export const pushHooks: ((sh: Shell, ev: PushEvent) => void)[] = [];

export const AUTHOR = "Danylo <danylo@lab.local>";
const NOT_REPO = "fatal: not a git repository (or any of the parent directories): .git";

export const gitState = (sh: Shell) => sh.ext<GitState>("git", () => ({ repos: [], commits: {}, servers: {}, clock: 0, config: {} }));

const tick = (sh: Shell) => {
  const st = gitState(sh);
  st.clock = Math.max(Date.now(), st.clock + 1000);
  return st.clock;
};

export const short = (sha: string) => sha.slice(0, 7);

// ---------- remote (GitHub) ----------
export const normUrl = (u: string) =>
  u.trim().replace(/^git@github\.com:/, "https://github.com/").replace(/\.git$/, "").replace(/\/$/, "").toLowerCase();
export const slugOf = (u: string) => normUrl(u).replace(/^https?:\/\/[^/]+\//, "");
const GITHUB = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/;

export const serverOf = (sh: Shell, url: string, create = false): Server | undefined => {
  const st = gitState(sh);
  const k = normUrl(url);
  if (!st.servers[k] && create && GITHUB.test(k)) st.servers[k] = { url: url.replace(/\/$/, ""), slug: slugOf(url), branches: {}, tags: {}, defaultBranch: "" };
  return st.servers[k];
};

/** Resolves a revision (HEAD, branch, tag, sha prefix) on the hosted repository. */
export const serverRev = (sh: Shell, server: Server, rev = "HEAD"): { sha: string; tree: Tree; ref: string } | null => {
  const st = gitState(sh);
  let sha: string | undefined;
  let ref = rev;
  if (rev === "HEAD" || rev === "") {
    ref = server.defaultBranch;
    sha = server.branches[server.defaultBranch];
  } else sha = server.branches[rev] ?? server.tags[rev]?.sha ?? Object.keys(st.commits).find((s) => rev.length >= 4 && s.startsWith(rev));
  if (!sha || !st.commits[sha]) return null;
  return { sha, tree: st.commits[sha].tree, ref };
};

export const commitOf = (sh: Shell, sha: string | undefined) => (sha ? gitState(sh).commits[sha] : undefined);

// ---------- repo lookup ----------
export const findRepo = (sh: Shell, dir = sh.cwd) =>
  gitState(sh)
    .repos.filter((r) => dir === r.root || dir.startsWith(r.root + "/"))
    .sort((a, b) => b.root.length - a.root.length)[0];

export const headSha = (repo: Repo) => repo.branches[repo.head];

const treeAt = (sh: Shell, sha?: string): Tree => (sha ? gitState(sh).commits[sha]?.tree ?? {} : {});

const ignoreRules = (sh: Shell, root: string) =>
  (sh.state.files[`${root}/.gitignore`] ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));

const ignored = (rules: string[], rel: string) =>
  rules.some((r) => {
    const pat = r.replace(/^\//, "");
    if (pat.endsWith("/")) {
      const d = pat.slice(0, -1);
      return rel.startsWith(d + "/") || rel.includes("/" + d + "/");
    }
    if (pat.includes("*")) {
      const re = new RegExp("^" + pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*") + "$");
      return re.test(rel) || re.test(rel.split("/").pop()!);
    }
    return rel === pat || rel.split("/").pop() === pat || rel.startsWith(pat + "/");
  });

/** Files of the working tree (relative to the repo root), without .git and ignored files. */
export const worktree = (sh: Shell, repo: Repo): Tree => {
  const out: Tree = {};
  const pre = repo.root + "/";
  const rules = ignoreRules(sh, repo.root);
  for (const [p, c] of Object.entries(sh.state.files)) {
    if (!p.startsWith(pre)) continue;
    const rel = p.slice(pre.length);
    if (rel.startsWith(".git/") || ignored(rules, rel)) continue;
    out[rel] = c;
  }
  return out;
};

const writeTree = (sh: Shell, repo: Repo, from: Tree, to: Tree) => {
  for (const p of Object.keys(from)) if (!(p in to)) delete sh.state.files[`${repo.root}/${p}`];
  for (const [p, c] of Object.entries(to)) sh.state.files[`${repo.root}/${p}`] = c;
};

const changes = (a: Tree, b: Tree) => {
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  for (const k of Object.keys(b).sort()) {
    if (!(k in a)) added.push(k);
    else if (a[k] !== b[k]) modified.push(k);
  }
  for (const k of Object.keys(a).sort()) if (!(k in b)) deleted.push(k);
  return { added, modified, deleted, any: added.length + modified.length + deleted.length > 0 };
};

export const repoStatus = (sh: Shell, repo: Repo) => {
  const head = treeAt(sh, headSha(repo));
  const work = worktree(sh, repo);
  const staged = changes(head, repo.index);
  const unstaged = changes(repo.index, work);
  const untracked = unstaged.added;
  return { staged, unstaged: { ...unstaged, added: [] as string[], any: unstaged.modified.length + unstaged.deleted.length > 0 }, untracked, clean: !staged.any && !unstaged.any };
};

const relTo = (from: string, to: string) => {
  const a = from.split("/").filter(Boolean);
  const b = to.split("/").filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return [...Array(a.length - i).fill(".."), ...b.slice(i)].join("/") || ".";
};

const shown = (sh: Shell, repo: Repo, rel: string) => relTo(sh.cwd, `${repo.root}/${rel}`) + (rel.endsWith("/") ? "/" : "");

/** Collapses untracked files into their top-most untracked directory, like git status. */
const collapseUntracked = (repo: Repo, files: string[]) => {
  const tracked = Object.keys(repo.index);
  const out = new Set<string>();
  for (const f of files) {
    const segs = f.split("/");
    let shownPath = f;
    for (let i = 1; i < segs.length; i++) {
      const dir = segs.slice(0, i).join("/");
      if (!tracked.some((t) => t.startsWith(dir + "/"))) {
        shownPath = dir + "/";
        break;
      }
    }
    out.add(shownPath);
  }
  return [...out].sort();
};

// ---------- ancestry ----------
const ancestors = (sh: Shell, sha?: string) => {
  const st = gitState(sh);
  const seen = new Set<string>();
  const stack = sha ? [sha] : [];
  while (stack.length) {
    const s = stack.pop()!;
    if (seen.has(s) || !st.commits[s]) continue;
    seen.add(s);
    stack.push(...st.commits[s].parents);
  }
  return seen;
};
export const isAncestor = (sh: Shell, maybe: string | undefined, of: string | undefined) => !maybe || ancestors(sh, of).has(maybe);

const mergeBase = (sh: Shell, a: string, b: string) => {
  const anc = ancestors(sh, a);
  const st = gitState(sh);
  return [...ancestors(sh, b)].filter((s) => anc.has(s)).sort((x, y) => st.commits[y].date - st.commits[x].date)[0];
};

export const resolveRef = (sh: Shell, repo: Repo, ref: string): string | undefined => {
  const st = gitState(sh);
  const m = /^(.*?)((?:[~^]\d*)*)$/.exec(ref)!;
  const base = m[1] || "HEAD";
  let sha =
    base === "HEAD"
      ? headSha(repo)
      : repo.branches[base] ?? repo.tracking[base] ?? repo.tags[base]?.sha ?? (base.length >= 4 ? Object.keys(st.commits).find((s) => s.startsWith(base)) : undefined);
  for (const op of m[2].match(/[~^]\d*/g) ?? []) {
    const n = op.length > 1 ? Number(op.slice(1)) : 1;
    for (let i = 0; i < (op[0] === "^" ? 1 : n) && sha; i++) sha = st.commits[sha]?.parents[op[0] === "^" && n > 1 ? n - 1 : 0];
  }
  return sha;
};

// ---------- diff ----------
const lines = (s: string | undefined) => {
  if (!s) return [];
  const l = s.split("\n");
  if (l[l.length - 1] === "") l.pop();
  return l;
};

type Op = [" " | "-" | "+", string];
export const lineDiff = (a: string[], b: string[]): Op[] => {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      ops.push([" ", a[i]]);
      i++;
      j++;
    } else if (i < n && (j >= m || dp[i + 1][j] >= dp[i][j + 1])) ops.push(["-", a[i++]]);
    else ops.push(["+", b[j++]]);
  }
  return ops;
};

const hunks = (ops: Op[], ctx = 3) => {
  const out: string[] = [];
  const changed = ops.map((o, i) => (o[0] !== " " ? i : -1)).filter((i) => i >= 0);
  if (!changed.length) return out;
  const groups: [number, number][] = [];
  for (const i of changed) {
    const last = groups[groups.length - 1];
    if (last && i - last[1] <= ctx * 2) last[1] = i;
    else groups.push([i, i]);
  }
  for (const [s, e] of groups) {
    const from = Math.max(0, s - ctx);
    const to = Math.min(ops.length - 1, e + ctx);
    let aStart = 1;
    let bStart = 1;
    for (let k = 0; k < from; k++) {
      if (ops[k][0] !== "+") aStart++;
      if (ops[k][0] !== "-") bStart++;
    }
    const slice = ops.slice(from, to + 1);
    const aLen = slice.filter((o) => o[0] !== "+").length;
    const bLen = slice.filter((o) => o[0] !== "-").length;
    out.push(`@@ -${aLen ? aStart : 0},${aLen} +${bLen ? bStart : 0},${bLen} @@`);
    for (const [t, l] of slice) out.push(t + l);
  }
  return out;
};

const blobId = (c?: string) => {
  let h = 0;
  for (const ch of c ?? "") h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return c === undefined ? "0000000" : h.toString(16).padStart(8, "0").slice(0, 7);
};

export const unifiedDiff = (a: Tree, b: Tree, paths?: string[]) => {
  const all = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort().filter((p) => a[p] !== b[p]);
  const out: string[] = [];
  for (const p of all) {
    if (paths?.length && !paths.some((x) => p === x || p.startsWith(x.replace(/\/$/, "") + "/") || x === "." || x === "")) continue;
    out.push(`diff --git a/${p} b/${p}`);
    if (!(p in a)) out.push("new file mode 100644");
    if (!(p in b)) out.push("deleted file mode 100644");
    out.push(`index ${blobId(a[p])}..${blobId(b[p])}${p in a && p in b ? " 100644" : ""}`);
    out.push(p in a ? `--- a/${p}` : "--- /dev/null", p in b ? `+++ b/${p}` : "+++ /dev/null");
    out.push(...hunks(lineDiff(lines(a[p]), lines(b[p]))));
  }
  return out.join("\n");
};

const stats = (a: Tree, b: Tree) => {
  const files = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort().filter((p) => a[p] !== b[p]);
  let ins = 0;
  let del = 0;
  const per: { p: string; ins: number; del: number }[] = [];
  for (const p of files) {
    const ops = lineDiff(lines(a[p]), lines(b[p]));
    const i = ops.filter((o) => o[0] === "+").length;
    const d = ops.filter((o) => o[0] === "-").length;
    ins += i;
    del += d;
    per.push({ p, ins: i, del: d });
  }
  const summary =
    ` ${files.length} file${files.length === 1 ? "" : "s"} changed` +
    (ins ? `, ${ins} insertion${ins === 1 ? "" : "s"}(+)` : "") +
    (del ? `, ${del} deletion${del === 1 ? "" : "s"}(-)` : "") +
    (!ins && !del ? ", 0 insertions(+), 0 deletions(-)" : "");
  const modes = [
    ...files.filter((p) => !(p in a)).map((p) => ` create mode 100644 ${p}`),
    ...files.filter((p) => !(p in b)).map((p) => ` delete mode 100644 ${p}`),
  ];
  return { files, summary, modes, per };
};

// ---------- three-way merge ----------
const merge3 = (base: Tree, ours: Tree, theirs: Tree, theirLabel: string) => {
  const out: Tree = {};
  const conflicts: string[] = [];
  for (const p of new Set([...Object.keys(base), ...Object.keys(ours), ...Object.keys(theirs)])) {
    const [b, o, t] = [base[p], ours[p], theirs[p]];
    let r: string | undefined;
    if (o === t) r = o;
    else if (o === b) r = t;
    else if (t === b) r = o;
    else {
      conflicts.push(p);
      r = `<<<<<<< HEAD\n${o ?? ""}${o?.endsWith("\n") ? "" : "\n"}=======\n${t ?? ""}${t?.endsWith("\n") ? "" : "\n"}>>>>>>> ${theirLabel}\n`;
    }
    if (r !== undefined) out[p] = r;
  }
  return { tree: out, conflicts };
};

// ---------- formatting ----------
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const gitDate = (t: number) => {
  const d = new Date(t);
  return `${DOW[d.getUTCDay()]} ${MON[d.getUTCMonth()]} ${d.getUTCDate()} ${d.toISOString().slice(11, 19)} ${d.getUTCFullYear()} +0000`;
};

const decorations = (repo: Repo, sha: string) => {
  const out: string[] = [];
  if (headSha(repo) === sha) out.push(`HEAD -> ${repo.head}`);
  for (const [t, v] of Object.entries(repo.tags)) if (v.sha === sha) out.push(`tag: ${t}`);
  for (const [b, v] of Object.entries(repo.tracking)) if (v === sha) out.push(b);
  for (const [b, v] of Object.entries(repo.branches)) if (v === sha && b !== repo.head) out.push(b);
  return out.length ? ` (${out.join(", ")})` : "";
};

// ---------- operations shared with seeds ----------
const newCommit = (sh: Shell, repo: Repo, message: string, tree: Tree, parents: string[]) => {
  const st = gitState(sh);
  const c: Commit = { sha: hexId(40), parents, message, author: AUTHOR, date: tick(sh), tree: { ...tree } };
  st.commits[c.sha] = c;
  repo.branches[repo.head] = c.sha;
  return c;
};

export const initRepo = (sh: Shell, root: string, branch = "main"): Repo => {
  const st = gitState(sh);
  const repo: Repo = { root, head: branch, branches: {}, index: {}, tags: {}, remotes: {}, tracking: {}, upstream: {} };
  st.repos.push(repo);
  sh.mkdir(`${root}/.git`);
  sh.writeFile(`${root}/.git/HEAD`, `ref: refs/heads/${branch}\n`);
  return repo;
};

// ---------- subcommands ----------
type Out = ToolResult;
const fail = (output: string): Out => ({ output, ok: false });

const statusText = (sh: Shell, repo: Repo, forCommit = false) => {
  const s = repoStatus(sh, repo);
  const out: string[] = [`On branch ${repo.head}`];
  const head = headSha(repo);
  const up = repo.upstream[repo.head];
  if (up && head) {
    const tr = repo.tracking[`${up}/${repo.head}`];
    const ahead = [...ancestors(sh, head)].filter((x) => !ancestors(sh, tr).has(x)).length;
    const behind = [...ancestors(sh, tr)].filter((x) => !ancestors(sh, head).has(x)).length;
    if (!ahead && !behind) out.push(`Your branch is up to date with '${up}/${repo.head}'.`);
    else if (ahead && !behind) out.push(`Your branch is ahead of '${up}/${repo.head}' by ${ahead} commit${ahead > 1 ? "s" : ""}.`, `  (use "git push" to publish your local commits)`);
    else if (behind && !ahead) out.push(`Your branch is behind '${up}/${repo.head}' by ${behind} commit${behind > 1 ? "s" : ""}, and can be fast-forwarded.`, `  (use "git pull" to update your local branch)`);
    else out.push(`Your branch and '${up}/${repo.head}' have diverged.`);
  }
  if (!head) out.push("", "No commits yet");
  if (repo.mergeHead) out.push("", "You have unmerged paths.", "  (fix conflicts and run \"git commit\")");
  const p = (x: string) => shown(sh, repo, x);
  if (s.staged.any) {
    out.push("", "Changes to be committed:", head ? '  (use "git restore --staged <file>..." to unstage)' : '  (use "git rm --cached <file>..." to unstage)');
    for (const f of s.staged.added) out.push(`\tnew file:   ${p(f)}`);
    for (const f of s.staged.modified) out.push(`\tmodified:   ${p(f)}`);
    for (const f of s.staged.deleted) out.push(`\tdeleted:    ${p(f)}`);
  }
  if (s.unstaged.any) {
    out.push("", "Changes not staged for commit:", '  (use "git add <file>..." to update what will be committed)', '  (use "git restore <file>..." to discard changes in working directory)');
    for (const f of s.unstaged.modified) out.push(`\tmodified:   ${p(f)}`);
    for (const f of s.unstaged.deleted) out.push(`\tdeleted:    ${p(f)}`);
  }
  if (s.untracked.length) {
    out.push("", "Untracked files:", '  (use "git add <file>..." to include in what will be committed)');
    for (const f of collapseUntracked(repo, s.untracked)) out.push(`\t${p(f)}`);
  }
  out.push("");
  if (!s.staged.any) {
    if (s.unstaged.any) out.push('no changes added to commit (use "git add" and/or "git commit -a")');
    else if (s.untracked.length) out.push(`nothing added to commit but untracked files present (use "git add" to track)`);
    else out.push(head ? "nothing to commit, working tree clean" : `nothing to commit (create/copy files and use "git add" to track)`);
  } else if (forCommit) out.pop();
  return out.join("\n").replace(/\n+$/, "");
};

const status = (sh: Shell, repo: Repo, args: string[]): Out => {
  if (args.includes("-s") || args.includes("--short") || args.includes("--porcelain")) {
    const s = repoStatus(sh, repo);
    const rows = new Map<string, string>();
    for (const f of s.staged.added) rows.set(f, "A ");
    for (const f of s.staged.modified) rows.set(f, "M ");
    for (const f of s.staged.deleted) rows.set(f, "D ");
    for (const f of s.unstaged.modified) rows.set(f, (rows.get(f)?.[0] ?? " ") + "M");
    for (const f of s.unstaged.deleted) rows.set(f, (rows.get(f)?.[0] ?? " ") + "D");
    const out = [...rows.entries()].sort().map(([f, c]) => `${c} ${shown(sh, repo, f)}`);
    for (const f of collapseUntracked(repo, s.untracked)) out.push(`?? ${shown(sh, repo, f)}`);
    return out.join("\n");
  }
  return statusText(sh, repo);
};

const add = (sh: Shell, repo: Repo, args: string[]): Out => {
  const all = args.includes("-A") || args.includes("--all");
  const specs = args.filter((a) => !a.startsWith("-"));
  if (!all && !specs.length) return fail("Nothing specified, nothing added.\nhint: Maybe you wanted to say 'git add .'?");
  const work = worktree(sh, repo);
  const rels: string[] = [];
  if (all && !specs.length) rels.push("");
  for (const sp of specs) {
    const abs = sh.resolve(sp);
    if (abs !== repo.root && !abs.startsWith(repo.root + "/")) return fail(`fatal: ${sp}: '${sp}' is outside repository at '${repo.root}'`);
    rels.push(abs === repo.root ? "" : abs.slice(repo.root.length + 1));
  }
  const matches = (p: string, r: string) => r === "" || p === r || p.startsWith(r + "/");
  for (const r of rels) {
    const hitWork = Object.keys(work).filter((p) => matches(p, r));
    const hitIdx = Object.keys(repo.index).filter((p) => matches(p, r));
    if (!hitWork.length && !hitIdx.length) {
      const abs = r ? `${repo.root}/${r}` : repo.root;
      if (sh.state.files[abs] !== undefined || sh.isDir(abs)) continue;
      return fail(`fatal: pathspec '${specs[rels.indexOf(r)] ?? r}' did not match any files`);
    }
    for (const p of hitWork) repo.index[p] = work[p];
    for (const p of hitIdx) if (!(p in work)) delete repo.index[p];
  }
  return "";
};

const commit = (sh: Shell, repo: Repo, args: string[]): Out => {
  const msgs: string[] = [];
  let all = false;
  let amend = false;
  let allowEmpty = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-m" || a === "--message") msgs.push(args[++i] ?? "");
    else if (a.startsWith("--message=")) msgs.push(a.slice(10));
    else if (/^-[a-z]*m$/.test(a) && a.length > 2) {
      if (a.includes("a")) all = true;
      msgs.push(args[++i] ?? "");
    } else if (a === "-a" || a === "--all") all = true;
    else if (a === "--amend") amend = true;
    else if (a === "--allow-empty") allowEmpty = true;
  }
  if (all) {
    const work = worktree(sh, repo);
    for (const p of Object.keys(repo.index)) {
      if (p in work) repo.index[p] = work[p];
      else delete repo.index[p];
    }
  }
  const head = headSha(repo);
  const prev = amend ? commitOf(sh, head) : undefined;
  if (amend && !prev) return fail("fatal: You have nothing to amend.");
  const baseTree = treeAt(sh, amend ? prev!.parents[0] : head);
  const s = changes(amend ? baseTree : treeAt(sh, head), repo.index);
  if (!s.any && !allowEmpty && !amend && !repo.mergeHead) return fail(statusText(sh, repo));
  const message = msgs.length ? msgs.join("\n\n") : repo.mergeHead ? `Merge commit '${short(repo.mergeHead)}'` : amend ? prev!.message : "";
  if (!message.trim()) return fail("Aborting commit due to empty commit message.\nhint: use git commit -m \"mensagem\"");
  if (Object.values(repo.index).some((c) => c.includes("<<<<<<< HEAD")))
    return fail("error: Committing is not possible because you have unmerged files.\nhint: Fix them up in the work tree, and then use 'git add <file>'\nfatal: Exiting because of an unresolved conflict.");
  const parents = amend ? prev!.parents : [...(head ? [head] : []), ...(repo.mergeHead ? [repo.mergeHead] : [])];
  const c = newCommit(sh, repo, message, repo.index, parents);
  repo.mergeHead = undefined;
  const st = stats(baseTree, repo.index);
  const root = !parents.length ? " (root-commit)" : "";
  return [`[${repo.head}${root} ${short(c.sha)}] ${message.split("\n")[0]}`, ...(amend ? [` Date: ${gitDate(c.date)}`] : []), st.summary, ...st.modes].join("\n");
};

const log = (sh: Shell, repo: Repo, args: string[]): Out => {
  let n = Infinity;
  let oneline = false;
  let start: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--oneline") oneline = true;
    else if (a === "-n" || a === "--max-count") n = Number(args[++i]);
    else if (/^-\d+$/.test(a)) n = Number(a.slice(1));
    else if (a.startsWith("--max-count=")) n = Number(a.split("=")[1]);
    else if (a.startsWith("--pretty=oneline") || a === "--format=oneline") oneline = true;
    else if (!a.startsWith("-")) start = a;
  }
  const from = start ? resolveRef(sh, repo, start) : headSha(repo);
  if (!from) {
    if (start) return fail(`fatal: ambiguous argument '${start}': unknown revision or path not in the working tree.`);
    return fail(`fatal: your current branch '${repo.head}' does not have any commits yet`);
  }
  const st = gitState(sh);
  const list = [...ancestors(sh, from)].map((s) => st.commits[s]).sort((a, b) => b.date - a.date).slice(0, n);
  if (oneline) return list.map((c) => `${short(c.sha)}${decorations(repo, c.sha)} ${c.message.split("\n")[0]}`).join("\n");
  return list
    .map((c) =>
      [
        `commit ${c.sha}${decorations(repo, c.sha)}`,
        ...(c.parents.length > 1 ? [`Merge: ${c.parents.map(short).join(" ")}`] : []),
        `Author: ${c.author}`,
        `Date:   ${gitDate(c.date)}`,
        "",
        ...c.message.split("\n").map((l) => `    ${l}`),
      ].join("\n"),
    )
    .join("\n\n");
};

const diff = (sh: Shell, repo: Repo, args: string[]): Out => {
  const staged = args.includes("--staged") || args.includes("--cached");
  const stat = args.includes("--stat");
  const nameOnly = args.includes("--name-only");
  const pos = args.filter((a) => !a.startsWith("-"));
  const paths: string[] = [];
  let a: Tree;
  let b: Tree;
  const refs = pos.filter((p) => !p.includes("/") && resolveRef(sh, repo, p) && !sh.exists(p));
  const rest = pos.filter((p) => !refs.includes(p));
  for (const p of rest) {
    const abs = sh.resolve(p);
    paths.push(abs === repo.root ? "" : abs.slice(repo.root.length + 1));
  }
  if (refs.length >= 2) {
    a = treeAt(sh, resolveRef(sh, repo, refs[0]));
    b = treeAt(sh, resolveRef(sh, repo, refs[1]));
  } else if (refs.length === 1) {
    a = treeAt(sh, resolveRef(sh, repo, refs[0]));
    b = staged ? repo.index : { ...repo.index, ...pick(worktree(sh, repo), Object.keys(repo.index)) };
  } else if (staged) {
    a = treeAt(sh, headSha(repo));
    b = repo.index;
  } else {
    a = repo.index;
    const w = worktree(sh, repo);
    b = Object.fromEntries(Object.keys(repo.index).filter((p) => p in w).map((p) => [p, w[p]]));
  }
  if (nameOnly) return changesList(a, b).join("\n");
  if (stat) {
    const s = stats(a, b);
    if (!s.files.length) return "";
    return [...s.per.map((x) => ` ${x.p} | ${x.ins + x.del} ${"+".repeat(x.ins)}${"-".repeat(x.del)}`), s.summary].join("\n");
  }
  return unifiedDiff(a, b, paths.length ? paths : undefined);
};
const pick = (t: Tree, keys: string[]) => Object.fromEntries(keys.filter((k) => k in t).map((k) => [k, t[k]]));
const changesList = (a: Tree, b: Tree) => [...new Set([...Object.keys(a), ...Object.keys(b)])].sort().filter((p) => a[p] !== b[p]);

/** Checks that switching trees won't clobber local changes, then updates index + worktree. */
const moveTo = (sh: Shell, repo: Repo, target: string | undefined, verb: "checkout" | "merge" = "checkout"): string | null => {
  const from = treeAt(sh, headSha(repo));
  const to = treeAt(sh, target);
  const work = worktree(sh, repo);
  const dirty = [...new Set([...Object.keys(repo.index), ...Object.keys(from)])].filter((p) => (repo.index[p] !== from[p] || work[p] !== repo.index[p]) && from[p] !== to[p]);
  if (dirty.length)
    return `error: Your local changes to the following files would be overwritten by ${verb}:\n${dirty.map((p) => `\t${p}`).join("\n")}\nPlease commit your changes or stash them before you ${verb === "checkout" ? "switch branches" : "merge"}.\nAborting`;
  const untrackedClash = Object.keys(to).filter((p) => !(p in from) && p in work && !(p in repo.index) && work[p] !== to[p]);
  if (untrackedClash.length)
    return `error: The following untracked working tree files would be overwritten by ${verb}:\n${untrackedClash.map((p) => `\t${p}`).join("\n")}\nPlease move or remove them before you ${verb === "checkout" ? "switch branches" : "merge"}.\nAborting`;
  for (const p of Object.keys(from)) if (!(p in to) && work[p] === from[p]) delete sh.state.files[`${repo.root}/${p}`];
  for (const [p, c] of Object.entries(to)) if (from[p] !== c) sh.state.files[`${repo.root}/${p}`] = c;
  for (const p of Object.keys(from)) if (!(p in to)) delete repo.index[p];
  for (const [p, c] of Object.entries(to)) if (from[p] !== c || !(p in repo.index)) repo.index[p] = c;
  return null;
};

const switchBranch = (sh: Shell, repo: Repo, name: string, create: boolean, startRef?: string): Out => {
  if (create) {
    if (repo.branches[name]) return fail(`fatal: a branch named '${name}' already exists`);
    const start = startRef ? resolveRef(sh, repo, startRef) : headSha(repo);
    if (startRef && !start) return fail(`fatal: '${startRef}' is not a commit and a branch '${name}' cannot be created from it`);
    const err = moveTo(sh, repo, start);
    if (err) return fail(err);
    if (start) repo.branches[name] = start;
    repo.head = name;
    sh.writeFile(`${repo.root}/.git/HEAD`, `ref: refs/heads/${name}\n`);
    return `Switched to a new branch '${name}'`;
  }
  if (name === repo.head) return `Already on '${name}'`;
  let target = repo.branches[name];
  let tracking = "";
  if (!target) {
    const remoteRef = Object.keys(repo.tracking).find((t) => t.split("/").slice(1).join("/") === name);
    if (!remoteRef) return fail(`error: pathspec '${name}' did not match any file(s) known to git`);
    target = repo.tracking[remoteRef];
    tracking = `branch '${name}' set up to track '${remoteRef}'.\n`;
  }
  const err = moveTo(sh, repo, target);
  if (err) return fail(err);
  repo.branches[name] = target;
  if (tracking) repo.upstream[name] = "origin";
  repo.head = name;
  sh.writeFile(`${repo.root}/.git/HEAD`, `ref: refs/heads/${name}\n`);
  return `${tracking}Switched to branch '${name}'`;
};

const checkout = (sh: Shell, repo: Repo, args: string[], isSwitch: boolean): Out => {
  const dd = args.indexOf("--");
  const files = dd >= 0 ? args.slice(dd + 1) : [];
  const main = dd >= 0 ? args.slice(0, dd) : args;
  const createFlag = isSwitch ? ["-c", "--create", "-C"] : ["-b", "-B"];
  const ci = main.findIndex((a) => createFlag.includes(a));
  if (ci >= 0) {
    const name = main[ci + 1];
    if (!name) return fail(`error: switch \`${main[ci].replace(/^-+/, "")}' requires a value`);
    return switchBranch(sh, repo, name, true, main.filter((a, i) => i !== ci && i !== ci + 1 && !a.startsWith("-"))[0]);
  }
  const pos = main.filter((a) => !a.startsWith("-"));
  if (!pos.length && !files.length) return fail(isSwitch ? "fatal: missing branch or commit argument" : "");
  const target = pos[0];
  if (!isSwitch && (files.length || (target && !repo.branches[target] && !Object.keys(repo.tracking).some((t) => t.endsWith("/" + target)) && sh.exists(target)))) {
    // restore files from the index
    const list = files.length ? files : pos;
    for (const f of list) {
      const abs = sh.resolve(f);
      const rel = abs.slice(repo.root.length + 1);
      const hit = Object.keys(repo.index).filter((p) => p === rel || p.startsWith(rel + "/") || abs === repo.root);
      if (!hit.length) return fail(`error: pathspec '${f}' did not match any file(s) known to git`);
      for (const p of hit) sh.state.files[`${repo.root}/${p}`] = repo.index[p];
    }
    return list.length === 1 ? "Updated 1 path from the index" : `Updated ${list.length} paths from the index`;
  }
  return switchBranch(sh, repo, target, false);
};

const restore = (sh: Shell, repo: Repo, args: string[]): Out => {
  const staged = args.includes("--staged") || args.includes("-S");
  const files = args.filter((a) => !a.startsWith("-"));
  if (!files.length) return fail("fatal: you must specify path(s) to restore");
  const head = treeAt(sh, headSha(repo));
  for (const f of files) {
    const abs = sh.resolve(f);
    const rel = abs === repo.root ? "" : abs.slice(repo.root.length + 1);
    const m = (p: string) => rel === "" || p === rel || p.startsWith(rel + "/");
    const pool = staged ? [...new Set([...Object.keys(head), ...Object.keys(repo.index)])] : Object.keys(repo.index);
    const hit = pool.filter(m);
    if (!hit.length) return fail(`error: pathspec '${f}' did not match any file(s) known to git`);
    for (const p of hit) {
      if (staged) {
        if (p in head) repo.index[p] = head[p];
        else delete repo.index[p];
      } else sh.state.files[`${repo.root}/${p}`] = repo.index[p];
    }
  }
  return "";
};

const branch = (sh: Shell, repo: Repo, args: string[]): Out => {
  const pos = args.filter((a) => !a.startsWith("-"));
  if (args.includes("-M") || args.includes("-m")) {
    const [a, b] = pos;
    const from = b ? a : repo.head;
    const to = b ?? a;
    if (!to) return fail("fatal: branch name required");
    if (repo.branches[from]) {
      repo.branches[to] = repo.branches[from];
      if (from !== to) delete repo.branches[from];
    }
    if (repo.head === from) {
      repo.head = to;
      sh.writeFile(`${repo.root}/.git/HEAD`, `ref: refs/heads/${to}\n`);
    }
    return "";
  }
  if (args.includes("-d") || args.includes("-D") || args.includes("--delete")) {
    const name = pos[0];
    if (!repo.branches[name]) return fail(`error: branch '${name}' not found`);
    if (name === repo.head) return fail(`error: cannot delete branch '${name}' used by worktree at '${repo.root}'`);
    if (!args.includes("-D") && !isAncestor(sh, repo.branches[name], headSha(repo)))
      return fail(`error: the branch '${name}' is not fully merged.\nIf you are sure you want to delete it, run 'git branch -D ${name}'`);
    const sha = repo.branches[name];
    delete repo.branches[name];
    return `Deleted branch ${name} (was ${short(sha)}).`;
  }
  if (pos.length) {
    const [name, start] = pos;
    if (repo.branches[name]) return fail(`fatal: a branch named '${name}' already exists`);
    const sha = start ? resolveRef(sh, repo, start) : headSha(repo);
    if (!sha) return fail(`fatal: not a valid object name: '${start ?? repo.head}'`);
    repo.branches[name] = sha;
    return "";
  }
  const names = [...new Set([...Object.keys(repo.branches), ...(headSha(repo) ? [] : [repo.head])])].sort();
  const out = names.filter((b) => repo.branches[b]).map((b) => `${b === repo.head ? "*" : " "} ${b}${args.includes("-v") ? ` ${short(repo.branches[b])} ${commitOf(sh, repo.branches[b])?.message.split("\n")[0]}` : ""}`);
  if (args.includes("-a") || args.includes("-r"))
    out.push(...Object.keys(repo.tracking).sort().map((t) => `  remotes/${t}`));
  return (args.includes("-r") ? out.filter((l) => l.includes("remotes/")) : out).join("\n");
};

const doMerge = (sh: Shell, repo: Repo, theirs: string, label: string, pullMsg = false): Out => {
  const ours = headSha(repo);
  if (isAncestor(sh, theirs, ours)) return "Already up to date.";
  if (!ours || isAncestor(sh, ours, theirs)) {
    const before = treeAt(sh, ours);
    const err = moveTo(sh, repo, theirs, "merge");
    if (err) return fail(err);
    repo.branches[repo.head] = theirs;
    const st = stats(before, treeAt(sh, theirs));
    return [`Updating ${short(ours ?? theirs)}..${short(theirs)}`, "Fast-forward", ...st.per.map((x) => ` ${x.p} | ${x.ins + x.del} ${"+".repeat(x.ins)}${"-".repeat(x.del)}`), st.summary, ...st.modes].join("\n");
  }
  const s = repoStatus(sh, repo);
  if (s.staged.any || s.unstaged.any) return fail(`error: Your local changes to the following files would be overwritten by merge:\n${[...s.staged.modified, ...s.unstaged.modified].map((p) => `\t${p}`).join("\n")}\nPlease commit your changes or stash them before you merge.\nAborting`);
  const base = mergeBase(sh, ours, theirs);
  const oursTree = treeAt(sh, ours);
  const { tree, conflicts } = merge3(treeAt(sh, base), oursTree, treeAt(sh, theirs), label);
  writeTree(sh, repo, oursTree, tree);
  if (conflicts.length) {
    repo.mergeHead = theirs;
    repo.index = Object.fromEntries(Object.entries(tree).filter(([p]) => !conflicts.includes(p)));
    for (const p of conflicts) if (p in oursTree) repo.index[p] = oursTree[p];
    return fail([...conflicts.map((p) => `Auto-merging ${p}\nCONFLICT (content): Merge conflict in ${p}`), "Automatic merge failed; fix conflicts and then commit the result."].join("\n"));
  }
  repo.index = { ...tree };
  const msg = pullMsg ? `Merge branch '${label.split("/").pop()}' of ${repo.remotes[label.split("/")[0]] ?? label}` : `Merge branch '${label}'`;
  newCommit(sh, repo, msg, tree, [ours, theirs]);
  const st = stats(oursTree, tree);
  return ["Merge made by the 'ort' strategy.", ...st.per.map((x) => ` ${x.p} | ${x.ins + x.del} ${"+".repeat(x.ins)}${"-".repeat(x.del)}`), st.summary, ...st.modes].join("\n");
};

const merge = (sh: Shell, repo: Repo, args: string[]): Out => {
  if (args.includes("--abort")) {
    if (!repo.mergeHead) return fail("fatal: There is no merge to abort (MERGE_HEAD missing).");
    const t = treeAt(sh, headSha(repo));
    writeTree(sh, repo, worktree(sh, repo), t);
    repo.index = { ...t };
    repo.mergeHead = undefined;
    return "";
  }
  const name = args.filter((a) => !a.startsWith("-"))[0];
  if (!name) return fail("fatal: No remote for the current branch.");
  const theirs = resolveRef(sh, repo, name);
  if (!theirs) return fail(`merge: ${name} - not something we can merge`);
  return doMerge(sh, repo, theirs, name);
};

const fetchRemote = (sh: Shell, repo: Repo, remote: string): { out: string[]; err?: string } => {
  const url = repo.remotes[remote];
  if (!url) return { out: [], err: `fatal: '${remote}' does not appear to be a git repository\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.` };
  const server = serverOf(sh, url, true);
  if (!server) return { out: [], err: `fatal: unable to access '${url}/': Could not resolve host: ${url.replace(/^\w+:\/\//, "").split("/")[0]}` };
  const out: string[] = [];
  for (const [b, sha] of Object.entries(server.branches)) {
    const prev = repo.tracking[`${remote}/${b}`];
    if (prev !== sha) out.push(prev ? `   ${short(prev)}..${short(sha)}  ${b.padEnd(10)} -> ${remote}/${b}` : ` * [new branch]      ${b.padEnd(10)} -> ${remote}/${b}`);
    repo.tracking[`${remote}/${b}`] = sha;
  }
  for (const [t, tag] of Object.entries(server.tags))
    if (!repo.tags[t]) {
      repo.tags[t] = { ...tag };
      out.push(` * [new tag]         ${t.padEnd(10)} -> ${t}`);
    }
  return { out: out.length ? [`From ${url.replace(/\.git$/, "")}`, ...out] : [] };
};

const pull = (sh: Shell, repo: Repo, args: string[]): Out => {
  const pos = args.filter((a) => !a.startsWith("-"));
  const remote = pos[0] ?? repo.upstream[repo.head] ?? (Object.keys(repo.remotes).length ? "origin" : "");
  if (!remote) return fail("There is no tracking information for the current branch.\nPlease specify which branch you want to merge with.\n\n    git pull <remote> <branch>\n\nfatal: no remote configured");
  const f = fetchRemote(sh, repo, remote);
  if (f.err) return fail(f.err);
  const br = pos[1] ?? repo.head;
  const theirs = repo.tracking[`${remote}/${br}`];
  if (!theirs) return fail(`${f.out.join("\n")}\nfatal: couldn't find remote ref ${br}`.trim());
  const rebase = args.includes("--rebase") || args.includes("-r");
  const ours = headSha(repo);
  if (rebase && ours && !isAncestor(sh, theirs, ours) && !isAncestor(sh, ours, theirs)) {
    const st = gitState(sh);
    const base = mergeBase(sh, ours, theirs);
    const mine = [...ancestors(sh, ours)].filter((s) => !ancestors(sh, base).has(s)).map((s) => st.commits[s]).sort((a, b) => a.date - b.date);
    const s = repoStatus(sh, repo);
    if (s.staged.any || s.unstaged.any) return fail("error: cannot pull with rebase: You have unstaged changes.\nerror: Please commit or stash them.");
    let tip = theirs;
    for (const c of mine) {
      const parentTree = treeAt(sh, c.parents[0]);
      const { tree, conflicts } = merge3(parentTree, treeAt(sh, tip), c.tree, short(c.sha));
      if (conflicts.length) return fail(`CONFLICT (content): Merge conflict in ${conflicts[0]}\nerror: could not apply ${short(c.sha)}... ${c.message}`);
      const nc: Commit = { ...c, sha: hexId(40), parents: [tip], tree, date: tick(sh) };
      st.commits[nc.sha] = nc;
      tip = nc.sha;
    }
    writeTree(sh, repo, treeAt(sh, ours), treeAt(sh, tip));
    repo.branches[repo.head] = tip;
    repo.index = { ...treeAt(sh, tip) };
    return [...f.out, ` * branch            ${br}       -> FETCH_HEAD`, `Successfully rebased and updated refs/heads/${repo.head}.`].join("\n");
  }
  const r = doMerge(sh, repo, theirs, `${remote}/${br}`, true);
  const text = typeof r === "string" ? r : r.output;
  const out = [...f.out, ` * branch            ${br}       -> FETCH_HEAD`, text].join("\n");
  return typeof r === "string" ? out : { ...r, output: out };
};

const fetch = (sh: Shell, repo: Repo, args: string[]): Out => {
  const remote = args.filter((a) => !a.startsWith("-"))[0] ?? "origin";
  const f = fetchRemote(sh, repo, remote);
  return f.err ? fail(f.err) : f.out.join("\n");
};

const objectsLine = (n: number) => {
  const objs = Math.max(3, n * 3);
  return [
    `Enumerating objects: ${objs}, done.`,
    `Counting objects: 100% (${objs}/${objs}), done.`,
    "Delta compression using up to 8 threads",
    `Compressing objects: 100% (${Math.ceil(objs / 2)}/${Math.ceil(objs / 2)}), done.`,
    `Writing objects: 100% (${objs}/${objs}), ${objs * 211} bytes | ${objs * 211}.00 KiB/s, done.`,
    `Total ${objs} (delta ${Math.floor(objs / 3)}), reused 0 (delta 0), pack-reused 0`,
  ];
};

const push = (sh: Shell, repo: Repo, args: string[]): Out => {
  const setUp = args.includes("-u") || args.includes("--set-upstream");
  const force = args.includes("-f") || args.includes("--force") || args.includes("--force-with-lease");
  const tagsAll = args.includes("--tags");
  const pos = args.filter((a) => !a.startsWith("-"));
  const remotes = Object.keys(repo.remotes);
  if (!remotes.length)
    return fail("fatal: No configured push destination.\nEither specify the URL from the command-line or configure a remote repository using\n\n    git remote add <name> <url>\n\nand then push using the remote name\n\n    git push <name>");
  const remote = pos[0] ?? repo.upstream[repo.head] ?? (remotes.length === 1 && !tagsAll ? "" : "origin");
  if (remote === "") {
    return fail(`fatal: The current branch ${repo.head} has no upstream branch.\nTo push the current branch and set the remote as upstream, use\n\n    git push --set-upstream ${remotes[0]} ${repo.head}\n\nTo have this happen automatically for branches without a tracking\nupstream, see 'push.autoSetupRemote' in 'git help config'.`);
  }
  const url = repo.remotes[remote];
  if (!url) return fail(`fatal: '${remote}' does not appear to be a git repository\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.`);
  const server = serverOf(sh, url, true);
  if (!server) return fail(`fatal: unable to access '${url}/': Could not resolve host: ${url.replace(/^\w+:\/\//, "").split("/")[0]}`);
  let specs = pos.slice(1);
  if (!specs.length && !tagsAll) specs = [repo.head];
  const lines: string[] = [];
  const errors: string[] = [];
  const events: PushEvent[] = [];
  let newCommits = 0;
  let upstreamMsg = "";
  for (const spec of specs) {
    const [src, dst0] = spec.split(":");
    const local = src === "HEAD" ? repo.head : src;
    const dst = dst0 ?? local;
    if (repo.branches[local]) {
      const sha = repo.branches[local];
      const cur = server.branches[dst];
      if (cur === sha) continue;
      if (cur && !force && !isAncestor(sh, cur, sha)) {
        lines.push(` ! [rejected]        ${local} -> ${dst} (fetch first)`);
        errors.push(
          `error: failed to push some refs to '${url}'`,
          "hint: Updates were rejected because the remote contains work that you do not",
          "hint: have locally. This is usually caused by another repository pushing to",
          "hint: the same ref. If you want to integrate the remote changes, use",
          "hint: 'git pull' before pushing again.",
          "hint: See the 'Note about fast-forwards' in 'git push --help' for details.",
        );
        continue;
      }
      newCommits += [...ancestors(sh, sha)].filter((s) => !ancestors(sh, cur).has(s)).length;
      lines.push(cur ? ` ${force && !isAncestor(sh, cur, sha) ? "+" : " "} ${short(cur)}..${short(sha)}  ${local} -> ${dst}${force && !isAncestor(sh, cur, sha) ? " (forced update)" : ""}` : ` * [new branch]      ${local} -> ${dst}`);
      server.branches[dst] = sha;
      if (!server.defaultBranch) server.defaultBranch = dst;
      repo.tracking[`${remote}/${dst}`] = sha;
      if (setUp) {
        repo.upstream[local] = remote;
        upstreamMsg = `branch '${local}' set up to track '${remote}/${dst}'.`;
      }
      events.push({ server, ref: `refs/heads/${dst}`, refName: dst, refType: "branch", sha, before: cur });
    } else if (repo.tags[local]) {
      const tag = repo.tags[local];
      if (server.tags[local]?.sha === tag.sha) continue;
      if (server.tags[local] && !force) {
        lines.push(` ! [rejected]        ${local} -> ${local} (already exists)`);
        errors.push(`error: failed to push some refs to '${url}'`, "hint: Updates were rejected because the tag already exists in the remote.");
        continue;
      }
      newCommits += 1;
      server.tags[local] = { ...tag };
      lines.push(` * [new tag]         ${local} -> ${local}`);
      events.push({ server, ref: `refs/tags/${local}`, refName: local, refType: "tag", sha: tag.sha });
    } else {
      return fail(`error: src refspec ${local} does not match any\nerror: failed to push some refs to '${url}'`);
    }
  }
  if (tagsAll)
    for (const [t, tag] of Object.entries(repo.tags)) {
      if (server.tags[t]?.sha === tag.sha) continue;
      server.tags[t] = { ...tag };
      newCommits += 1;
      lines.push(` * [new tag]         ${t} -> ${t}`);
      events.push({ server, ref: `refs/tags/${t}`, refName: t, refType: "tag", sha: tag.sha });
    }
  if (!lines.length) return "Everything up-to-date";
  const out = [...(events.length ? objectsLine(newCommits) : []), `To ${url}`, ...lines, ...(upstreamMsg ? [upstreamMsg] : []), ...errors].join("\n");
  for (const ev of events) for (const h of pushHooks) h(sh, ev);
  return errors.length ? fail(out) : { output: out, ok: true };
};

const remoteCmd = (sh: Shell, repo: Repo, args: string[]): Out => {
  const [sub, name, url] = args.filter((a) => a !== "-v" && a !== "--verbose");
  if (!sub) {
    if (args.includes("-v") || args.includes("--verbose"))
      return Object.entries(repo.remotes).map(([n, u]) => `${n}\t${u} (fetch)\n${n}\t${u} (push)`).join("\n");
    return Object.keys(repo.remotes).join("\n");
  }
  switch (sub) {
    case "add":
      if (!name || !url) return fail("usage: git remote add [<options>] <name> <url>");
      if (repo.remotes[name]) return fail(`error: remote ${name} already exists.`);
      repo.remotes[name] = url;
      return "";
    case "remove":
    case "rm":
      if (!repo.remotes[name]) return fail(`error: No such remote: '${name}'`);
      delete repo.remotes[name];
      for (const k of Object.keys(repo.tracking)) if (k.startsWith(name + "/")) delete repo.tracking[k];
      return "";
    case "set-url":
      if (!repo.remotes[name]) return fail(`error: No such remote '${name}'`);
      repo.remotes[name] = url;
      return "";
    case "get-url":
      return repo.remotes[name] ?? fail(`error: No such remote '${name}'`);
    case "show":
      return repo.remotes[name] ? `* remote ${name}\n  Fetch URL: ${repo.remotes[name]}\n  Push  URL: ${repo.remotes[name]}\n  HEAD branch: main` : fail(`fatal: '${name}' does not appear to be a git repository`);
    default:
      return fail(`error: unknown subcommand: \`${sub}'\nusage: git remote [-v | --verbose]\n   or: git remote add <name> <url>`);
  }
};

const tag = (sh: Shell, repo: Repo, args: string[]): Out => {
  let annotated = false;
  let msg: string | undefined;
  let del = false;
  const pos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-a" || a === "--annotate") annotated = true;
    else if (a === "-m" || a === "--message") {
      msg = args[++i];
      annotated = true;
    } else if (a === "-am") {
      annotated = true;
      msg = args[++i];
    } else if (a === "-d" || a === "--delete") del = true;
    else if (a === "-l" || a === "--list" || a === "-n") continue;
    else pos.push(a);
  }
  if (del) {
    const t = repo.tags[pos[0]];
    if (!t) return fail(`error: tag '${pos[0]}' not found.`);
    delete repo.tags[pos[0]];
    return `Deleted tag '${pos[0]}' (was ${short(t.sha)})`;
  }
  if (!pos.length || args.includes("-l") || args.includes("--list")) {
    const pat = pos[0] ? new RegExp("^" + pos[0].replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$") : null;
    return Object.keys(repo.tags).filter((t) => !pat || pat.test(t)).sort().map((t) => (args.includes("-n") ? `${t.padEnd(15)} ${repo.tags[t].message ?? commitOf(sh, repo.tags[t].sha)?.message.split("\n")[0] ?? ""}` : t)).join("\n");
  }
  const [name, ref] = pos;
  if (!/^[\w][\w.\-/]*$/.test(name)) return fail(`fatal: '${name}' is not a valid tag name.`);
  if (repo.tags[name]) return fail(`fatal: tag '${name}' already exists`);
  const sha = ref ? resolveRef(sh, repo, ref) : headSha(repo);
  if (!sha) return fail(ref ? `fatal: Failed to resolve '${ref}' as a valid ref.` : "fatal: Failed to resolve 'HEAD' as a valid ref.");
  if (annotated && !msg) return fail("fatal: no tag message?\nhint: use git tag -a <nome> -m \"mensagem\"");
  repo.tags[name] = { name, sha, annotated, message: msg, date: tick(sh) };
  return "";
};

const show = (sh: Shell, repo: Repo, args: string[]): Out => {
  const target = args.filter((a) => !a.startsWith("-"))[0] ?? "HEAD";
  const colon = target.indexOf(":");
  if (colon >= 0) {
    const sha = resolveRef(sh, repo, target.slice(0, colon) || "HEAD");
    const path = target.slice(colon + 1).replace(/^\.\//, "");
    const content = sha ? treeAt(sh, sha)[path] : undefined;
    if (content === undefined) return fail(`fatal: path '${path}' does not exist in '${target.slice(0, colon) || "HEAD"}'`);
    return content;
  }
  const sha = resolveRef(sh, repo, target);
  if (!sha) return fail(`fatal: ambiguous argument '${target}': unknown revision or path not in the working tree.`);
  const c = commitOf(sh, sha)!;
  const out: string[] = [];
  const t = repo.tags[target];
  if (t?.annotated) out.push(`tag ${t.name}`, `Tagger: ${AUTHOR}`, `Date:   ${gitDate(t.date)}`, "", t.message ?? "", "");
  out.push(`commit ${c.sha}${decorations(repo, c.sha)}`, `Author: ${c.author}`, `Date:   ${gitDate(c.date)}`, "", ...c.message.split("\n").map((l) => `    ${l}`), "");
  if (!args.includes("--stat") && !args.includes("--no-patch") && !args.includes("-s")) out.push(unifiedDiff(treeAt(sh, c.parents[0]), c.tree));
  else if (args.includes("--stat")) out.push(stats(treeAt(sh, c.parents[0]), c.tree).summary);
  return out.join("\n").replace(/\n+$/, "");
};

const revert = (sh: Shell, repo: Repo, args: string[]): Out => {
  const ref = args.filter((a) => !a.startsWith("-"))[0];
  if (!ref) return fail("usage: git revert [<options>] <commit-ish>...");
  const sha = resolveRef(sh, repo, ref);
  if (!sha) return fail(`fatal: bad revision '${ref}'`);
  const s = repoStatus(sh, repo);
  if (s.staged.any || s.unstaged.any) return fail("error: your local changes would be overwritten by revert.\nhint: commit your changes or stash them to proceed.\nfatal: revert failed");
  const c = commitOf(sh, sha)!;
  const ours = treeAt(sh, headSha(repo));
  const { tree, conflicts } = merge3(c.tree, ours, treeAt(sh, c.parents[0]), `parent of ${short(sha)}`);
  if (conflicts.length) return fail(`error: could not revert ${short(sha)}... ${c.message}\nhint: after resolving the conflicts, mark the corrected paths`);
  writeTree(sh, repo, ours, tree);
  repo.index = { ...tree };
  const msg = `Revert "${c.message.split("\n")[0]}"\n\nThis reverts commit ${sha}.`;
  const nc = newCommit(sh, repo, msg, tree, [headSha(repo)!]);
  const st = stats(ours, tree);
  return [`[${repo.head} ${short(nc.sha)}] Revert "${c.message.split("\n")[0]}"`, st.summary, ...st.modes].join("\n");
};

const revParse = (sh: Shell, repo: Repo, args: string[]): Out => {
  const ref = args.filter((a) => !a.startsWith("-"))[0] ?? "HEAD";
  if (args.includes("--show-toplevel")) return repo.root;
  if (args.includes("--abbrev-ref")) return ref === "HEAD" ? repo.head : ref;
  const sha = resolveRef(sh, repo, ref);
  if (!sha) return fail(`fatal: ambiguous argument '${ref}': unknown revision or path not in the working tree.`);
  return args.includes("--short") ? short(sha) : sha;
};

const init = (sh: Shell, args: string[]): Out => {
  let branchName = gitState(sh).config["init.defaultBranch"] ?? "main";
  const pos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-b" || args[i] === "--initial-branch") branchName = args[++i];
    else if (args[i].startsWith("--initial-branch=")) branchName = args[i].split("=")[1];
    else if (!args[i].startsWith("-")) pos.push(args[i]);
  }
  const root = sh.resolve(pos[0] ?? ".");
  const existing = gitState(sh).repos.find((r) => r.root === root);
  if (existing) return `Reinitialized existing Git repository in ${root}/.git/`;
  sh.mkdir(root);
  initRepo(sh, root, branchName);
  return `Initialized empty Git repository in ${root}/.git/`;
};

const clone = (sh: Shell, args: string[]): Out => {
  const [url, dir] = args.filter((a) => !a.startsWith("-"));
  if (!url) return fail("fatal: You must specify a repository to clone.");
  const server = serverOf(sh, url, false);
  const name = dir ?? slugOf(url).split("/").pop()!;
  const root = sh.resolve(name);
  if (sh.isDir(root) && sh.listDir(root).length) return fail(`fatal: destination path '${name}' already exists and is not an empty directory.`);
  if (!server) return fail(`Cloning into '${name}'...\nremote: Repository not found.\nfatal: repository '${url}/' not found`);
  const repo = initRepo(sh, root, server.defaultBranch || "main");
  repo.remotes.origin = url;
  fetchRemote(sh, repo, "origin");
  const sha = server.branches[server.defaultBranch];
  if (sha) {
    repo.branches[repo.head] = sha;
    repo.upstream[repo.head] = "origin";
    repo.index = { ...treeAt(sh, sha) };
    writeTree(sh, repo, {}, repo.index);
  }
  return `Cloning into '${name}'...\nremote: Enumerating objects: 42, done.\nremote: Total 42 (delta 0), reused 0 (delta 0), pack-reused 0\nReceiving objects: 100% (42/42), done.`;
};

const config = (sh: Shell, args: string[]): Out => {
  const pos = args.filter((a) => !a.startsWith("-"));
  const st = gitState(sh);
  if (args.includes("--list") || args.includes("-l"))
    return Object.entries({ "user.name": "Danylo", "user.email": "danylo@lab.local", ...st.config }).map(([k, v]) => `${k}=${v}`).join("\n");
  const [key, value] = pos;
  if (!key) return fail("usage: git config [<options>]");
  if (value === undefined) return st.config[key] ?? ({ "user.name": "Danylo", "user.email": "danylo@lab.local" } as Record<string, string>)[key] ?? { output: "", ok: false };
  st.config[key] = value;
  return "";
};

const SUBCOMMANDS: Record<string, string> = {
  init: "cria um repositório Git vazio no diretório",
  clone: "copia um repositório remoto para um diretório local",
  status: "mostra arquivos novos (untracked), modificados e no stage",
  add: "coloca mudanças no stage (índice) para o próximo commit",
  commit: "grava um snapshot do stage no histórico",
  log: "mostra o histórico de commits",
  diff: "mostra diferenças: working tree × stage (ou --staged: stage × último commit)",
  show: "mostra um commit/tag (metadados + diff) ou um arquivo em uma revisão (ref:caminho)",
  branch: "lista, cria, renomeia (-M) ou apaga (-d) branches",
  checkout: "troca de branch (-b cria) ou restaura arquivos",
  switch: "troca de branch (-c cria uma nova)",
  restore: "descarta mudanças locais (ou --staged: tira do stage)",
  merge: "integra outra branch na branch atual",
  tag: "cria (-a -m anotada), lista ou apaga tags de versão",
  remote: "gerencia remotos (add, -v, remove, set-url)",
  push: "envia commits/tags para o remoto (no GitHub, isso dispara workflows)",
  pull: "busca e integra as mudanças do remoto (--rebase para histórico linear)",
  fetch: "baixa refs do remoto sem alterar sua branch",
  revert: "cria um commit que desfaz outro — seguro para histórico compartilhado",
  "rev-parse": "resolve uma referência para o SHA (--short)",
  config: "lê/grava configurações (user.name, init.defaultBranch…)",
};

registerTool({
  name: "git",
  summary: "controle de versão (init, add, commit, push, branch, tag…)",
  subcommands: SUBCOMMANDS,
  flags: {
    "-m": "mensagem do commit/tag",
    "-a": "commit: inclui arquivos rastreados modificados · tag: cria tag anotada",
    "-A": "add: inclui tudo (novos, modificados e removidos)",
    "-b": "checkout: cria a branch e troca para ela",
    "-c": "switch: cria a branch e troca para ela",
    "-u": "push: grava o upstream (depois basta git push)",
    "--set-upstream": "push: grava o upstream (depois basta git push)",
    "--tags": "push: envia todas as tags locais",
    "--oneline": "log: um commit por linha",
    "-n": "log: limita a quantidade de commits",
    "--staged": "diff: compara o stage com o último commit",
    "--cached": "diff: sinônimo de --staged",
    "-v": "remote: mostra as URLs",
    "--rebase": "pull: reaplica seus commits sobre os do remoto",
    "--amend": "commit: reescreve o último commit",
    "-d": "branch/tag: apaga",
    "-M": "branch: renomeia a branch atual (ex.: git branch -M main)",
  },
  valueFlags: ["-m", "-b", "-c", "-n", "-C"],
  run: ({ sh, args }) => {
    const [sub, ...rest] = args;
    if (!sub || sub === "help" || sub === "--help")
      return `usage: git <command> [<args>]\n\nThese are common Git commands:\n${Object.keys(SUBCOMMANDS).map((s) => `   ${s.padEnd(11)}`).join("\n")}`;
    if (sub === "--version" || sub === "version") return "git version 2.43.0";
    if (sub === "init") return init(sh, rest);
    if (sub === "clone") return clone(sh, rest);
    if (sub === "config") return config(sh, rest);
    if (!SUBCOMMANDS[sub]) {
      const sug = closest(sub, Object.keys(SUBCOMMANDS));
      return fail(`git: '${sub}' is not a git command. See 'git --help'.${sug ? `\n\nThe most similar command is\n\t${sug}` : ""}`);
    }
    const repo = findRepo(sh);
    if (!repo) return fail(NOT_REPO);
    switch (sub) {
      case "status":
        return status(sh, repo, rest);
      case "add":
        return add(sh, repo, rest);
      case "commit":
        return commit(sh, repo, rest);
      case "log":
        return log(sh, repo, rest);
      case "diff":
        return diff(sh, repo, rest);
      case "show":
        return show(sh, repo, rest);
      case "branch":
        return branch(sh, repo, rest);
      case "checkout":
        return checkout(sh, repo, rest, false);
      case "switch":
        return checkout(sh, repo, rest, true);
      case "restore":
        return restore(sh, repo, rest);
      case "merge":
        return merge(sh, repo, rest);
      case "tag":
        return tag(sh, repo, rest);
      case "remote":
        return remoteCmd(sh, repo, rest);
      case "push":
        return push(sh, repo, rest);
      case "pull":
        return pull(sh, repo, rest);
      case "fetch":
        return fetch(sh, repo, rest);
      case "revert":
        return revert(sh, repo, rest);
      case "rev-parse":
        return revParse(sh, repo, rest);
      default:
        return fail(`git: '${sub}' is not a git command. See 'git --help'.`);
    }
  },
  explainError: (cmd, output) => {
    if (/not a git repository/.test(output))
      return "Este diretório não é um repositório Git (não há .git aqui nem nos diretórios acima). Rode git init para criar um, ou entre com cd no diretório do projeto.";
    if (/is not a git command/.test(output)) {
      const m = /most similar command is\s+(\S+)/.exec(output);
      return `Esse subcomando não existe no Git.${m ? ` Você quis dizer git ${m[1]}?` : " Veja git --help."}`;
    }
    if (/nothing added to commit but untracked files present/.test(output))
      return "Nada foi para o stage. O Git só grava no commit o que você adicionou com git add — arquivos novos aparecem como untracked até isso. Rode git add <arquivo> (ou git add .) e depois o commit.";
    if (/no changes added to commit/.test(output))
      return "Há arquivos modificados, mas nenhum no stage. Use git add <arquivo> antes do commit, ou git commit -am \"msg\" para incluir de uma vez todos os arquivos já rastreados.";
    if (/nothing to commit/.test(output)) return "Não há nada novo para gravar: o working tree está igual ao último commit. Edite algum arquivo antes (ou confira com git status).";
    if (/pathspec '([^']+)' did not match/.test(output))
      return `O Git não encontrou "${/pathspec '([^']+)'/.exec(output)![1]}". Confira o caminho com ls (lembre que ele é relativo ao diretório atual) ou, para branches, liste com git branch -a.`;
    if (/\[rejected\].*fetch first/.test(output))
      return "O push foi rejeitado porque o remoto tem commits que você ainda não tem (alguém enviou antes). Integre primeiro com git pull --rebase e depois repita o git push. Evite --force em branches compartilhadas.";
    if (/\[rejected\].*already exists/.test(output)) return "Essa tag já existe no remoto. Tags de release devem ser imutáveis: crie uma nova versão (ex.: v1.0.1) em vez de sobrescrever.";
    if (/No configured push destination/.test(output)) return "O repositório ainda não tem remoto. Cadastre-o com git remote add origin <url> e depois faça o push.";
    if (/has no upstream branch/.test(output))
      return "A branch local ainda não está ligada a uma branch remota. Na primeira vez use git push -u origin <branch>; o -u grava o upstream e depois basta git push.";
    if (/src refspec (\S+) does not match any/.test(output))
      return "Não existe nada local com esse nome para enviar. Normalmente é porque ainda não há nenhum commit (faça git add + git commit) ou o nome da branch/tag está errado (veja git branch e git tag).";
    if (/does not appear to be a git repository/.test(output)) return "Esse remoto não existe. Veja os remotos cadastrados com git remote -v.";
    if (/remote \S+ already exists/.test(output)) return "Já existe um remoto com esse nome. Veja com git remote -v, ou troque a URL com git remote set-url origin <url>.";
    if (/would be overwritten by/.test(output)) return "Você tem mudanças locais não commitadas que seriam perdidas. Faça commit (ou descarte com git restore <arquivo>) antes de trocar de branch/merge.";
    if (/Merge conflict/.test(output)) return "Conflito: as duas branches mudaram as mesmas linhas. Edite o arquivo, escolha o conteúdo certo entre <<<<<<< e >>>>>>>, depois git add <arquivo> e git commit.";
    if (/tag '([^']+)' already exists/.test(output)) return "Essa tag já existe localmente. Liste com git tag; se quiser recriá-la, apague antes com git tag -d <tag> (e nunca reescreva uma tag já publicada).";
    if (/no tag message/.test(output)) return "Tag anotada (-a) precisa de mensagem: git tag -a v1.0.0 -m \"Release 1.0.0\".";
    if (/empty commit message/.test(output)) return "Todo commit precisa de mensagem. Use git commit -m \"descrição curta do que mudou\".";
    if (/does not have any commits yet/.test(output)) return "A branch ainda não tem commits. Adicione arquivos com git add e crie o primeiro commit.";
    if (/unknown revision|bad revision|not something we can merge/.test(output)) return "Essa referência (branch, tag ou SHA) não existe. Liste as opções com git log --oneline, git branch -a ou git tag.";
    if (/Could not resolve host/.test(output)) return "O remoto não resolve. Neste lab o GitHub simulado aceita URLs no formato https://github.com/<usuario>/<repo>.git.";
    void cmd;
    return null;
  },
});

/** Runs git commands during a lab seed without leaving traces in the learner's history. */
export const seedGit = (sh: Shell, cmds: string[]) => {
  for (const c of cmds) {
    const before = sh.entries.length;
    sh.exec(c);
    const e = sh.entries[before];
    if (e && !e.ok) throw new Error(`seed command failed: ${c}\n${e.output}`);
  }
  sh.log.length = 0;
  sh.entries.length = 0;
};
