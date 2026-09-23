import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { getTool } from "./registry";
import type { Shell } from "./shell";
import type { EditRequest } from "./types";

type Line = { kind: "in" | "out" | "sys"; text: string; prompt?: string };

export type TerminalHandle = { insert: (cmd: string) => void; focus: () => void };

const Terminal = forwardRef<TerminalHandle, { shell: Shell; banner: string; onCommand?: () => void }>(
  ({ shell, banner, onCommand }, ref) => {
    const [lines, setLines] = useState<Line[]>([{ kind: "sys", text: banner }]);
    const [input, setInput] = useState("");
    const [hist, setHist] = useState<string[]>([]);
    const [hIdx, setHIdx] = useState(-1);
    const [editing, setEditing] = useState<EditRequest | null>(null);
    const [draft, setDraft] = useState("");
    const inputRef = useRef<HTMLInputElement>(null);
    const editorRef = useRef<HTMLTextAreaElement>(null);
    const scrollRef = useRef<HTMLDivElement>(null);

    useImperativeHandle(ref, () => ({
      insert: (cmd) => {
        setInput(cmd);
        inputRef.current?.focus();
      },
      focus: () => inputRef.current?.focus(),
    }));

    useEffect(() => {
      setLines([{ kind: "sys", text: banner }]);
    }, [shell, banner]);

    useEffect(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    }, [lines]);

    useEffect(() => {
      if (editing) setTimeout(() => editorRef.current?.focus(), 0);
    }, [editing]);

    const run = () => {
      const cmd = input;
      const prompt = shell.prompt();
      setInput("");
      setHIdx(-1);
      if (cmd.trim()) setHist((h) => [...h, cmd]);
      const res = shell.exec(cmd);
      if (res.clear) setLines([]);
      else setLines((l) => [...l, { kind: "in", text: cmd, prompt }, ...(res.output ? [{ kind: "out" as const, text: res.output }] : [])]);
      if (res.edit) {
        setEditing(res.edit);
        setDraft(res.edit.content);
      }
      onCommand?.();
    };

    const closeEditor = (save: boolean) => {
      if (!editing) return;
      if (save) {
        const out = shell.saveEdit(editing.path, draft);
        setLines((l) => [...l, { kind: "out", text: out }]);
        onCommand?.();
      } else setLines((l) => [...l, { kind: "out", text: `(saiu sem salvar: ${editing.path})` }]);
      setEditing(null);
      setTimeout(() => inputRef.current?.focus(), 0);
    };

    const complete = () => {
      const parts = input.split(" ");
      const last = parts[parts.length - 1];
      let options: string[];
      if (parts.length === 1) options = shell.commandNames();
      else if (parts.length === 2 && getTool(parts[0])?.subcommands) options = Object.keys(getTool(parts[0])!.subcommands!);
      else {
        const dir = last.includes("/") ? last.slice(0, last.lastIndexOf("/") + 1) : "";
        const files = shell.isDir(dir || ".") ? shell.listDir(dir || ".").map((f) => dir + f) : [];
        options = [
          ...shell.state.pods.map((p) => p.name),
          ...shell.state.deployments.map((d) => d.name),
          ...shell.state.services.map((s) => s.name),
          ...shell.state.nodes.map((n) => n.name),
          ...shell.state.objects.map((o) => o.name),
          ...files,
        ];
      }
      const hits = Array.from(new Set(options.filter((n) => last && n.startsWith(last))));
      if (hits.length === 1) setInput([...parts.slice(0, -1), hits[0]].join(" ") + (hits[0].endsWith("/") ? "" : " "));
      else if (hits.length > 1) {
        const prefix = hits.reduce((a, b) => {
          let i = 0;
          while (i < a.length && a[i] === b[i]) i++;
          return a.slice(0, i);
        });
        if (prefix.length > last.length) setInput([...parts.slice(0, -1), prefix].join(" "));
        else setLines((l) => [...l, { kind: "in", text: input, prompt: shell.prompt() }, { kind: "out", text: hits.slice(0, 30).join("  ") }]);
      }
    };

    const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") run();
      else if (e.key === "Tab") {
        e.preventDefault();
        complete();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (!hist.length) return;
        const i = hIdx < 0 ? hist.length - 1 : Math.max(0, hIdx - 1);
        setHIdx(i);
        setInput(hist[i]);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        if (hIdx < 0) return;
        const i = hIdx + 1;
        if (i >= hist.length) {
          setHIdx(-1);
          setInput("");
        } else {
          setHIdx(i);
          setInput(hist[i]);
        }
      } else if (e.key === "l" && e.ctrlKey) {
        e.preventDefault();
        setLines([]);
      } else if (e.key === "c" && e.ctrlKey && !window.getSelection()?.toString()) {
        e.preventDefault();
        setLines((l) => [...l, { kind: "in", text: input + "^C", prompt: shell.prompt() }]);
        setInput("");
      }
    };

    const onEditorKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        closeEditor(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        closeEditor(false);
      } else if (e.key === "Tab") {
        e.preventDefault();
        const el = e.currentTarget;
        const { selectionStart: s, selectionEnd: en } = el;
        const next = draft.slice(0, s) + "  " + draft.slice(en);
        setDraft(next);
        setTimeout(() => el.setSelectionRange(s + 2, s + 2), 0);
      }
    };

    return (
      <div
        className="relative h-full flex flex-col rounded-lg border border-border bg-[#0b0f14] overflow-hidden"
        onClick={() => {
          if (!editing && !window.getSelection()?.toString()) inputRef.current?.focus();
        }}
      >
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-[#0f141b] shrink-0">
          <span className="w-2.5 h-2.5 rounded-full bg-red-500/80" />
          <span className="w-2.5 h-2.5 rounded-full bg-yellow-500/80" />
          <span className="w-2.5 h-2.5 rounded-full bg-green-500/80" />
          <span className="ml-2 text-[11px] font-mono text-muted-foreground">Terminal · {shell.host}</span>
          <span className="ml-auto flex items-center gap-1.5 text-[10px] font-mono text-green-400/80">
            <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" /> connected
          </span>
        </div>
        <div ref={scrollRef} className="flex-1 overflow-auto p-3 font-mono text-[12.5px] leading-relaxed">
          {lines.map((l, i) =>
            l.kind === "in" ? (
              <div key={i} className="whitespace-pre-wrap break-all">
                <span className="text-green-400">{l.prompt}</span> <span className="text-foreground">{l.text}</span>
              </div>
            ) : (
              <pre key={i} className={`whitespace-pre-wrap break-words ${l.kind === "sys" ? "text-cyan-300/80" : "text-slate-300"}`}>
                {l.text}
              </pre>
            ),
          )}
          <div className="flex items-center">
            <span className="text-green-400 whitespace-nowrap">{shell.prompt()}</span>
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKey}
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
              autoFocus
              disabled={!!editing}
              aria-label="Entrada do terminal"
              className="flex-1 min-w-0 ml-2 bg-transparent outline-none text-foreground caret-green-400"
            />
          </div>
        </div>

        {editing && (
          <div className="absolute inset-0 z-10 flex flex-col bg-[#0b0f14]">
            <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-[#141b24] shrink-0 font-mono text-[11px]">
              <span className="text-yellow-300">EDITOR</span>
              <span className="text-foreground truncate">{editing.path}</span>
              <div className="ml-auto flex gap-1.5">
                <button onClick={() => closeEditor(true)} className="px-2 py-0.5 rounded bg-primary text-primary-foreground">Salvar (Ctrl+S)</button>
                <button onClick={() => closeEditor(false)} className="px-2 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground">Sair (Esc)</button>
              </div>
            </div>
            <div className="flex-1 min-h-0 flex overflow-auto">
              <pre aria-hidden className="select-none text-right pr-3 pl-2 py-2 font-mono text-[12.5px] leading-[1.6] text-muted-foreground/50">
                {draft.split("\n").map((_, i) => i + 1).join("\n")}
              </pre>
              <textarea
                ref={editorRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={onEditorKey}
                spellCheck={false}
                aria-label={`Editando ${editing.path}`}
                className="flex-1 min-h-full resize-none bg-transparent outline-none py-2 pr-3 font-mono text-[12.5px] leading-[1.6] text-slate-200 whitespace-pre"
              />
            </div>
            <div className="px-3 py-1 border-t border-border text-[10px] font-mono text-muted-foreground shrink-0">
              YAML usa espaços (Tab insere 2 espaços) · Ctrl+S salva · Esc sai sem salvar
            </div>
          </div>
        )}
      </div>
    );
  },
);

Terminal.displayName = "Terminal";
export default Terminal;
