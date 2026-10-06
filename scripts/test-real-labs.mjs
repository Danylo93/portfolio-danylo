// Requires npm run dev:real and the local Kind cluster. Creates and cleans test namespaces.
import assert from "node:assert/strict";
const base = process.env.REAL_LABS_URL ?? "http://127.0.0.1:8080";
const status = await (await fetch(`${base}/api/real/status`)).json();
assert.equal(status.connected, true, status.error);
const call = async (path, body, expected = 200, headers = {}) => {
  const response = await fetch(`${base}/api/real/${path}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Lab-Token": status.token, ...headers }, body: JSON.stringify(body) });
  const result = await response.json();
  assert.equal(response.status, expected, JSON.stringify(result));
  return result;
};
await call("start", { labId: "k8s-first-pod" }, 403, { "X-Lab-Token": "invalid" });
await call("start", { labId: "k8s-first-pod" }, 403, { Origin: "https://example.com" });
await call("start", { labId: "__proto__" }, 400);

async function lab(labId, solve) {
  const session = await call("start", { labId });
  const command = async (command) => {
    const result = await call("command", { sessionId: session.id, command });
    assert.equal(result.ok, true, result.output);
    return result.output;
  };
  const verify = async (step, wait = false) => {
    const deadline = Date.now() + (wait ? 180_000 : 0);
    do {
      const result = await call("verify", { sessionId: session.id, step });
      if (result.passed) return;
      if (Date.now() >= deadline) assert.fail(`${labId} step ${step}: ${result.message}`);
      await new Promise((resolve) => setTimeout(resolve, 2500));
    } while (true);
  };
  const rollout = async (name) => {
    for (let i = 0; i < 5; i++) {
      const result = await call("command", { sessionId: session.id, command: `kubectl rollout status deployment/${name}` });
      if (result.ok) return;
    }
    assert.fail(`rollout ${name} did not become ready`);
  };
  try {
    await call("verify", { sessionId: session.id, step: 2 }, 400);
    const before = await call("verify", { sessionId: session.id, step: 0 });
    assert.equal(before.passed, false, "Must not pass before doing the exercise");
    await call("command", { sessionId: session.id, command: "kubectl get pods -n kube-system" }, 400);
    await call("command", { sessionId: session.id, command: "kubectl get pods; id" }, 400);
    assert.equal((await call("resume", { sessionId: session.id })).namespace, session.namespace);
    await solve({ command, verify, rollout, session });
    console.log(`PASS ${labId}`);
  } finally {
    await call("stop", { sessionId: session.id });
    await call("resume", { sessionId: session.id }, 404);
  }
}

await lab("k8s-cluster-explore", async ({ command, verify }) => {
  assert.equal(await command("kubectl config current-context"), "kind-danylo-lab"); await verify(0);
  await command("kubectl cluster-info"); await verify(1);
  await command("kubectl get namespaces"); await verify(2);
});
await lab("k8s-check-status", async ({ command, verify }) => {
  await command("kubectl get nodes"); await verify(0);
  await command(`kubectl describe node ${status.nodes[0]}`); await verify(1);
  await command("kubectl version"); await verify(2);
});
await lab("k8s-first-pod", async ({ command, verify }) => {
  await command("kubectl run nginx --image=nginx:1.25"); await verify(0);
  await command("kubectl get pods -o wide"); await verify(1, true);
  await command("kubectl logs nginx"); await verify(2);
});
await lab("k8s-deploy", async ({ command, verify, rollout }) => {
  await command("kubectl create deployment web --image=nginx:1.25"); await verify(0);
  await command("kubectl scale deployment web --replicas=3"); await verify(1);
  await rollout("web");
  const pods = JSON.parse(await command("kubectl get pods -o json"));
  await command(`kubectl delete pod/${pods.items[0].metadata.name}`); await verify(2, true);
});
await lab("k8s-expose", async ({ command, verify, rollout }) => {
  await rollout("web");
  await command("kubectl expose deployment web --port=80 --type=NodePort"); await verify(0);
  await command("kubectl describe svc web"); await verify(1, true);
  await command("kubectl run probe --image=busybox:1.37 --restart=Never -- wget -qO- http://web");
  for (let i = 0; i < 60; i++) {
    const pods = JSON.parse(await command("kubectl get pods -o json"));
    if (pods.items.find((p) => p.metadata.name === "probe")?.status.phase === "Succeeded") break;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  assert.match(await command("kubectl logs probe"), /Welcome to nginx!/); await verify(2);
});
await lab("k8s-troubleshoot-nginx", async ({ command, verify, rollout }) => {
  await command("kubectl get pods"); await verify(0);
  await command("kubectl get events"); await verify(1);
  await command("kubectl set image deployment/nginx nginx=nginx:1.25"); await verify(2);
  await rollout("nginx"); await verify(3);
});
await lab("k8s-rollout", async ({ command, verify, rollout }) => {
  await rollout("api");
  await command("kubectl set image deployment/api api=nginx:1.25"); await verify(0);
  await rollout("api");
  await command("kubectl rollout history deployment/api"); await verify(1);
  await command("kubectl rollout undo deployment/api"); await rollout("api"); await verify(2);
});
console.log("All 7 real labs passed; test namespaces cleaned.");
