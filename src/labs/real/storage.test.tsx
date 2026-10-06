import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LABS } from "../data";
import { realRequest } from "./client";
import RealLabRunner from "./RealLabRunner";
import { clearRealAttempt, loadRealAttempt, saveRealAttempt } from "./storage";

vi.mock("./client", () => ({ realRequest: vi.fn() }));
const lab = LABS.find((l) => l.id === "k8s-first-pod")!;
const session = { id: "abcdef0123456789abcdef01", labId: "k8s-first-pod", namespace: "dlab-test", passed: [] };
const status = { token: "server-token", context: "kind-danylo-lab", connected: true, nodes: ["node"] };
const saved = { version: 1 as const, labId: lab.id, sessionId: session.id, lines: ["Previous terminal output"], history: ["kubectl get pods"], input: "kubectl logs nginx", hint: true };
const show = () => render(<MemoryRouter><RealLabRunner lab={lab} /></MemoryRouter>);

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); vi.mocked(realRequest).mockReset(); Element.prototype.scrollTo = vi.fn(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("retoma a referência do localStorage e preserva o terminal sem repetir comandos reais", async () => {
  saveRealAttempt(saved);
  vi.mocked(realRequest).mockResolvedValueOnce(status).mockResolvedValueOnce(session);
  show();
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Entrada do terminal real" })).toHaveValue("kubectl logs nginx"));
  expect(screen.getByLabelText("Saída do terminal")).toHaveTextContent("Previous terminal output");
  expect(realRequest).toHaveBeenCalledWith("resume", status.token, { sessionId: session.id });
  expect(vi.mocked(realRequest).mock.calls.map(([path]) => path)).toEqual(["status", "resume"]);
  expect(JSON.stringify(loadRealAttempt("k8s-first-pod"))).not.toContain(status.token);
});

it("uma falha temporária preserva a referência e oferece reconexão", async () => {
  saveRealAttempt(saved);
  vi.mocked(realRequest).mockResolvedValueOnce(status).mockRejectedValueOnce(new Error("temporary network failure"));
  show();
  await waitFor(() => expect(screen.getByRole("button", { name: "Tentar reconectar" })).toBeInTheDocument());
  expect(loadRealAttempt("k8s-first-pod")?.sessionId).toBe(session.id);
  expect(screen.queryByRole("button", { name: "Iniciar lab real" })).not.toBeInTheDocument();
});

it("limpa uma referência apenas quando o servidor confirma que ela não existe", async () => {
  saveRealAttempt(saved);
  vi.mocked(realRequest).mockResolvedValueOnce(status).mockRejectedValueOnce(new Error("Tentativa não encontrada. Inicie um novo lab."));
  show();
  await waitFor(() => expect(screen.getByRole("button", { name: "Iniciar lab real" })).toBeEnabled());
  expect(loadRealAttempt("k8s-first-pod")).toBeNull();
});

it("encerrar remove a referência depois da limpeza confirmada pelo servidor", async () => {
  saveRealAttempt(saved);
  vi.mocked(realRequest).mockResolvedValueOnce(status).mockResolvedValueOnce(session).mockResolvedValueOnce({});
  vi.spyOn(window, "confirm").mockReturnValue(true);
  show();
  await waitFor(() => expect(screen.getByRole("button", { name: "Encerrar e limpar" })).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: "Encerrar e limpar" }));
  await waitFor(() => expect(loadRealAttempt("k8s-first-pod")).toBeNull());
  expect(realRequest).toHaveBeenCalledWith("stop", status.token, { sessionId: session.id });
});

it("migra a referência legada sem perder a tentativa e ignora conteúdo inválido", () => {
  sessionStorage.setItem(`danylo-real-session:${lab.id}`, session.id);
  expect(loadRealAttempt("k8s-first-pod")?.sessionId).toBe(session.id);
  expect(clearRealAttempt(lab.id)).toBe(true);
  expect(loadRealAttempt("k8s-first-pod")).toBeNull();
  sessionStorage.setItem(`danylo-real-session:${lab.id}`, "invalid");
  expect(loadRealAttempt("k8s-first-pod")).toBeNull();
});
