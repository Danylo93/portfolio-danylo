import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import { labs, PV_POD_YAML, PV_YAML, PVC_YAML } from "./cka";
import { Shell } from "../shell";
import { expectSolvable, expectWellFormed, podName, type Solution } from "../test-utils";

const ETCD = "etcdctl snapshot save /opt/etcd-backup.db --endpoints=https://127.0.0.1:2379 --cacert=/etc/kubernetes/pki/etcd/ca.crt --cert=/etc/kubernetes/pki/etcd/server.crt --key=/etc/kubernetes/pki/etcd/server.key";

const edit = (sh: Shell, cmd: string, change: (s: string) => string) => {
  const r = sh.exec(cmd);
  if (!r.edit) throw new Error(`${cmd} did not open the editor: ${r.output}`);
  sh.saveEdit(r.edit.path, change(r.edit.content));
};

const withSpec = (sh: Shell, file: string, patch: (spec: Record<string, unknown>) => void) => {
  const doc = YAML.parse(sh.readFile(file)!);
  patch(doc.spec);
  sh.saveEdit(sh.resolve(file), YAML.stringify(doc));
};

const SOLUTIONS: Record<string, Solution> = {
  "cka-etcd-backup-restore": [
    [() => "cat /etc/kubernetes/manifests/etcd.yaml"],
    [() => `ETCDCTL_API=3 ${ETCD}`, () => "etcdctl snapshot status /opt/etcd-backup.db -w table"],
    [() => "kubectl delete deployment payments"],
    [() => "etcdutl snapshot restore /opt/etcd-backup.db --data-dir /var/lib/etcd-from-backup"],
    [(sh) => void sh.saveEdit("/etc/kubernetes/manifests/etcd.yaml", sh.readFile("/etc/kubernetes/manifests/etcd.yaml")!.replace("path: /var/lib/etcd\n", "path: /var/lib/etcd-from-backup\n")), () => "kubectl get deployments"],
  ],
  "cka-cluster-upgrade": [
    [() => "kubeadm upgrade plan"],
    [() => "apt-mark unhold kubeadm", () => "apt-get install -y kubeadm=1.31.0-1.1"],
    [() => "kubectl drain lab-control-plane --ignore-daemonsets"],
    [() => "kubeadm upgrade apply v1.31.0"],
    [() => "apt-get install -y kubelet=1.31.0-1.1 kubectl=1.31.0-1.1 && systemctl daemon-reload && systemctl restart kubelet"],
    [() => "kubectl uncordon lab-control-plane"],
  ],
  "cka-rbac": [
    [() => "kubectl create role pod-reader --verb=get,list,watch --resource=pods -n dev"],
    [() => "kubectl create rolebinding jane-pod-reader --role=pod-reader --user=jane -n dev"],
    [() => "kubectl auth can-i list pods -n dev --as jane", () => "kubectl auth can-i delete pods -n dev --as jane"],
    [() => "kubectl create serviceaccount deployer -n dev", () => "kubectl create rolebinding deployer-edit --clusterrole=edit --serviceaccount=dev:deployer -n dev", () => "kubectl auth can-i create deployments -n dev --as=system:serviceaccount:dev:deployer"],
  ],
  "cka-troubleshoot-scheduler": [
    [() => "kubectl get pods -o wide"],
    [(sh) => `kubectl describe pod ${podName(sh, "frontend-")}`],
    [() => "kubectl get pods -n kube-system"],
    [() => "kubectl logs kube-scheduler-lab-control-plane -n kube-system"],
    [(sh) => void sh.saveEdit("/etc/kubernetes/manifests/kube-scheduler.yaml", sh.readFile("/etc/kubernetes/manifests/kube-scheduler.yaml")!.replace("scheduler.conff", "scheduler.conf")), () => "kubectl get pods"],
  ],
  "cka-node-notready": [
    [() => "kubectl get nodes"],
    [() => "kubectl describe node lab-worker2"],
    [() => "ssh lab-worker2"],
    [() => "systemctl status kubelet", () => "journalctl -u kubelet -n 20"],
    [() => "systemctl enable --now kubelet"],
    [() => "exit", () => "kubectl get nodes"],
  ],
  "cka-networkpolicy": [
    [() => "kubectl run tmp --rm -it --image=busybox --restart=Never -- wget -qO- --timeout=2 db:5678"],
    [
      () => "cp exemplos/netpol-exemplo.yaml db-deny.yaml",
      (sh) => void sh.saveEdit(sh.resolve("db-deny.yaml"), "apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: db-deny-all\nspec:\n  podSelector:\n    matchLabels:\n      app: db\n  policyTypes:\n  - Ingress\n"),
      () => "kubectl apply -f db-deny.yaml",
    ],
    [
      (sh) => void sh.saveEdit(sh.resolve("db-allow-api.yaml"), "apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: db-allow-api\nspec:\n  podSelector:\n    matchLabels:\n      app: db\n  policyTypes:\n  - Ingress\n  ingress:\n  - from:\n    - podSelector:\n        matchLabels:\n          app: api\n    ports:\n    - protocol: TCP\n      port: 5678\n"),
      () => "kubectl apply -f db-allow-api.yaml",
    ],
    [() => "kubectl exec deploy/api -- wget -qO- --timeout=2 db:5678", () => "kubectl exec deploy/frontend -- wget -qO- --timeout=2 db:5678"],
  ],
  "cka-storage": [
    [(sh) => void sh.saveEdit(sh.resolve("pv.yaml"), PV_YAML), () => "kubectl apply -f pv.yaml"],
    [(sh) => void sh.saveEdit(sh.resolve("pvc.yaml"), PVC_YAML), () => "kubectl apply -f pvc.yaml", () => "kubectl get pvc"],
    [(sh) => void sh.saveEdit(sh.resolve("pod.yaml"), PV_POD_YAML), () => "kubectl apply -f pod.yaml"],
    [
      () => 'kubectl exec web-pv -- sh -c "echo persistido > /usr/share/nginx/html/index.html"',
      () => "kubectl delete pod web-pv",
      () => "kubectl apply -f pod.yaml",
      () => "kubectl exec web-pv -- cat /usr/share/nginx/html/index.html",
    ],
  ],
  "cka-scheduling": [
    [() => "kubectl label node lab-worker2 disktype=ssd"],
    [() => "kubectl run fast-app --image=nginx:1.25 --dry-run=client -o yaml > fast-app.yaml", (sh) => withSpec(sh, "fast-app.yaml", (s) => (s.nodeSelector = { disktype: "ssd" })), () => "kubectl apply -f fast-app.yaml"],
    [() => "kubectl taint nodes lab-worker2 dedicated=db:NoSchedule"],
    [
      () => "kubectl run db-app --image=redis:7 --dry-run=client -o yaml > db-app.yaml",
      (sh) => withSpec(sh, "db-app.yaml", (s) => Object.assign(s, { nodeSelector: { disktype: "ssd" }, tolerations: [{ key: "dedicated", operator: "Equal", value: "db", effect: "NoSchedule" }] })),
      () => "kubectl apply -f db-app.yaml",
    ],
  ],
  "cka-service-endpoints": [
    [() => "kubectl get endpoints checkout"],
    [() => "kubectl get pods --show-labels"],
    [(sh) => edit(sh, "kubectl edit svc checkout", (c) => c.replace(/check-out/g, "checkout"))],
    [() => "kubectl run tmp --rm -it --image=busybox --restart=Never -- wget -qO- checkout"],
  ],
};

describe("cka", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it.each(labs.map((l) => [l.id, l] as const))("%s is solvable", (_, lab) => {
    expectWellFormed(lab);
    expectSolvable(lab, SOLUTIONS[lab.id]);
  });

  it("etcdctl without certs fails with a mentor hint", () => {
    const sh = new Shell();
    const out = sh.exec("etcdctl snapshot save /opt/x.db").output;
    expect(out).toContain("context deadline exceeded");
  });

  it("kubeadm refuses to upgrade past its own version", () => {
    const sh = new Shell();
    expect(sh.exec("kubeadm upgrade apply v1.31.0").output).toContain("Upgrade kubeadm first");
  });

  it("drain without --ignore-daemonsets explains the DaemonSet pods", () => {
    const sh = new Shell();
    expect(sh.exec("kubectl drain lab-worker").output).toContain("--ignore-daemonsets");
  });

  it("pods are immutable on apply", () => {
    const sh = new Shell();
    sh.exec("kubectl run p --image=nginx:1.25 --dry-run=client -o yaml > p.yaml");
    sh.exec("kubectl apply -f p.yaml");
    withSpec(sh, "p.yaml", (s) => (s.nodeSelector = { a: "b" }));
    expect(sh.exec("kubectl apply -f p.yaml").output).toContain("Forbidden");
    expect(sh.exec("kubectl replace --force -f p.yaml").output).toContain("replaced");
  });
});
