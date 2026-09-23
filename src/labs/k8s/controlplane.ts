// Control-plane tools for CKA-style labs: etcdctl, etcdutl and kubeadm.
import { registerTool } from "../registry";
import type { Shell } from "../shell";
import type { Flags } from "../types";
import { flagStr, table } from "../util";
import { CP_NODE, controlPlaneVersion, etcdState, serializeCluster, staticPodYaml } from "./cluster";

const CERTS = { cacert: "/etc/kubernetes/pki/etcd/ca.crt", cert: "/etc/kubernetes/pki/etcd/server.crt", key: "/etc/kubernetes/pki/etcd/server.key" };

const tlsProblem = (sh: Shell, flags: Flags): string | null => {
  const missing = (["cacert", "cert", "key"] as const).filter((k) => !flagStr(flags, k));
  if (missing.length)
    return `{"level":"warn","ts":"2026-09-23T12:00:05Z","logger":"etcd-client","caller":"v3@v3.5.12/retry_interceptor.go:62","msg":"retrying of unary invoker failed","target":"etcd-endpoints://0xc000452000/127.0.0.1:2379","attempt":0,"error":"rpc error: code = DeadlineExceeded desc = latest balancer error: last connection error: connection error: desc = \\"error reading server preface: EOF\\""}\nError: context deadline exceeded`;
  for (const k of ["cacert", "cert", "key"] as const) {
    const v = flagStr(flags, k)!;
    if (sh.readFile(v) === undefined) return `Error: open ${v}: no such file or directory`;
    if (v !== CERTS[k]) return `Error: context deadline exceeded (certificado errado para --${k}: esperado ${CERTS[k]})`;
  }
  const ep = flagStr(flags, "endpoints");
  if (ep && !/^(https:\/\/)?(127\.0\.0\.1|localhost|172\.18\.0\.2):2379$/.test(ep)) return `Error: dial tcp ${ep}: connect: connection refused`;
  if (ep && !ep.startsWith("https://")) return "Error: context deadline exceeded (o etcd só aceita TLS: use https://127.0.0.1:2379)";
  return null;
};

const snapshotStatus = (path: string) =>
  table([["HASH", "REVISION", "TOTAL KEYS", "TOTAL SIZE"], ["8c3f1b2a", "48213", "1247", "5.2 MB"]]).replace(/^/gm, "| ").replace(/$/gm, " |") + `\n(${path})`;

const restore = (sh: Shell, args: string[], flags: Flags) => {
  const file = args.find((a) => !a.startsWith("-") && a !== "snapshot" && a !== "restore");
  const dir = flagStr(flags, "data-dir");
  const st = etcdState(sh);
  if (!file) return "Error: snapshot path is required";
  if (!st.snapshots[sh.resolve(file)]) return `Error: open ${file}: no such file or directory`;
  if (!dir) return "Error: --data-dir is required (ex.: --data-dir /var/lib/etcd-from-backup)";
  const abs = sh.resolve(dir);
  if (sh.isDir(abs) && abs !== "/var/lib/etcd-restore-tmp") return `Error: data-dir "${abs}" exists`;
  st.restored[abs] = st.snapshots[sh.resolve(file)];
  sh.writeFile(`${abs}/member/snap/db`, "etcd-db");
  sh.writeFile(`${abs}/member/wal/0000000000000000-0000000000000000.wal`, "wal");
  return [
    `2026-09-23T12:05:00Z\tinfo\tsnapshot/v3_snapshot.go:260\trestoring snapshot\t{"path": "${file}", "wal-dir": "${abs}/member/wal", "data-dir": "${abs}", "snap-dir": "${abs}/member/snap"}`,
    `2026-09-23T12:05:00Z\tinfo\tmembership/store.go:141\tTrimming membership information from the backend...`,
    `2026-09-23T12:05:01Z\tinfo\tsnapshot/v3_snapshot.go:287\trestored snapshot\t{"path": "${file}", "wal-dir": "${abs}/member/wal", "data-dir": "${abs}", "snap-dir": "${abs}/member/snap"}`,
  ].join("\n");
};

registerTool({
  name: "etcdctl",
  summary: "cliente do etcd (backup/snapshot do cluster)",
  subcommands: { snapshot: "save/status de snapshots do etcd", "member": "lista membros do cluster etcd", endpoint: "health/status do endpoint", version: "versão do etcdctl" },
  flags: { "--endpoints": "endereço do etcd (https://127.0.0.1:2379)", "--cacert": "CA do etcd (/etc/kubernetes/pki/etcd/ca.crt)", "--cert": "certificado cliente (server.crt)", "--key": "chave do certificado (server.key)", "-w": "formato de saída (table, json)", "--data-dir": "diretório onde restaurar" },
  valueFlags: ["--endpoints", "--cacert", "--cert", "--key", "-w", "--write-out", "--data-dir"],
  run: ({ sh, pos, flags, args }) => {
    if (sh.host !== CP_NODE) return "Error: dial tcp 127.0.0.1:2379: connect: connection refused (o etcd roda no control-plane)";
    const [sub, action, path] = pos;
    if (sub === "version") return "etcdctl version: 3.5.12\nAPI version: 3.5";
    if (sub === "snapshot" && action === "status") {
      if (!path || sh.readFile(path) === undefined) return `Error: stat ${path}: no such file or directory`;
      return snapshotStatus(path);
    }
    if (sub === "snapshot" && action === "restore") return `Deprecated: Use \`etcdutl snapshot restore\` instead.\n\n${restore(sh, args, flags)}`;
    const tls = tlsProblem(sh, flags);
    if (tls) return tls;
    if (sub === "snapshot" && action === "save") {
      if (!path) return "Error: snapshot save expects one argument";
      const abs = sh.resolve(path);
      const parent = abs.split("/").slice(0, -1).join("/") || "/";
      if (!sh.isDir(parent)) return `Error: could not open ${abs}.part (open ${abs}.part: no such file or directory)`;
      etcdState(sh).snapshots[abs] = serializeCluster(sh);
      sh.writeFile(abs, "etcd-snapshot");
      return `{"level":"info","msg":"created temporary db file","path":"${abs}.part"}\n{"level":"info","msg":"fetching snapshot","endpoint":"https://127.0.0.1:2379"}\n{"level":"info","msg":"fetched snapshot","endpoint":"https://127.0.0.1:2379","size":"5.2 MB","took":"now"}\n{"level":"info","msg":"saved","path":"${abs}"}\nSnapshot saved at ${abs}`;
    }
    if (sub === "member" && action === "list") return "8e9e05c52164694d, started, lab-control-plane, https://172.18.0.2:2380, https://172.18.0.2:2379, false";
    if (sub === "endpoint" && action === "health") return "https://127.0.0.1:2379 is healthy: successfully committed proposal: took = 9.2ms";
    return `Error: unknown command "${sub ?? ""}" for "etcdctl"`;
  },
  explainError: (_cmd, output) => {
    if (/context deadline exceeded/.test(output) && /certificado errado|TLS/.test(output)) return null;
    if (/context deadline exceeded/.test(output))
      return "O etcd exige TLS mútuo. Informe os certificados: --cacert=/etc/kubernetes/pki/etcd/ca.crt --cert=/etc/kubernetes/pki/etcd/server.crt --key=/etc/kubernetes/pki/etcd/server.key (veja os caminhos em /etc/kubernetes/manifests/etcd.yaml).";
    if (/data-dir .* exists/.test(output)) return "Restaure para um diretório NOVO (ex.: /var/lib/etcd-from-backup) — nunca por cima do diretório em uso.";
    return null;
  },
});

registerTool({
  name: "etcdutl",
  summary: "utilitário offline do etcd (restore de snapshot)",
  subcommands: { snapshot: "restore/status de snapshots (offline)" },
  flags: { "--data-dir": "diretório NOVO onde os dados serão restaurados" },
  valueFlags: ["--data-dir", "-w", "--write-out"],
  run: ({ sh, pos, flags, args }) => {
    const [sub, action, path] = pos;
    if (sub === "snapshot" && action === "restore") return restore(sh, args, flags);
    if (sub === "snapshot" && action === "status") return path && sh.readFile(path) !== undefined ? snapshotStatus(path) : `Error: stat ${path}: no such file or directory`;
    if (sub === "version") return "etcdutl version: 3.5.12";
    return `Error: unknown command "${sub ?? ""}" for "etcdutl"`;
  },
});

const kubeadmVersion = (sh: Shell) => `v${sh.hostOf().packages.kubeadm?.split("-")[0] ?? "1.30.0"}`;

registerTool({
  name: "kubeadm",
  summary: "bootstrap e upgrade do cluster",
  subcommands: { upgrade: "plan/apply/node — atualiza o control plane e os nós", version: "versão do kubeadm", token: "gerencia tokens de join", certs: "verifica/renova certificados", init: "cria um cluster", join: "adiciona um nó" },
  flags: { "--print-join-command": "imprime o comando kubeadm join completo", "-y": "confirma sem perguntar" },
  run: ({ sh, pos, args }) => {
    const [sub, action, target] = pos;
    switch (sub) {
      case "version":
        return `kubeadm version: &version.Info{Major:"1", Minor:"${kubeadmVersion(sh).split(".")[1]}", GitVersion:"${kubeadmVersion(sh)}", GoVersion:"go1.22.5", Platform:"linux/amd64"}`;
      case "token":
        if (action === "create" && args.includes("--print-join-command"))
          return "kubeadm join 172.18.0.2:6443 --token 9a08jv.c0izixklcxtmnze7 --discovery-token-ca-cert-hash sha256:4f1a2b3c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7089";
        return action === "list" ? table([["TOKEN", "TTL", "EXPIRES", "USAGES"], ["9a08jv.c0izixklcxtmnze7", "23h", "2026-09-24T12:00:00Z", "authentication,signing"]]) : "Error: unknown token command";
      case "certs":
        if (action === "check-expiration")
          return table([["CERTIFICATE", "EXPIRES", "RESIDUAL TIME", "EXTERNALLY MANAGED"], ...["admin.conf", "apiserver", "apiserver-etcd-client", "apiserver-kubelet-client", "controller-manager.conf", "etcd-server", "front-proxy-client", "scheduler.conf"].map((c) => [c, "Sep 22, 2027 12:00 UTC", "364d", "no"])]);
        if (action === "renew") return `[renew] certificate ${target ?? "all"} renewed`;
        return "Error: unknown certs command";
      case "upgrade": {
        if (sh.host !== CP_NODE && action !== "node") return "[upgrade/config] FATAL: this command must be run on a control-plane node";
        const cp = sh.ext("controlPlane", () => ({ version: "v1.30.0" }));
        if (action === "plan")
          return [
            "[preflight] Running pre-flight checks.",
            "[upgrade/config] Reading configuration from the cluster...",
            `[upgrade] Running cluster health checks`,
            `[upgrade] Fetching available versions to upgrade to`,
            `[upgrade/versions] Cluster version: ${cp.version}`,
            `[upgrade/versions] kubeadm version: ${kubeadmVersion(sh)}`,
            `[upgrade/versions] Target version: v1.31.0`,
            "",
            "Components that must be upgraded manually after you have upgraded the control plane with 'kubeadm upgrade apply':",
            table([["COMPONENT", "NODE", "CURRENT", "TARGET"], ...sh.state.nodes.map((n) => ["kubelet", n.name, n.version, "v1.31.0"])]),
            "",
            "Upgrade to the latest stable version:",
            "",
            table([["COMPONENT", "NODE", "CURRENT", "TARGET"], ["kube-apiserver", CP_NODE, cp.version, "v1.31.0"], ["kube-controller-manager", CP_NODE, cp.version, "v1.31.0"], ["kube-scheduler", CP_NODE, cp.version, "v1.31.0"], ["kube-proxy", "", cp.version, "v1.31.0"], ["CoreDNS", "", "v1.11.1", "v1.11.3"], ["etcd", CP_NODE, "3.5.12-0", "3.5.15-0"]]),
            "",
            "You can now apply the upgrade by executing the following command:",
            "",
            "\tkubeadm upgrade apply v1.31.0",
            "",
            "Note: Before you can perform this upgrade, you have to update kubeadm to v1.31.0.",
          ].join("\n");
        if (action === "apply") {
          const v = target?.startsWith("v") ? target : target ? `v${target}` : undefined;
          if (!v) return "[upgrade/version] FATAL: missing version argument (ex.: kubeadm upgrade apply v1.31.0)";
          if (v.localeCompare(kubeadmVersion(sh), undefined, { numeric: true }) > 0)
            return `[upgrade/version] FATAL: the --version argument is invalid due to these errors:\n\n\t- Specified version to upgrade to "${v}" is higher than the kubeadm version "${kubeadmVersion(sh)}". Upgrade kubeadm first using the tool you used to install kubeadm\n\nCan be bypassed if you pass the --force flag`;
          cp.version = v;
          for (const comp of ["kube-apiserver", "kube-controller-manager", "kube-scheduler"] as const) sh.writeFile(`/etc/kubernetes/manifests/${comp}.yaml`, staticPodYaml(comp, v));
          return [
            "[preflight] Running pre-flight checks.",
            `[upgrade/version] You have chosen to change the cluster version to "${v}"`,
            "[upgrade/prepull] Pulling images required for setting up a Kubernetes cluster",
            `[upgrade/apply] Upgrading your Static Pod-hosted control plane to version "${v}" (timeout: 5m0s)...`,
            "[upgrade/staticpods] Component \"kube-apiserver\" upgraded successfully!",
            "[upgrade/staticpods] Component \"kube-controller-manager\" upgraded successfully!",
            "[upgrade/staticpods] Component \"kube-scheduler\" upgraded successfully!",
            "[addons] Applied essential addon: CoreDNS",
            "[addons] Applied essential addon: kube-proxy",
            "",
            `[upgrade/successful] SUCCESS! Your cluster was upgraded to "${v}". Enjoy!`,
            "",
            "[upgrade/kubelet] Now that your control plane is upgraded, please proceed with upgrading your kubelets if you haven't already done so.",
          ].join("\n");
        }
        if (action === "node") return "[upgrade] Reading configuration from the cluster...\n[upgrade] Upgrading your Static Pod-hosted control plane instance to version...\n[upgrade] The configuration for this node was successfully updated!\n[upgrade] Now you should go ahead and upgrade the kubelet package using your package manager.";
        return `Error: unknown command "${action}" for "kubeadm upgrade"`;
      }
      default:
        return `Error: unknown command "${sub ?? ""}" for "kubeadm"`;
    }
  },
  explainError: (_cmd, output) =>
    /higher than the kubeadm version/.test(output)
      ? "O kubeadm precisa estar na versão alvo ANTES do upgrade. Rode: apt-get install -y kubeadm=1.31.0-1.1 e confira com kubeadm version."
      : null,
});

export { controlPlaneVersion };
