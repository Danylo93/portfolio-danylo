import { afterEach, beforeEach, describe, it, vi } from "vitest";
import YAML from "yaml";
import { labs, SIDECAR_FULL } from "./ckad";
import { Shell } from "../shell";
import { expectSolvable, expectWellFormed, podName, type Solution } from "../test-utils";

const edit = (sh: Shell, cmd: string, change: (doc: Record<string, any>) => void) => { // eslint-disable-line @typescript-eslint/no-explicit-any
  const r = sh.exec(cmd);
  if (!r.edit) throw new Error(`${cmd} did not open the editor: ${r.output}`);
  const doc = YAML.parse(r.edit.content);
  change(doc);
  sh.saveEdit(r.edit.path, YAML.stringify(doc));
};

const SOLUTIONS: Record<string, Solution> = {
  "ckad-config-secrets": [
    [() => "kubectl create configmap app-config --from-literal=APP_ENV=production --from-literal=LOG_LEVEL=info"],
    [() => "kubectl create secret generic db-secret --from-literal=DB_PASSWORD=S3nhaF0rte"],
    [() => "kubectl run webapp --image=nginx:1.25 --dry-run=client -o yaml > webapp.yaml"],
    [
      (sh) => {
        const doc = YAML.parse(sh.readFile("webapp.yaml")!);
        Object.assign(doc.spec.containers[0], {
          envFrom: [{ configMapRef: { name: "app-config" } }],
          env: [{ name: "DB_PASSWORD", valueFrom: { secretKeyRef: { name: "db-secret", key: "DB_PASSWORD" } } }],
        });
        sh.saveEdit(sh.resolve("webapp.yaml"), YAML.stringify(doc));
      },
      () => "kubectl apply -f webapp.yaml",
    ],
    [() => "kubectl exec webapp -- env"],
  ],
  "ckad-multicontainer": [
    [() => "kubectl apply -f app.yaml"],
    [() => "kubectl logs app"],
    [(sh) => void sh.saveEdit(sh.resolve("app.yaml"), SIDECAR_FULL), () => "kubectl replace --force -f app.yaml"],
    [() => "kubectl logs app -c log-agent"],
  ],
  "ckad-probes-resources": [
    [() => "kubectl get pods -l app=shop"],
    [(sh) => `kubectl describe pod ${podName(sh, "shop-")}`],
    [(sh) => edit(sh, "kubectl edit deployment shop", (d) => (d.spec.template.spec.containers[0].readinessProbe.httpGet.path = "/"))],
    [() => "kubectl set resources deployment shop --requests=cpu=100m,memory=128Mi --limits=cpu=250m,memory=256Mi"],
    [(sh) => edit(sh, "kubectl edit deployment shop", (d) => (d.spec.template.spec.containers[0].livenessProbe = { tcpSocket: { port: 80 }, initialDelaySeconds: 10 }))],
  ],
  "ckad-jobs-cronjobs": [
    [() => 'kubectl create job pi --image=busybox:1.36 -- sh -c "echo 3.14159"'],
    [() => "kubectl logs job/pi"],
    [() => 'kubectl create cronjob backup --image=busybox:1.36 --schedule="*/5 * * * *" -- sh -c "echo backup ok"'],
    [() => "kubectl create job backup-manual --from=cronjob/backup"],
  ],
  "ckad-canary": [
    [() => "kubectl get pods --show-labels"],
    [() => "kubectl apply -f web-v2.yaml"],
    [() => "kubectl run tmp --rm -it --image=busybox --restart=Never -- wget -qO- web"],
    [() => "kubectl scale deployment web-v2 --replicas=3 && kubectl scale deployment web-v1 --replicas=0"],
  ],
  "ckad-troubleshoot-app": [
    [() => "kubectl get pods"],
    [(sh) => `kubectl describe pod ${podName(sh, "orders-")}`],
    [() => "kubectl create configmap orders-config --from-literal=QUEUE=orders"],
    [() => "kubectl logs deployment/worker --previous"],
    [(sh) => edit(sh, "kubectl edit deployment worker", (d) => (d.spec.template.spec.containers[0].command = ["sh", "-c", "while true; do echo processando fila; sleep 10; done"]))],
  ],
  "ckad-services-ingress": [
    [() => "kubectl expose deployment api --port=80"],
    [() => "kubectl run dns --rm -it --image=busybox --restart=Never -- nslookup api"],
    [() => "kubectl run tmp --rm -it --image=busybox --restart=Never -- wget -qO- api"],
    [() => 'kubectl create ingress api --class=nginx --rule="api.danylo.dev/*=api:80"'],
  ],
};

describe("ckad", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it.each(labs.map((l) => [l.id, l] as const))("%s is solvable", (_, lab) => {
    expectWellFormed(lab);
    expectSolvable(lab, SOLUTIONS[lab.id]);
  });
});
