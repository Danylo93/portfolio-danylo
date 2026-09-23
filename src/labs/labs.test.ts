import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LABS } from "./data";
import { Shell } from "./shell";
import { diagnose, explainCommand, react } from "./coach";
import { podName } from "./test-utils";

// Commands that solve each lab. Placeholders are resolved against the live shell state.
const SOLUTIONS: Record<string, ((sh: Shell) => string)[][]> = {
  "k8s-cluster-explore": [[() => "kubectl config current-context"], [() => "kubectl cluster-info"], [() => "kubectl get ns"]],
  "k8s-check-status": [[() => "kubectl get nodes -o wide"], [() => "kubectl describe node lab-worker"], [() => "kubectl version"]],
  "k8s-first-pod": [[() => "kubectl run nginx --image=nginx:1.25"], [() => "kubectl get pods"], [() => "kubectl logs nginx"]],
  "k8s-deploy": [
    [() => "kubectl create deployment web --image=nginx:1.25"],
    [() => "kubectl scale deployment web --replicas=3"],
    [(sh) => `kubectl delete pod ${podName(sh, "web-")}`, () => "kubectl get deployment web"],
  ],
  "k8s-expose": [
    [() => "kubectl expose deployment web --port=80 --type=NodePort"],
    [() => "kubectl describe svc web"],
    [(sh) => `curl localhost:${sh.state.services.find((x) => x.name === "web")!.nodePort}`],
  ],
  "k8s-troubleshoot-nginx": [
    [() => "kubectl get pods"],
    [(sh) => `kubectl describe pod ${podName(sh, "nginx-")}`],
    [() => "kubectl set image deployment/nginx nginx=nginx:1.25"],
    [() => "kubectl rollout status deployment/nginx"],
  ],
  "k8s-rollout": [
    [() => "kubectl set image deployment/api api=nginx:1.25"],
    [() => "kubectl rollout history deployment/api"],
    [() => "kubectl rollout undo deployment/api"],
  ],
  "docker-basics": [
    [() => "docker pull nginx:alpine"],
    [() => "docker run -d -p 8080:80 --name web nginx:alpine"],
    [() => "curl localhost:8080", () => "docker ps"],
  ],
  "terraform-eks": [[() => "terraform init"], [() => "terraform plan"], [() => "terraform apply -auto-approve"], [() => "terraform state list"]],
};

describe("labs", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it.each(LABS.map((l) => [l.id, l] as const))("%s is solvable", (_, lab) => {
    const sh = new Shell(lab.seed);
    const sol = SOLUTIONS[lab.id];
    expect(sol, `missing solution for ${lab.id}`).toHaveLength(lab.steps.length);
    lab.steps.forEach((step, i) => {
      expect(step.check(sh), `step ${i + 1} passes before running anything`).toBe(false);
      for (const cmd of sol[i]) {
        sh.exec(cmd(sh));
        vi.advanceTimersByTime(5000);
      }
      expect(step.check(sh), `step ${i + 1}: ${step.title}`).toBe(true);
    });
  });

  it("troubleshoot seed starts broken", () => {
    const lab = LABS.find((l) => l.id === "k8s-troubleshoot-nginx")!;
    const sh = new Shell(lab.seed);
    expect(sh.exec("kubectl get pods").output).toContain("ImagePullBackOff");
  });

  it("unknown commands fail and are not logged", () => {
    const sh = new Shell();
    expect(sh.exec("foo").output).toContain("command not found");
    expect(sh.log).toHaveLength(0);
  });
});

describe("coach", () => {
  const stepOf = (labId: string, i: number) => LABS.find((l) => l.id === labId)!.steps[i];

  it("every step has hints ending in a solution and an explanation", () => {
    for (const lab of LABS)
      for (const s of lab.steps) {
        expect(s.hints.length, `${lab.id}/${s.title}`).toBeGreaterThanOrEqual(2);
        expect(s.explain.length, `${lab.id}/${s.title}`).toBeGreaterThan(0);
      }
  });

  it("suggests the right command for typos", () => {
    const sh = new Shell();
    sh.exec("kubeclt get nodes");
    expect(diagnose(stepOf("k8s-check-status", 0), sh, 0)).toContain('"kubectl"');
    sh.exec("kubectl get nods");
    expect(diagnose(stepOf("k8s-check-status", 0), sh, 0)).toContain('"nodes"');
    sh.exec("kubectl gte nodes");
    expect(diagnose(stepOf("k8s-check-status", 0), sh, 0)).toContain('"get"');
  });

  it("explains unreplaced placeholders and wrong verbs", () => {
    const lab = LABS.find((l) => l.id === "k8s-troubleshoot-nginx")!;
    const sh = new Shell(lab.seed);
    sh.exec("kubectl describe pod <nome-do-pod>");
    expect(diagnose(lab.steps[1], sh, 0)).toContain("placeholder");
    const sh2 = new Shell();
    sh2.exec("kubectl describe nodes");
    expect(diagnose(stepOf("k8s-check-status", 0), sh2, 0)).toContain('"get"');
  });

  it("tells when nothing was run and gives step-specific reasons", () => {
    const sh = new Shell();
    expect(diagnose(stepOf("k8s-first-pod", 0), sh, 0)).toContain("ainda não executou");
    sh.exec("kubectl run meupod --image=nginx:1.25");
    expect(diagnose(stepOf("k8s-first-pod", 0), sh, 0)).toContain('"meupod"');
  });

  it("reacts live: success, error and observation", () => {
    const lab = LABS.find((l) => l.id === "k8s-troubleshoot-nginx")!;
    const sh = new Shell(lab.seed);
    sh.exec("kubectl get pods");
    expect(react(sh.entries.at(-1)!, lab.steps[0], sh)?.tone).toBe("success");
    sh.exec("kubectl describe pod nope");
    expect(react(sh.entries.at(-1)!, lab.steps[1], sh)?.tone).toBe("error");
    sh.exec("kubectl get pods");
    expect(react(sh.entries.at(-1)!, lab.steps[2], sh)?.text).toContain("ImagePullBackOff");
  });

  it("explains each part of a command", () => {
    const parts = explainCommand("kubectl expose deployment web --port=80 --type=NodePort");
    expect(parts.map((p) => p.part)).toEqual(["kubectl", "expose", "deployment", "web", "--port=80", "--type=NodePort"]);
    expect(parts.find((p) => p.part === "--type=NodePort")?.desc).toContain("30000");
  });
});
