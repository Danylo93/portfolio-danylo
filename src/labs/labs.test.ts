import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LABS } from "./data";
import { Shell } from "./shell";

// Commands that solve each lab. Placeholders are resolved against the live shell state.
const SOLUTIONS: Record<string, ((sh: Shell) => string)[][]> = {
  "k8s-cluster-explore": [[() => "kubectl config current-context"], [() => "kubectl cluster-info"], [() => "kubectl get ns"]],
  "k8s-check-status": [[() => "kubectl get nodes -o wide"], [() => "kubectl describe node lab-worker"], [() => "kubectl version"]],
  "k8s-first-pod": [[() => "kubectl run nginx --image=nginx:1.25"], [() => "kubectl get pods"], [() => "kubectl logs nginx"]],
  "k8s-deploy": [
    [() => "kubectl create deployment web --image=nginx:1.25"],
    [() => "kubectl scale deployment web --replicas=3"],
    [(sh) => `kubectl delete pod ${sh.state.pods[0].name}`, () => "kubectl get deployment web"],
  ],
  "k8s-expose": [
    [() => "kubectl expose deployment web --port=80 --type=NodePort"],
    [() => "kubectl describe svc web"],
    [(sh) => `curl localhost:${sh.state.services[0].nodePort}`],
  ],
  "k8s-troubleshoot-nginx": [
    [() => "kubectl get pods"],
    [(sh) => `kubectl describe pod ${sh.state.pods[0].name}`],
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
