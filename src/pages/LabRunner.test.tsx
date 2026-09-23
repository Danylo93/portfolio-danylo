import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import LabRunner from "./LabRunner";
import { loadProgress } from "@/labs/data";

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
