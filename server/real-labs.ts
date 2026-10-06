import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { Plugin } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isRealLab, REAL_LABS, type CommandResult, type RealSession } from "../src/labs/real/catalog";

const CONTEXT = "kind-danylo-lab";
const name = "[a-z0-9][a-z0-9.-]{0,100}";
const image = "[a-zA-Z0-9][a-zA-Z0-9._:/@-]{0,200}";
const resource = "(?:pods?|po|deployments?|deploy|services?|svc|replicasets?|rs|events?|ev|endpoints?|ep|nodes?|no|namespaces?|ns|all)";
const target = `${resource}(?:[ /]${name})?`;
const patterns = [
  /^config current-context$/, /^cluster-info$/, /^version(?: -o (?:json|yaml))?$/,
  new RegExp(`^get ${target}(?: (?:-o (?:wide|json|yaml|name)|--show-labels|-l [a-zA-Z0-9_.=-]+))*$`),
  new RegExp(`^describe ${target}$`),
  new RegExp(`^logs (?:pod/|deployment/)?${name}(?: --tail=[0-9]{1,4})?$`),
  new RegExp(`^run ${name} --image=${image}(?: --restart=(?:Never|Always|OnFailure))?$`),
  new RegExp(`^create deployment ${name} --image=${image}(?: --replicas=[1-5])?$`),
  new RegExp(`^scale (?:deployment|deploy)[ /]${name} --replicas=[1-5]$`),
  new RegExp(`^expose (?:deployment|deploy)[ /]${name} --port=[0-9]{1,5}(?: --type=(?:NodePort|ClusterIP))?$`),
  new RegExp(`^set image (?:deployment|deploy)[ /]${name} ${name}=${image}$`),
  new RegExp(`^rollout (?:status|history|undo) (?:deployment|deploy)[ /]${name}$`),
  new RegExp(`^delete (?:pods?|po|deployments?|deploy|services?|svc)[ /]${name}$`),
  /^run probe --image=busybox:1\.37 --restart=Never -- wget -qO- http:\/\/web$/,
];

// Deliberately a finite kubectl grammar, never a host shell or arbitrary CLI plugin.
export function commandArgs(command: string): string[] {
  const normalized = command.trim().replace(/\s+/g, " ");
  const match = /^(?:kubectl|k) (.+)$/.exec(normalized);
  if (!match || !patterns.some((p) => p.test(match[1]))) {
    throw new Error("Comando não disponível neste terminal. Use help para ver os comandos aceitos. O contexto e o namespace são fixos nesta tentativa.");
  }
  return match[1].split(" ");
}

function kubectl(args: string[], namespace?: string, input?: string): Promise<CommandResult & { stdout: string }> {
  return new Promise((resolve) => {
    const child = execFile("kubectl", ["--context", CONTEXT, "--request-timeout=15s", ...(namespace ? ["--namespace", namespace] : []), ...args],
      { timeout: 45_000, maxBuffer: 1024 * 1024, env: { ...process.env, LANG: "C.UTF-8" } },
      (error, stdout, stderr) => resolve({ ok: !error, stdout, output: [stdout, stderr, error?.killed ? "Tempo limite de 45s. Consulte o estado do recurso e tente novamente." : error && !stderr ? error.message : ""].filter(Boolean).join("\n").trim() }));
    child.stdin?.end(input);
  });
}

type KubeObject = {
  metadata: { name: string; uid?: string; generation?: number; annotations?: Record<string, string> };
  spec?: { replicas?: number; containers?: { image: string }[]; template?: { spec: { containers: { image: string }[] } }; type?: string };
  status?: { phase?: string; availableReplicas?: number; updatedReplicas?: number; observedGeneration?: number; conditions?: { type: string; status: string }[]; containerStatuses?: { state?: { terminated?: { exitCode: number } } }[] };
  subsets?: { addresses?: unknown[] }[];
};
type Session = RealSession & { history: { command: string; output: string }[]; deletedPodUids: string[]; busy: boolean };

async function objects(resourceName: string, namespace?: string): Promise<KubeObject[]> {
  const result = await kubectl(["get", resourceName, "-o", "json"], namespace);
  if (!result.ok) throw new Error(result.output);
  return JSON.parse(result.stdout).items;
}

const ready = (obj?: KubeObject) => !!obj?.status?.conditions?.some((c) => c.type === "Ready" && c.status === "True");
const deploymentReady = (obj?: KubeObject) => !!obj && (obj.spec?.replicas ?? 0) > 0 && obj.status?.availableReplicas === obj.spec?.replicas && obj.status?.updatedReplicas === obj.spec?.replicas && (obj.status?.observedGeneration ?? 0) >= (obj.metadata.generation ?? 0);

async function check(session: Session, step: number): Promise<boolean> {
  const ran = (pattern: RegExp) => session.history.some((h) => pattern.test(h.command));
  if (session.labId === "k8s-cluster-explore") {
    await objects("nodes"); // Every verification confirms live API access.
    return [ran(/^kubectl config current-context$/), ran(/^kubectl cluster-info$/), ran(/^kubectl get (ns|namespaces?)\b/)][step];
  }
  if (session.labId === "k8s-check-status") {
    const nodes = await objects("nodes");
    const inspected = nodes.some((n) => ready(n) && !n.status?.conditions?.some((c) => /Pressure$/.test(c.type) && c.status !== "False") && session.history.some((h) => h.command === `kubectl describe node ${n.metadata.name}` || h.command === `kubectl describe node/${n.metadata.name}`));
    return [nodes.length > 0 && nodes.every(ready) && ran(/^kubectl get (nodes?|no)\b/), inspected, ran(/^kubectl version\b/)][step];
  }
  const [pods, deployments, services] = await Promise.all([objects("pods", session.namespace), objects("deployments", session.namespace), objects("services", session.namespace)]);
  const pod = pods.find((p) => p.metadata.name === "nginx");
  const dep = (n: string) => deployments.find((d) => d.metadata.name === n);
  const img = (n: string) => dep(n)?.spec?.template?.spec.containers[0]?.image;
  switch (session.labId) {
    case "k8s-first-pod": return [!!pod && pod.spec?.containers?.[0]?.image === "nginx:1.25", ready(pod) && ran(/^kubectl get (pods?|po)\b/), ready(pod) && ran(/^kubectl logs nginx\b/)][step];
    case "k8s-deploy": return [!!dep("web") && img("web") === "nginx:1.25", dep("web")?.spec?.replicas === 3, dep("web")?.spec?.replicas === 3 && deploymentReady(dep("web")) && session.deletedPodUids.length > 0 && !pods.some((p) => session.deletedPodUids.includes(p.metadata.uid ?? ""))][step];
    case "k8s-expose": {
      const svc = services.find((s) => s.metadata.name === "web");
      if (step === 0) return svc?.spec?.type === "NodePort";
      const endpoints = await objects("endpoints", session.namespace);
      const hasEndpoints = !!endpoints.find((e) => e.metadata.name === "web")?.subsets?.some((s) => s.addresses?.length);
      if (step === 1) return hasEndpoints && ran(/^kubectl describe (svc|services?)[ /]web$/);
      const probe = pods.find((p) => p.metadata.name === "probe");
      const logs = await kubectl(["logs", "probe"], session.namespace);
      return hasEndpoints && probe?.status?.phase === "Succeeded" && logs.ok && logs.output.includes("Welcome to nginx!") && ran(/^kubectl logs probe$/);
    }
    case "k8s-troubleshoot-nginx": return [ran(/^kubectl get (pods?|po|all)\b/), ran(/^kubectl (describe (pods?|po)[ /]nginx-|get (events|ev))/), img("nginx") === "nginx:1.25", deploymentReady(dep("nginx")) && ran(/^kubectl rollout status deployment[ /]nginx$/)][step];
    case "k8s-rollout": return [img("api") === "nginx:1.25", ran(/^kubectl rollout history deployment[ /]api$/), img("api") === "nginx:1.24" && Number(dep("api")?.metadata.annotations?.["deployment.kubernetes.io/revision"]) >= 3 && deploymentReady(dep("api"))][step];
  }
}

async function required(args: string[], namespace?: string, input?: string) {
  const result = await kubectl(args, namespace, input);
  if (!result.ok) throw new Error(result.output);
  return result.output;
}

async function seed(session: Session) {
  await required(["create", "namespace", session.namespace]);
  await required(["label", "namespace", session.namespace, "app.kubernetes.io/managed-by=danylo-labs"]);
  const resourceQuota = { apiVersion: "v1", kind: "ResourceQuota", metadata: { name: "lab-budget" }, spec: { hard: { pods: "12", services: "6", "count/deployments.apps": "6" } } };
  await required(["apply", "-f", "-"], session.namespace, JSON.stringify(resourceQuota));
  await required(["apply", "-f", "-"], session.namespace, JSON.stringify({ apiVersion: "v1", kind: "LimitRange", metadata: { name: "lab-limits" }, spec: { limits: [{ type: "Container", default: { memory: "256Mi", cpu: "500m" }, defaultRequest: { memory: "32Mi", cpu: "25m" } }] } }));
  const seeds: Partial<Record<Session["labId"], [string, string, number]>> = {
    "k8s-expose": ["web", "nginx:1.25", 2],
    "k8s-troubleshoot-nginx": ["nginx", "ngnix:1.25", 2],
    "k8s-rollout": ["api", "nginx:1.24", 3],
  };
  const data = seeds[session.labId];
  if (data) {
    const [deploymentName, deploymentImage, replicas] = data;
    // Explicit container names match the instructions, including the broken-image lab.
    await required(["apply", "-f", "-"], session.namespace, JSON.stringify({ apiVersion: "apps/v1", kind: "Deployment", metadata: { name: deploymentName }, spec: { replicas, selector: { matchLabels: { app: deploymentName } }, template: { metadata: { labels: { app: deploymentName } }, spec: { containers: [{ name: deploymentName, image: deploymentImage }] } } } }));
  }
}

export function realLabsPlugin(): Plugin {
  const token = randomBytes(32).toString("hex");
  const sessions = new Map<string, Session>();
  let creating = false;
  const publicSession = ({ id, labId, namespace, passed }: Session): RealSession => ({ id, labId, namespace, passed });
  return {
    name: "local-real-labs", apply: "serve",
    configureServer(server) {
      if (server.config.server.host !== "127.0.0.1") throw new Error("O modo real exige --host 127.0.0.1.");
      const send = (res: ServerResponse, status: number, data: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify(data));
      };
      const handle = async (req: IncomingMessage, res: ServerResponse) => {
        const port = server.config.server.port;
        const hosts = [`localhost:${port}`, `127.0.0.1:${port}`];
        if (!hosts.includes(req.headers.host ?? "") || (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) || req.headers["sec-fetch-site"] === "cross-site") return send(res, 403, { error: "Acesso permitido somente pela interface local." });
        const path = req.url?.split("?")[0];
        if (req.method === "GET" && path === "/api/real/status") {
          const result = await kubectl(["get", "nodes", "-o", "json"]);
          return send(res, 200, { token, context: CONTEXT, connected: result.ok, error: result.ok ? null : result.output, nodes: result.ok ? JSON.parse(result.stdout).items.map((n: KubeObject) => n.metadata.name) : [] });
        }
        if (req.method !== "POST" || req.headers["x-lab-token"] !== token || req.headers["content-type"] !== "application/json") return send(res, 403, { error: "Sessão local inválida. Recarregue a página." });
        let body = "";
        for await (const chunk of req) { body += chunk; if (body.length > 8192) return send(res, 413, { error: "Requisição muito grande." }); }
        const data = JSON.parse(body);
        if (path === "/api/real/start") {
          if (typeof data.labId !== "string" || !isRealLab(data.labId)) return send(res, 400, { error: "Lab sem adaptação para o cluster real." });
          if (creating || sessions.size >= 8) return send(res, 409, { error: "Aguarde a preparação ou encerre uma tentativa antes de abrir outra." });
          creating = true;
          const id = randomBytes(12).toString("hex");
          const session: Session = { id, labId: data.labId, namespace: `dlab-${id}`, passed: [], history: [], deletedPodUids: [], busy: false };
          try {
            await seed(session);
            sessions.set(id, session);
            return send(res, 200, publicSession(session));
          } catch (error) {
            await kubectl(["delete", "namespace", session.namespace, "--ignore-not-found", "--wait=false"]);
            throw error;
          } finally { creating = false; }
        }
        const session = sessions.get(data.sessionId);
        if (!session) return send(res, 404, { error: "Tentativa não encontrada. Inicie um novo lab." });
        if (session.busy) return send(res, 409, { error: "Aguarde o comando atual terminar." });
        session.busy = true;
        try {
          if (path === "/api/real/resume") return send(res, 200, publicSession(session));
          if (path === "/api/real/stop") {
            await required(["delete", "namespace", session.namespace, "--wait=false"]);
            sessions.delete(session.id);
            return send(res, 200, { ok: true });
          }
          if (path === "/api/real/command") {
            if (typeof data.command !== "string" || data.command.length > 1024) return send(res, 400, { error: "Comando inválido." });
            const args = commandArgs(data.command);
            let deleted: string | undefined;
            const deletion = /^delete (?:pods?|po)[ /](web-[a-z0-9.-]+)$/.exec(args.join(" "));
            if (deletion) deleted = (await objects("pods", session.namespace)).find((p) => p.metadata.name === deletion[1])?.metadata.uid;
            const result = await kubectl(args[0] === "config" ? ["config", "view", "--minify", "-o", "jsonpath={.current-context}"] : args, session.namespace);
            if (result.ok) {
              session.history.push({ command: `kubectl ${args.join(" ")}`, output: result.output });
              session.history = session.history.slice(-500);
              if (deleted) session.deletedPodUids.push(deleted);
            }
            return send(res, 200, result);
          }
          if (path === "/api/real/verify") {
            const step = data.step;
            if (!Number.isInteger(step) || step < 0 || step >= REAL_LABS[session.labId] || step > session.passed.length) return send(res, 400, { error: "Verifique os passos em ordem." });
            const passed = await check(session, step);
            if (passed && !session.passed.includes(step)) session.passed.push(step);
            return send(res, 200, { passed, message: passed ? "Validado no cluster real." : "O estado real ainda não atende ao passo. Confira nomes, imagem, réplicas e prontidão dos recursos; o download das imagens pode levar alguns minutos.", session: publicSession(session) });
          }
          return send(res, 404, { error: "Operação desconhecida." });
        } finally { session.busy = false; }
      };
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith("/api/real/")) return next();
        void handle(req, res).catch((error) => { if (!res.headersSent) send(res, 400, { error: error instanceof Error ? error.message : "Falha no cluster local." }); });
      });
    },
  };
}
