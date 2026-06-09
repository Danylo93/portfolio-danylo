import { motion, useInView } from "framer-motion";
import { useRef } from "react";

interface SLOItem { label: string; target: number; current: number; errorBudgetPct: number; window: string; color: string; }

const slos: SLOItem[] = [
  { label: "Availability", target: 99.9, current: 99.94, errorBudgetPct: 68, window: "30 days", color: "#22c55e" },
  { label: "Latency P99",  target: 99.5, current: 99.61, errorBudgetPct: 78, window: "30 days", color: "#3b82f6" },
  { label: "Error Rate",   target: 99.8, current: 99.85, errorBudgetPct: 55, window: "30 days", color: "#f59e0b" },
  { label: "Throughput",   target: 99.7, current: 99.72, errorBudgetPct: 82, window: "30 days", color: "#a78bfa" },
];

const burnRates = [
  { label: "1h burn rate",  value: 0.31, threshold: 14.4, color: "#22c55e" },
  { label: "6h burn rate",  value: 1.2,  threshold: 6.0,  color: "#22c55e" },
  { label: "24h burn rate", value: 0.8,  threshold: 3.0,  color: "#f59e0b" },
  { label: "72h burn rate", value: 0.5,  threshold: 1.0,  color: "#22c55e" },
];

const GaugeMeter = ({ slo, index }: { slo: SLOItem; index: number }) => {
  const ref = useRef<SVGCircleElement>(null);
  const inView = useInView(ref as React.RefObject<Element>, { once: true });
  const r = 52; const c = 2 * Math.PI * r;
  const currentOffset = c - (slo.current / 100) * c;
  const targetOffset  = c - (slo.target  / 100) * c;
  const statusColor = slo.current >= slo.target ? "#22c55e" : "#ef4444";
  const statusText  = slo.current >= slo.target ? "✓ SLO Met" : "✗ SLO Breached";
  return (
    <motion.div initial={{ opacity: 0, y: 30 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}
      transition={{ delay: index * 0.12 }}
      className="p-5 rounded-xl border bg-card/60 backdrop-blur-sm flex flex-col items-center gap-4"
      style={{ borderColor: `${slo.color}20` }}>
      <div className="relative">
        <svg width="140" height="140" viewBox="0 0 140 140">
          <circle cx="70" cy="70" r={r} fill="none" stroke="hsl(222 20% 14%)" strokeWidth="10" />
          <circle cx="70" cy="70" r={r} fill="none" stroke={`${slo.color}25`} strokeWidth="10"
            strokeDasharray={c} strokeDashoffset={targetOffset} strokeLinecap="round"
            style={{ transformOrigin: "70px 70px", transform: "rotate(-90deg)" }} />
          <motion.circle ref={ref} cx="70" cy="70" r={r} fill="none"
            stroke={slo.color} strokeWidth="10" strokeLinecap="round"
            strokeDasharray={c}
            initial={{ strokeDashoffset: c }}
            animate={inView ? { strokeDashoffset: currentOffset } : { strokeDashoffset: c }}
            transition={{ duration: 2, delay: index * 0.12 + 0.3, ease: "easeOut" }}
            style={{ transformOrigin: "70px 70px", transform: "rotate(-90deg)",
              filter: `drop-shadow(0 0 6px ${slo.color}80)` }} />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-2xl font-display font-bold" style={{ color: slo.color }}>{slo.current}%</span>
          <span className="text-[10px] font-mono text-muted-foreground">target {slo.target}%</span>
        </div>
      </div>
      <div className="text-center">
        <div className="font-display font-semibold text-foreground text-sm">{slo.label}</div>
        <div className="text-[11px] font-mono mt-0.5" style={{ color: statusColor }}>{statusText}</div>
      </div>
      <div className="w-full">
        <div className="flex justify-between text-[10px] font-mono mb-1.5">
          <span className="text-muted-foreground">Error Budget Remaining</span>
          <span style={{ color: slo.color }}>{slo.errorBudgetPct}%</span>
        </div>
        <div className="h-1.5 rounded-full bg-border overflow-hidden">
          <motion.div className="h-full rounded-full" style={{ backgroundColor: slo.color }}
            initial={{ width: 0 }}
            whileInView={{ width: `${slo.errorBudgetPct}%` }}
            viewport={{ once: true }}
            transition={{ duration: 1.2, delay: index * 0.12 + 0.5, ease: "easeOut" }} />
        </div>
        <div className="text-[10px] font-mono text-muted-foreground mt-1">Window: {slo.window}</div>
      </div>
    </motion.div>
  );
};

const SLODashboard = () => (
  <section id="slo" className="py-24 relative">
    <div className="absolute inset-0 grid-bg opacity-20" />
    <div className="container relative px-6">
      <motion.div initial={{ opacity: 0, y: 40 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}
        className="text-center mb-16">
        <span className="font-mono text-primary text-sm">// service level objectives</span>
        <h2 className="text-3xl md:text-4xl font-display font-bold mt-2">
          SLO <span className="gradient-text">Dashboard</span>
        </h2>
        <p className="text-muted-foreground mt-3 text-sm font-mono">Últimos 30 dias · ambiente production</p>
      </motion.div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-5 max-w-4xl mx-auto">
        {slos.map((slo, i) => <GaugeMeter key={slo.label} slo={slo} index={i} />)}
      </div>
      <motion.div initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}
        transition={{ delay: 0.5 }}
        className="mt-10 max-w-2xl mx-auto p-5 rounded-xl border border-border bg-card/50">
        <div className="text-xs font-mono text-primary mb-4">// burn rate alerts · multi-window</div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {burnRates.map(br => (
            <div key={br.label} className="text-center p-3 rounded-lg border"
              style={{ borderColor: `${br.color}20`, backgroundColor: `${br.color}08` }}>
              <div className="text-lg font-display font-bold" style={{ color: br.color }}>{br.value}x</div>
              <div className="text-[10px] font-mono text-muted-foreground mt-0.5">{br.label}</div>
              <div className="text-[10px] font-mono mt-1" style={{ color: `${br.color}80` }}>/{br.threshold}x</div>
            </div>
          ))}
        </div>
        <p className="text-[11px] text-muted-foreground font-mono mt-3 text-center">
          Alertas configurados via Prometheus AlertManager + PagerDuty
        </p>
      </motion.div>
    </div>
  </section>
);

export default SLODashboard;
