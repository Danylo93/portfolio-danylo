import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findDeployment } from "../k8s/cluster";
import { Shell } from "../shell";
import { expectLessonWellFormed, expectSolvable, expectWellFormed, type Solution } from "../test-utils";
import { argoApp, appStatus } from "../tools/argocd";
import { ghState, latestRun } from "../tools/gh";
import { findRepo } from "../tools/git";
import { PROJECT } from "../util";
import { BROKEN_CI_YML, CI_YML, REPO_URL, deploymentYaml, labs, lessons } from "./cicd";

const CI = `${PROJECT}/.github/workflows/ci.yml`;
const edit = (path: string, fn: (s: string) => string) => (sh: Shell) => void sh.saveEdit(path, fn(sh.readFile(path) ?? ""));

const SOLUTIONS: Record<string, Solution> = {
  "cicd-first-pipeline": [
    [() => "git init"],
    [(sh) => void sh.saveEdit(CI, CI_YML)],
    [() => "git add .", () => 'git commit -m "ci: pipeline de testes"'],
    [() => `git remote add origin ${REPO_URL}`, () => "git push -u origin main"],
    [() => "gh run watch"],
  ],
  "cicd-broken-pipeline": [
    [() => "gh run list"],
    [() => "gh run view --log-failed"],
    [edit(CI, (s) => s.replace("    steps:\n", "    steps:\n      - uses: actions/checkout@v4\n")), () => 'git commit -am "ci: adiciona checkout"', () => "git push"],
    [() => "gh run view --log-failed"],
    [edit(CI, (s) => s.replace("node-version: 16", "node-version: 20")), () => 'git commit -am "ci: usa Node 20"', () => "git push"],
  ],
  "cicd-release-image": [
    [() => 'git tag -a v1.0.0 -m "Release 1.0.0"'],
    [() => "git push origin v1.0.0"],
    [() => "gh run view --log-failed"],
    [() => "gh secret set AWS_ROLE_ARN --body arn:aws:iam::123456789012:role/gha-ecr-push"],
    [() => "gh run rerun"],
  ],
  "cicd-argocd-gitops": [
    [() => "argocd login argocd.lab.local --username admin --password lab-admin --insecure"],
    [() => `argocd app create webapp --repo ${REPO_URL} --path k8s --dest-server https://kubernetes.default.svc --dest-namespace default`],
    [() => "argocd app sync webapp"],
    [(sh) => void sh.saveEdit(`${PROJECT}/k8s/deployment.yaml`, deploymentYaml("1.1.0")), () => 'git commit -am "deploy: webapp 1.1.0"', () => "git push", () => "argocd app sync webapp"],
    [() => "argocd app history webapp"],
  ],
  "cicd-argocd-drift": [
    [() => "argocd app get webapp"],
    [() => "argocd app diff webapp"],
    [() => "argocd app set webapp --self-heal"],
    [() => "kubectl scale deployment webapp --replicas=5", () => "kubectl get deployment webapp"],
    [() => "argocd app set webapp --sync-policy none", () => "argocd app rollback webapp 0"],
  ],
};

describe("cicd labs", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it.each(labs.map((l) => [l.id, l] as const))("%s", (_, lab) => {
    expectWellFormed(lab);
    expectSolvable(lab, SOLUTIONS[lab.id]);
  });

  it.each(lessons.map((l) => [l.id, l] as const))("lesson %s", (_, lesson) => {
    expectLessonWellFormed(lesson);
    expect(labs.some((l) => l.id === lesson.before), `${lesson.id}.before`).toBe(true);
  });
});

const APP = {
  "package.json": JSON.stringify({ name: "app", version: "1.0.0", scripts: { test: "jest" }, devDependencies: { jest: "^29" } }),
  "package-lock.json": "{}",
  "src/sum.js": "const sum = (a, b) => a + b;\nmodule.exports = { sum };\n",
  "src/sum.test.js": 'test("sum", () => {\n  expect(sum(1, 2)).toBe(3);\n});\n',
};
const publish = (sh: Shell) => {
  for (const c of ["git init", "git add .", 'git commit -m "init"', `git remote add origin ${REPO_URL}`]) sh.exec(c);
  return sh.exec("git push -u origin main");
};

describe("git engine", () => {
  it("status tracks untracked, staged and modified files", () => {
    const sh = new Shell({ files: { "a.txt": "1\n" } });
    expect(sh.exec("git status").output).toContain("not a git repository");
    sh.exec("git init");
    expect(sh.exec("git status").output).toMatch(/Untracked files:[\s\S]*a\.txt/);
    expect(sh.exec('git commit -m "x"').output).toContain("nothing added to commit but untracked files present");
    sh.exec("git add a.txt");
    expect(sh.exec("git status").output).toMatch(/Changes to be committed:[\s\S]*new file:\s+a\.txt/);
    expect(sh.exec('git commit -m "first"').output).toMatch(/\[main \(root-commit\) [0-9a-f]{7}\] first/);
    sh.writeFile("a.txt", "2\n");
    const st = sh.exec("git status").output;
    expect(st).toMatch(/Changes not staged for commit:[\s\S]*modified:\s+a\.txt/);
    expect(sh.exec("git diff").output).toContain("-1\n+2");
    sh.exec("git add .");
    expect(sh.exec("git diff --staged").output).toContain("+2");
    sh.exec('git commit -m "second"');
    expect(sh.exec("git status").output).toContain("nothing to commit, working tree clean");
    expect(sh.exec("git log --oneline").output.split("\n")).toHaveLength(2);
    expect(sh.exec("git add nope.txt").output).toContain("pathspec 'nope.txt' did not match any files");
  });

  it("branches, merges and rejects non-fast-forward pushes", () => {
    const sh = new Shell({ files: APP });
    publish(sh);
    sh.exec("git checkout -b feature");
    sh.writeFile("new.txt", "x");
    sh.exec("git add . && git commit -m feat");
    sh.exec("git checkout main");
    expect(sh.readFile("new.txt")).toBeUndefined();
    expect(sh.exec("git merge feature").output).toContain("Fast-forward");
    expect(sh.readFile("new.txt")).toBe("x");
    // someone else pushes: clone elsewhere and push
    sh.exec(`cd /tmp && git clone ${REPO_URL} other`);
    sh.exec("cd /tmp/other");
    sh.writeFile("/tmp/other/remote.txt", "r");
    sh.exec('git add . && git commit -m "remote change" && git push');
    sh.exec(`cd ${PROJECT}`);
    const r = sh.exec("git push");
    expect(r.output).toContain("[rejected]");
    expect(sh.exec("git pull --rebase").output).toContain("Successfully rebased");
    expect(sh.exec("git push").output).toContain("main -> main");
  });
});

describe("github actions engine", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("fails npm ci when checkout is missing", () => {
    const sh = new Shell({ files: { ...APP, ".github/workflows/ci.yml": BROKEN_CI_YML.replace("node-version: 16", "node-version: 20") } });
    publish(sh);
    const run = latestRun(sh)!;
    expect(run.conclusion).toBe("failure");
    vi.advanceTimersByTime(5000);
    expect(sh.exec("gh run view --log-failed").output).toContain("Could not read package.json");
  });

  it("passes a good pipeline and fails a broken assertion", () => {
    const sh = new Shell({ files: { ...APP, ".github/workflows/ci.yml": CI_YML } });
    publish(sh);
    expect(latestRun(sh)!.conclusion).toBe("success");
    sh.writeFile("src/sum.test.js", 'test("sum", () => {\n  expect(sum(1, 2)).toBe(4);\n});\n');
    sh.exec('git commit -am "break" && git push');
    const r = latestRun(sh)!;
    expect(r.conclusion).toBe("failure");
    vi.advanceTimersByTime(5000);
    expect(sh.exec(`gh run view ${r.id} --log-failed`).output).toMatch(/Expected: 4[\s\S]*Received: 3/);
  });

  it("reports invalid YAML with the line number", () => {
    const sh = new Shell({ files: { ...APP, ".github/workflows/ci.yml": "on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n   steps: [\n" } });
    publish(sh);
    const r = latestRun(sh)!;
    expect(r.conclusion).toBe("failure");
    expect(r.invalid).toMatch(/#L\d+/);
  });

  it("does not trigger branch-only workflows on tags and supports workflow_dispatch errors", () => {
    const sh = new Shell({ files: { ...APP, ".github/workflows/ci.yml": CI_YML } });
    publish(sh);
    const n = ghState(sh).runs.length;
    sh.exec("git tag v1 && git push origin v1");
    expect(ghState(sh).runs.length).toBe(n);
    expect(sh.exec("gh workflow run CI").output).toContain("workflow_dispatch");
  });
});

describe("argocd engine", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const setup = () => {
    const sh = new Shell({ files: { "k8s/deployment.yaml": deploymentYaml("1.0.0") } });
    publish(sh);
    sh.exec("argocd login localhost:8080 --username admin --password x --insecure");
    return sh;
  };

  it("sync applies manifests and updates the deployment image after a push", () => {
    const sh = setup();
    expect(sh.exec("argocd app list").output).not.toContain("webapp");
    expect(sh.exec(`argocd app create webapp --repo ${REPO_URL} --path manifests --dest-server https://kubernetes.default.svc --dest-namespace default`).output).toContain("app path does not exist");
    sh.exec(`argocd app create webapp --repo ${REPO_URL} --path k8s --dest-server https://kubernetes.default.svc --dest-namespace default`);
    expect(sh.exec("argocd app get webapp").output).toContain("OutOfSync");
    sh.exec("argocd app sync webapp");
    expect(findDeployment(sh, "webapp")?.image).toBe("ghcr.io/danylo/webapp:1.0.0");
    vi.advanceTimersByTime(5000);
    expect(sh.exec("argocd app get webapp").output).toMatch(/Health Status:\s+Healthy/);
    sh.writeFile("k8s/deployment.yaml", deploymentYaml("2.0.0"));
    sh.exec('git commit -am bump && git push');
    expect(appStatus(sh, argoApp(sh, "webapp")!).sync).toBe("OutOfSync");
    sh.exec("argocd app sync webapp");
    expect(findDeployment(sh, "webapp")?.image).toBe("ghcr.io/danylo/webapp:2.0.0");
    expect(argoApp(sh, "webapp")!.history).toHaveLength(2);
  });

  it("automated sync follows pushes and self-heal reverts kubectl drift", () => {
    const sh = setup();
    sh.exec(`argocd app create webapp --repo ${REPO_URL} --path k8s --dest-server https://kubernetes.default.svc --dest-namespace default --sync-policy automated --self-heal`);
    expect(findDeployment(sh, "webapp")?.replicas).toBe(2);
    sh.exec("kubectl scale deployment webapp --replicas=7");
    expect(findDeployment(sh, "webapp")?.replicas).toBe(7);
    sh.exec("kubectl get deploy webapp");
    expect(findDeployment(sh, "webapp")?.replicas).toBe(2);
    expect(sh.exec("argocd app rollback webapp 0").output).toContain("auto-sync is enabled");
  });

  it("requires login", () => {
    const sh = new Shell();
    expect(sh.exec("argocd app list").output).toContain("server address unspecified");
    expect(findRepo(sh)).toBeUndefined();
  });
});
