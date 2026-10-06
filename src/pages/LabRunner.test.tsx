import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import LabRunner from "./LabRunner";
import { loadProgress } from "@/labs/data";
import { LABS } from "@/labs/data";
import { loadLabSession } from "@/labs/session";

const show = (id: string) => render(<MemoryRouter initialEntries={[`/labs/${id}`]}><Routes>
  <Route path="/labs/:id" element={<LabRunner />} />
</Routes></MemoryRouter>);
const command = (value: string) => {
  const input = screen.getByRole("textbox", { name: "Entrada do terminal" });
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: "Enter" });
};

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.scrollTo = vi.fn();
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

it("starts timing only after Iniciar and records completion only after all checks", () => {
  render(<MemoryRouter initialEntries={["/labs/k8s-cluster-explore"]}><Routes>
    <Route path="/labs/:id" element={<LabRunner />} />
  </Routes></MemoryRouter>);
  act(() => { vi.advanceTimersByTime(3000); });
  expect(screen.getByText("00:00")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /^Iniciar$/ }));
  act(() => { vi.advanceTimersByTime(1000); });
  expect(screen.getByText("00:01")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Verificar" }));
  expect(loadProgress()).toEqual([]);
  for (const [i, command] of ["kubectl config current-context", "kubectl cluster-info", "kubectl get namespaces"].entries()) {
    const terminal = screen.getByRole("textbox", { name: "Entrada do terminal" });
    fireEvent.change(terminal, { target: { value: command } });
    fireEvent.keyDown(terminal, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Verificar" }));
    if (i < 2) {
      expect(loadProgress()).toEqual([]);
      fireEvent.click(screen.getByRole("button", { name: /Próximo passo/ }));
      act(() => { vi.advanceTimersByTime(500); });
    }
  }
  expect(loadProgress()).toContain("k8s-cluster-explore");
});

it("retoma o container, passo, tempo, histórico e comando em digitação", () => {
  const view = show("docker-basics");
  fireEvent.click(screen.getByRole("button", { name: "Iniciar" }));
  command("docker pull nginx:alpine");
  fireEvent.click(screen.getByRole("button", { name: "Verificar" }));
  fireEvent.click(screen.getByRole("button", { name: /Próximo passo/ }));
  command("docker run -d -p 8080:80 --name web nginx:alpine");
  act(() => vi.advanceTimersByTime(5000));
  fireEvent.change(screen.getByRole("textbox", { name: "Entrada do terminal" }), { target: { value: "docker ps" } });
  view.unmount(); show("docker-basics");
  expect(screen.getByText("Passo 2 de 3")).toBeInTheDocument();
  expect(screen.getByText("00:05")).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Entrada do terminal" })).toHaveValue("docker ps");
  fireEvent.click(screen.getByRole("button", { name: "Verificar" }));
  expect(screen.getByRole("button", { name: /Próximo passo/ })).toBeInTheDocument();
  const saved = loadLabSession(LABS.find((l) => l.id === "docker-basics")!)!;
  expect(saved.shell.state.containers.find((c) => c.name === "web")!.status).toBe("running");
  expect(saved.passed).toEqual([0, 1]);
});

it("retoma um rascunho de kubectl edit e salva no recurso correto", () => {
  const view = show("k8s-deploy");
  fireEvent.click(screen.getByRole("button", { name: "Iniciar" }));
  command("kubectl create deployment web --image=nginx:1.25");
  command("kubectl edit deployment web");
  const editor = screen.getByRole("textbox", { name: /^Editando / });
  const draft = (editor as HTMLTextAreaElement).value.replace("replicas: 1", "replicas: 3");
  fireEvent.change(editor, { target: { value: draft } });
  view.unmount(); show("k8s-deploy");
  const resumed = screen.getByRole("textbox", { name: /^Editando / });
  expect(resumed).toHaveValue(draft);
  fireEvent.keyDown(resumed, { key: "s", ctrlKey: true });
  expect(loadLabSession(LABS.find((l) => l.id === "k8s-deploy")!)!.shell.state.deployments.find((d) => d.name === "web")!.replicas).toBe(3);
});

it("reiniciar limpa a tentativa salva sem apagar os labs concluídos", () => {
  localStorage.setItem("danylo-labs-progress", '["k8s-cluster-explore"]');
  const view = show("docker-basics");
  fireEvent.click(screen.getByRole("button", { name: "Iniciar" }));
  command("docker pull nginx:alpine");
  vi.spyOn(window, "confirm").mockReturnValue(true);
  fireEvent.click(screen.getByTitle("Reiniciar ambiente"));
  expect(screen.getByRole("button", { name: "Iniciar" })).toBeInTheDocument();
  expect(loadLabSession(LABS.find((l) => l.id === "docker-basics")!)!.shell.state.images).toEqual([]);
  expect(loadProgress()).toContain("k8s-cluster-explore");
  view.unmount(); show("docker-basics");
  expect(screen.getByRole("button", { name: "Iniciar" })).toBeInTheDocument();
});
