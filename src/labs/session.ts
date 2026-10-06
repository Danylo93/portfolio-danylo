import { z } from "zod";
import { readStored, removeStored, writeStored } from "../lib/storage";
import { Shell, type ShellSnapshot } from "./shell";
import type { Lab } from "./types";

export type LabSessionData = {
  version: 1; labId: string; stepCount: number; step: number; passed: number[]; elapsed: number;
  hintLevel: number; stats: { hints: number; misses: number }; shell: ShellSnapshot;
};
export const labSessionKey = (id: string) => `danylo-lab-session-v1:${id}`;
export const terminalKey = (id: string) => `danylo-lab-terminal-v1:${id}`;

const strings = z.record(z.string());
const named = z.object({ name: z.string() }).passthrough();
const container = z.object({ name: z.string(), image: z.string() }).passthrough();
const podSpec = z.object({ containers: z.array(container) }).passthrough();
const snapshotSchema = z.object({
  state: z.object({
    pods: z.array(named.extend({ namespace: z.string(), spec: podSpec, labels: strings, createdAt: z.number(), image: z.string() })),
    deployments: z.array(named.extend({ namespace: z.string(), replicas: z.number(), selector: strings, labels: strings,
      template: z.object({ labels: strings, spec: podSpec }), history: z.array(z.unknown()), createdAt: z.number(), revision: z.number(), image: z.string() })),
    services: z.array(named.extend({ namespace: z.string(), selector: strings, type: z.enum(["ClusterIP", "NodePort", "LoadBalancer"]), port: z.number(), targetPort: z.number(), clusterIP: z.string(), createdAt: z.number() })),
    objects: z.array(named.extend({ kind: z.string(), manifest: z.unknown(), createdAt: z.number() })),
    namespaces: z.array(named.extend({ createdAt: z.number() })),
    nodes: z.array(named.extend({ role: z.enum(["control-plane", "worker"]), ip: z.string(), version: z.string(), schedulable: z.boolean(), labels: strings, taints: z.array(z.object({ key: z.string(), effect: z.string() }).passthrough()) })),
    images: z.array(z.string()), containers: z.array(container.extend({ id: z.string(), status: z.enum(["running", "exited"]), createdAt: z.number() })),
    tf: z.object({ initialized: z.boolean(), planned: z.boolean(), applied: z.boolean() }), files: strings,
    hosts: z.record(named.extend({ ip: z.string(), packages: strings, services: z.record(z.object({ active: z.boolean(), enabled: z.boolean(), logs: z.array(z.string()) }).passthrough()), files: strings.optional() })),
  }),
  log: z.array(z.string()), entries: z.array(z.object({ cmd: z.string(), output: z.string(), ok: z.boolean() })),
  flags: z.set(z.string()), env: strings, aliases: strings, cwd: z.string().startsWith("/"), host: z.string(), store: z.map(z.string(), z.unknown()),
});
const sessionSchema = z.object({ version: z.literal(1), labId: z.string(), stepCount: z.number().int(),
  step: z.number().int(), passed: z.array(z.number().int()), elapsed: z.number().int().nonnegative(), hintLevel: z.number().int().nonnegative(),
  stats: z.object({ hints: z.number().int().nonnegative(), misses: z.number().int().nonnegative() }), shell: snapshotSchema,
});

export const loadLabSession = (lab: Lab): LabSessionData | null => readStored(labSessionKey(lab.id), (value): value is LabSessionData => {
  if (!sessionSchema.safeParse(value).success) return false;
  const s = value as LabSessionData;
  return s.labId === lab.id && s.stepCount === lab.steps.length && s.step >= -1 && s.step <= lab.steps.length &&
    s.passed.every((i) => i >= 0 && i < lab.steps.length) && new Set(s.passed).size === s.passed.length &&
    s.hintLevel <= (lab.steps[s.step]?.hints.length ?? 0) && Boolean(s.shell.state.hosts[s.shell.host]);
});
export const saveLabSession = (data: LabSessionData) => writeStored(labSessionKey(data.labId), data);
export const clearLabSession = (id: string) => {
  const session = removeStored(labSessionKey(id));
  const terminal = removeStored(terminalKey(id));
  return session && terminal;
};
export const restoredShell = (lab: Lab, saved: LabSessionData | null) => {
  const shell = new Shell(lab.seed);
  if (saved) shell.restore(saved.shell);
  return shell;
};
