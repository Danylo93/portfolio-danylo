import { describe, expect, it } from "vitest";
import { commandArgs } from "../../../server/real-labs";
import { labs } from "../tracks/kubernetes";
import { REAL_LABS } from "./catalog";

describe("real cluster command boundary", () => {
  it.each([
    "kubectl get pods -o wide", "k describe pod nginx", "kubectl config current-context",
    "kubectl create deployment web --image=nginx:1.25", "kubectl scale deployment/web --replicas=3",
    "kubectl set image deployment/api api=nginx:1.25", "kubectl rollout undo deployment/api",
    "kubectl expose deployment web --port=80 --type=NodePort", "kubectl delete pod web-abc",
    "kubectl run probe --image=busybox:1.37 --restart=Never -- wget -qO- http://web",
  ])("accepts supported command: %s", (command) => expect(commandArgs(command).length).toBeGreaterThan(0));

  it.each([
    "kubectl --context production get pods", "kubectl get pods -n kube-system",
    "kubectl get pods --namespace=kube-system", "kubectl get pods -A", "kubectl get --raw /api",
    "kubectl get pods --kubeconfig=/tmp/other", "kubectl get pods --server=https://other",
    "kubectl delete namespace default", "kubectl delete nodes --all", "kubectl config use-context production",
    "kubectl apply -f /etc/passwd", "kubectl create -f https://example.com/evil.yaml",
    "kubectl run evil --image=nginx --overrides={}", "kubectl run evil --image=nginx --privileged",
    "kubectl exec nginx -- cat /etc/passwd", "kubectl get pods; touch /tmp/evil",
    "kubectl get pods && docker ps", "kubectl get pods | bash", "kubectl get pods > /tmp/pods",
    "kubectl logs $(whoami)", "kubectl proxy", "kubectl port-forward service/web 80:80",
    "bash -c id", "docker run -v /:/host alpine", "kubectl scale deployment/web --replicas=999",
  ])("rejects escape or unsupported operation: %s", (command) => expect(() => commandArgs(command)).toThrow());

  it("covers every fundamentals lab with the correct step count", () => {
    expect(Object.keys(REAL_LABS).sort()).toEqual(labs.map((l) => l.id).sort());
    for (const lab of labs) expect(REAL_LABS[lab.id as keyof typeof REAL_LABS]).toBe(lab.steps.length);
  });
});
