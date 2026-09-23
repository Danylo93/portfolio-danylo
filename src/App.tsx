import { lazy, Suspense } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import Index from "./pages/Index.tsx";
import NotFound from "./pages/NotFound.tsx";

const Labs = lazy(() => import("./pages/Labs.tsx"));
const LabRunner = lazy(() => import("./pages/LabRunner.tsx"));
const LessonView = lazy(() => import("./pages/LessonView.tsx"));

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <Suspense fallback={<div role="status" className="min-h-screen grid place-items-center bg-background text-primary font-mono">Carregando laboratório…</div>}>
          <Routes>
            <Route path="/" element={<Index />} />
            <Route path="/labs" element={<Labs />} />
            <Route path="/labs/learn/:id" element={<LessonView />} />
            <Route path="/labs/:id" element={<LabRunner />} />
            {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
            <Route path="*" element={<NotFound />} />
          </Routes>
        </Suspense>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;

