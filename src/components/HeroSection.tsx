import { motion } from "framer-motion";
import { useEffect, useState } from "react";
import { Terminal, ChevronRight, ExternalLink } from "lucide-react";

const lines = [
  "$ whoami",
  "> Danylo Alves de Oliveira — SRE / Senior Infrastructure Engineer",
  "$ cat slo-status.json | jq '.availability'",
  "> 99.94%  ✓ within error budget",
  "$ kubectl top nodes",
  "> eks-prod-node-01   CPU 42%   MEM 61%   READY",
  "$ curl -s /metrics | grep slo_burn_rate",
  "> slo_burn_rate{env=\"prod\"} 0.31  — nominal",
  "$ uptime --sre",
  "> 5+ anos · incident response · post-mortem · SLI/SLO/SLA",
];

const TypingText = ({ text, delay }: { text: string; delay: number }) => {
  const [displayed, setDisplayed] = useState("");
  const [done, setDone] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => {
      let i = 0;
      const speed = text.startsWith(">") ? 14 : 28;
      const iv = setInterval(() => {
        setDisplayed(text.slice(0, i + 1));
        i++;
        if (i >= text.length) { clearInterval(iv); setDone(true); }
      }, speed);
      return () => clearInterval(iv);
    }, delay);
    return () => clearTimeout(t);
  }, [text, delay]);
  return (
    <span className={text.startsWith(">") ? "text-primary" : text.startsWith("$") ? "text-accent" : "text-foreground"}>
      {displayed}
      {!done && <span className="terminal-cursor text-primary">▊</span>}
    </span>
  );
};

const StatusBadge = ({ label, value, color }: { label: string; value: string; color: string }) => (
  <div className="flex flex-col items-center p-3 rounded-lg border bg-card/60" style={{ borderColor: `${color}25` }}>
    <span className="text-lg font-display font-bold" style={{ color }}>{value}</span>
    <span className="text-[10px] font-mono text-muted-foreground mt-0.5">{label}</span>
  </div>
);

const HeroSection = () => (
  <section className="relative min-h-screen flex items-center justify-center overflow-hidden">
    <div className="absolute inset-0 grid-bg opacity-40" />
    <div className="absolute inset-0 scanline" />
    <motion.div className="absolute top-1/4 left-1/4 w-80 h-80 rounded-full blur-3xl"
      style={{ backgroundColor: "hsl(38 92% 50% / 0.05)" }}
      animate={{ x: [0, 35, 0], y: [0, -20, 0] }}
      transition={{ duration: 9, repeat: Infinity, ease: "easeInOut" }} />
    <motion.div className="absolute bottom-1/4 right-1/4 w-96 h-96 rounded-full blur-3xl"
      style={{ backgroundColor: "hsl(217 91% 60% / 0.05)" }}
      animate={{ x: [0, -40, 0], y: [0, 30, 0] }}
      transition={{ duration: 12, repeat: Infinity, ease: "easeInOut" }} />
    <div className="container relative z-10 px-6">
      <motion.div initial={{ opacity: 0, y: 30 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.8 }}
        className="max-w-3xl mx-auto">
        <div className="rounded-xl border border-border bg-card/80 backdrop-blur-sm overflow-hidden box-glow">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-border bg-secondary/60">
            <div className="w-3 h-3 rounded-full bg-destructive/70" />
            <div className="w-3 h-3 rounded-full bg-primary/50" />
            <div className="w-3 h-3 rounded-full bg-green-500/70" />
            <span className="ml-2 text-xs font-mono text-muted-foreground flex items-center gap-1.5">
              <Terminal size={11} /> sre@prod-cluster:~
            </span>
            <div className="ml-auto flex items-center gap-1.5">
              <div className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
              <span className="text-[10px] font-mono text-green-400/80">SLO HEALTHY</span>
            </div>
          </div>
          <div className="p-5 font-mono text-sm leading-loose space-y-0.5">
            {lines.map((l, i) => <div key={i}><TypingText text={l} delay={i * 1150} /></div>)}
          </div>
        </div>
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 10, duration: 0.8 }}
          className="mt-6 grid grid-cols-4 gap-3">
          <StatusBadge label="Availability" value="99.9%" color="#22c55e" />
          <StatusBadge label="MTTR" value="11min" color="#f59e0b" />
          <StatusBadge label="Error Budget" value="68%" color="#3b82f6" />
          <StatusBadge label="Incidents/mo" value="2" color="#a78bfa" />
        </motion.div>
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 11, duration: 1 }}
          className="mt-8 text-center">
          <h1 className="text-4xl md:text-6xl font-display font-bold mb-3">
            <span className="gradient-text">Danylo</span>{" "}
            <span className="text-foreground">Oliveira</span>
          </h1>
          <p className="text-muted-foreground text-base md:text-lg mb-1">
            Site Reliability Engineer · Senior Infrastructure Engineer
          </p>
          <p className="text-muted-foreground/60 text-sm font-mono mb-8">
            Reliability is a feature. Uptime is a commitment.
          </p>
          <div className="flex items-center justify-center gap-4 flex-wrap">
            <motion.a href="#slo" whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}
              className="inline-flex items-center gap-2 px-6 py-3 rounded-lg bg-primary text-primary-foreground font-medium box-glow">
              Ver SLOs <ChevronRight size={16} />
            </motion.a>
            <motion.a href="https://www.linkedin.com/in/danylo-oliveira-ti/" target="_blank" rel="noopener noreferrer"
              whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}
              className="inline-flex items-center gap-2 px-6 py-3 rounded-lg border border-border bg-card/50 text-foreground font-medium hover:border-glow transition-all">
              <ExternalLink size={15} className="text-primary" /> LinkedIn
            </motion.a>
          </div>
        </motion.div>
      </motion.div>
    </div>
  </section>
);

export default HeroSection;
