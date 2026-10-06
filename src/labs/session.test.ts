import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LABS } from "./data";
import { Shell } from "./shell";
import { clearLabSession, labSessionKey, loadLabSession, restoredShell, saveLabSession, terminalKey, type LabSessionData } from "./session";
import { ansibleState } from "./tools/ansible";
import { awsState } from "./tools/aws";
import { tfExt } from "./tools/terraform-engine";

const data = (lab: typeof LABS[number], sh: Shell): LabSessionData => ({
  version: 1, labId: lab.id, stepCount: lab.steps.length, step: 0, passed: [], elapsed: 12,
  hintLevel: 1, stats: { hints: 1, misses: 2 }, shell: sh.snapshot(),
});

beforeEach(() => { localStorage.clear(); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("persistência de todas as trilhas", () => {
  it.each(LABS.map((lab) => [lab.id, lab] as const))("%s preserva o ambiente e os critérios de validação", (_, lab) => {
    const sh = new Shell(lab.seed);
    const checks = lab.steps.map((step) => step.check(sh));
    expect(saveLabSession(data(lab, sh))).toBe(true);
    const saved = loadLabSession(lab);
    expect(saved).not.toBeNull();
    const resumed = restoredShell(lab, saved);
    expect(resumed.state).toEqual(sh.state);
    expect(lab.steps.map((step) => step.check(resumed))).toEqual(checks);
    expect(resumed.exec("pwd").output).toBe(sh.cwd);
  });
  it("preserva IDs de Kubernetes sem executar novamente comandos", () => {
    const lab = LABS.find((l) => l.id === "k8s-deploy")!;
    const sh = new Shell(lab.seed);
    sh.exec("kubectl create deployment web --image=nginx:1.25");
    sh.exec("kubectl scale deployment web --replicas=3");
    vi.advanceTimersByTime(5000);
    saveLabSession(data(lab, sh));
    const resumed = restoredShell(lab, loadLabSession(lab));
    expect(resumed.state.pods.map((p) => p.name)).toEqual(sh.state.pods.map((p) => p.name));
    expect(resumed.entries).toEqual(sh.entries);
    expect(lab.steps[1].check(resumed)).toBe(true);
  });
  it("restaura collections, diretórios, AWS e estado remoto do Terraform", () => {
    const lab = LABS.find((l) => l.id === "serverless-lambda")!;
    const sh = new Shell(lab.seed);
    sh.exec("mkdir -p /tmp/nested");
    sh.exec("cd /tmp/nested");
    sh.exec("export TEST_VALUE=saved");
    sh.exec("alias ll='ls'");
    ansibleState(sh).pings.add("web1");
    sh.ext("collections", () => new Map([["one", new Set(["value"])]]));
    awsState(sh).memory = 256;
    tfExt(sh).cloud.objects["aws_vpc|vpc-test"] = { id: "vpc-test" };
    saveLabSession(data(lab, sh));
    const resumed = restoredShell(lab, loadLabSession(lab));
    expect(resumed.isDir("/tmp/nested")).toBe(true);
    expect(resumed.cwd).toBe("/tmp/nested");
    expect(resumed.env.TEST_VALUE).toBe("saved");
    expect(resumed.aliases.ll).toBe("ls");
    expect(ansibleState(resumed).pings.has("web1")).toBe(true);
    expect(resumed.ext<Map<string, Set<string>>>("collections", () => new Map()).get("one")!.has("value")).toBe(true);
    expect(awsState(resumed).memory).toBe(256);
    expect(tfExt(resumed).cloud.objects["aws_vpc|vpc-test"]).toEqual({ id: "vpc-test" });
  });
  it("reconstrói o callback de kubectl edit sem duplicar o histórico", () => {
    const sh = new Shell();
    sh.exec("kubectl create deployment web --image=nginx:1.25");
    const edit = sh.exec("kubectl edit deployment web").edit!;
    const entries = [...sh.entries];
    const reopened = sh.reopenEditor("kubectl edit deployment web", edit.path)!;
    expect(reopened.path).toBe(edit.path);
    expect(sh.entries).toEqual(entries);
    sh.saveEdit(edit.path, edit.content.replace("replicas: 1", "replicas: 3"));
    expect(sh.state.deployments.find((d) => d.name === "web")!.replicas).toBe(3);
    expect(sh.reopenEditor("kubectl delete deployment web")).toBeUndefined();
    expect(sh.state.deployments.some((d) => d.name === "web")).toBe(true);
  });
  it("ignora dados inválidos e reinicia somente a tentativa escolhida", () => {
    const [first, second] = LABS;
    localStorage.setItem(labSessionKey(first.id), '{"version":1}');
    expect(loadLabSession(first)).toBeNull();
    saveLabSession(data(second, new Shell(second.seed)));
    localStorage.setItem(terminalKey(first.id), "{}");
    expect(clearLabSession(first.id)).toBe(true);
    expect(localStorage.getItem(terminalKey(first.id))).toBeNull();
    expect(loadLabSession(second)).not.toBeNull();
  });
  it("não interrompe o lab quando o armazenamento está bloqueado ou cheio", () => {
    const lab = LABS[0];
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    expect(saveLabSession(data(lab, new Shell(lab.seed)))).toBe(false);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    expect(loadLabSession(lab)).toBeNull();
    expect(restoredShell(lab, null).exec("pwd").output).toContain("/home/danylo");
  });
});
