import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { COMMANDS, KUBECTL_SUBS, Shell } from "./shell";

type Line = { kind: "in" | "out" | "sys"; text: string };

export type TerminalHandle = { insert: (cmd: string) => void; focus: () => void };

const PROMPT = "danylo@lab-control-plane:~/project$";

const Terminal = forwardRef<TerminalHandle, { shell: Shell; banner: string; onCommand?: () => void }>(
  ({ shell, banner, onCommand }, ref) => {
    const [lines, setLines] = useState<Line[]>([{ kind: "sys", text: banner }]);
    const [input, setInput] = useState("");
    const [hist, setHist] = useState<string[]>([]);
    const [hIdx, setHIdx] = useState(-1);
    const inputRef = useRef<HTMLInputElement>(null);
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

    const run = () => {
      const cmd = input;
      setInput("");
      setHIdx(-1);
      if (cmd.trim()) setHist((h) => [...h, cmd]);
      const res = shell.exec(cmd);
      if (res.clear) setLines([]);
      else setLines((l) => [...l, { kind: "in", text: cmd }, ...(res.output ? [{ kind: "out" as const, text: res.output }] : [])]);
      onCommand?.();
    };

    const complete = () => {
      const parts = input.split(" ");
      if (parts.length === 1) {
        const hits = COMMANDS.filter((c) => c.startsWith(parts[0]));
        if (hits.length === 1) setInput(hits[0] + " ");
        else if (hits.length > 1) setLines((l) => [...l, { kind: "in", text: input }, { kind: "out", text: hits.join("  ") }]);
        return;
      }
      if (parts.length === 2 && (parts[0] === "kubectl" || parts[0] === "k")) {
        const hits = KUBECTL_SUBS.filter((c) => c.startsWith(parts[1]));
        if (hits.length === 1) setInput(`${parts[0]} ${hits[0]} `);
        return;
      }
      // complete resource names (pods, deployments, files)
      const last = parts[parts.length - 1];
      const names = [
        ...shell.state.pods.map((p) => p.name),
        ...shell.state.deployments.map((d) => d.name),
        ...Object.keys(shell.state.files),
      ];
      const hits = Array.from(new Set(names.filter((n) => last && n.startsWith(last))));
      if (hits.length === 1) setInput([...parts.slice(0, -1), hits[0]].join(" "));
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
        setLines((l) => [...l, { kind: "in", text: input + "^C" }]);
        setInput("");
      }
    };

    return (
      <div
        className="h-full flex flex-col rounded-lg border border-border bg-[#0b0f14] overflow-hidden"
        onClick={() => {
          if (!window.getSelection()?.toString()) inputRef.current?.focus();
        }}
      >
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-[#0f141b] shrink-0">
          <span className="w-2.5 h-2.5 rounded-full bg-red-500/80" />
          <span className="w-2.5 h-2.5 rounded-full bg-yellow-500/80" />
          <span className="w-2.5 h-2.5 rounded-full bg-green-500/80" />
          <span className="ml-2 text-[11px] font-mono text-muted-foreground">Terminal · kind-lab</span>
          <span className="ml-auto flex items-center gap-1.5 text-[10px] font-mono text-green-400/80">
            <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" /> connected
          </span>
        </div>
        <div ref={scrollRef} className="flex-1 overflow-auto p-3 font-mono text-[12.5px] leading-relaxed">
          {lines.map((l, i) =>
            l.kind === "in" ? (
              <div key={i} className="whitespace-pre-wrap break-all">
                <span className="text-green-400">{PROMPT}</span> <span className="text-foreground">{l.text}</span>
              </div>
            ) : (
              <pre key={i} className={`whitespace-pre-wrap break-words ${l.kind === "sys" ? "text-cyan-300/80" : "text-slate-300"}`}>
                {l.text}
              </pre>
            ),
          )}
          <div className="flex items-center">
            <span className="text-green-400 whitespace-nowrap">{PROMPT}</span>
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKey}
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
              autoFocus
              aria-label="Entrada do terminal"
              className="flex-1 min-w-0 ml-2 bg-transparent outline-none text-foreground caret-green-400"
            />
          </div>
        </div>
      </div>
    );
  },
);

Terminal.displayName = "Terminal";
export default Terminal;
