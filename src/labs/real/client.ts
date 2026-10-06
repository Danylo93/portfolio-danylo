export type ClusterStatus = { token: string; context: string; connected: boolean; error?: string; nodes: string[] };

export async function realRequest<T>(path: string, token?: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/real/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "Content-Type": "application/json", "X-Lab-Token": token ?? "" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.headers.get("content-type")?.includes("application/json")) throw new Error("Inicie o servidor no WSL com npm run dev:real.");
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "Falha na conexão com o cluster.");
  return data;
}
