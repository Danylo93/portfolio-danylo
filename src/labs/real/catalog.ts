export const REAL_LABS = {
  "k8s-cluster-explore": 3,
  "k8s-check-status": 3,
  "k8s-first-pod": 3,
  "k8s-deploy": 3,
  "k8s-expose": 3,
  "k8s-troubleshoot-nginx": 4,
  "k8s-rollout": 3,
} as const;

export type RealLabId = keyof typeof REAL_LABS;
export const isRealLab = (id: string): id is RealLabId => Object.prototype.hasOwnProperty.call(REAL_LABS, id);
export type RealSession = { id: string; labId: RealLabId; namespace: string; passed: number[] };
export type CommandResult = { output: string; ok: boolean };
