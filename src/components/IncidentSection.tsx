import { motion } from "framer-motion";
import { useEffect, useState } from "react";
import { Bell, UserCheck, Zap, CheckCircle, FileText, Search } from "lucide-react";

const phases = [
  { id: "detect",      label: "DETECT",      time: "T+0",    Icon: Bell,        desc: "Alert fires",     detail: "Prometheus threshold + burn rate alert via AlertManager", color: "#ef4444" },
  { id: "page",        label: "PAGE",        time: "T+2min", Icon: Bell,        desc: "On-call paged",  detail: "PagerDuty escalation policy · P1 high urgency", color: "#f97316" },
  { id: "ack",         label: "ACK",         time: "T+5min", Icon: UserCheck,   desc: "Acknowledged",   detail: "War room aberta · stakeholders notificados no Slack", color: "#f59e0b" },
  { id: "investigate", label: "INVESTIGATE", time: "T+7min", Icon: Search,      desc: "Root cause",     detail: "Grafana + kubectl logs + distributed traces (Datadog APM)", color: "#3b82f6" },
  { id: "mitigate",    label: "MITIGATE",    time: "T+11min",Icon: Zap,         desc: "Service restored",detail: "kubectl rollout undo · HPA ajustado · SLO restaurado", color: "#22c55e" },
  { id: "resolve",     label: "RESOLVE",     time: "T+15min",Icon: CheckCircle, desc: "Fully resolved", detail: "Causa raiz confirmada · stakeholders atualizados", color: "#22c55e" },
  { id: "postmortem",  label: "POST-MORTEM", time: "T+24h",  Icon: FileText,    desc: "Blameless review",detail: "Timeline · contributing factors · action items · prevention", color: "#a78bfa" },
];

const metrics = [
  { label: "MTTD", value: "2min",  sub: "Mean Time To Detect",         color: "#ef4444" },
  { label: "MTTA", value: "5min",  sub: "Mean Time To Ack",             color: "#f59e0b" },
  { label: "MTTR", value: "11min", sub: "Mean Time To Restore",         color: "#22c55e" },
  { label: "MTBF", value: "18d",   sub: "Mean Time Between Failures",   color: "#3b82f6" },
];

const IncidentSection = () => {
  const [active, setActive] = useState(0);
  useEffect(() => { const iv = setInterval(() => setActive(p => (p + 1) % phases.length), 1800); return () => clearInterval(iv); }, []);
  return (
    <section id="incident" className="py-24 relative overflow-hidden">
      <div className="container relative px-6">
        <motion.div initial={{ opacity: 0, y: 40 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}
          className="text-center mb-16">
          <span className="font-mono text-primary text-sm">// incident response</span>
          <h2 className="text-3xl md:text-4xl font-display font-bold mt-2">
            Incident <span className="gradient-text">Lifecycle</span>
          </h2>
          <p className="text-muted-foreground mt-3 text-sm font-mono">
            Blameless culture · war room · post-mortem · action items
          </p>
        </motion.div>
        <div className="overflow-x-auto pb-4">
          <div className="flex items-start justify-start md:justify-center min-w-max md:min-w-0 gap-0 mx-auto">
            {phases.map((phase, i) => (
              <div key={phase.id} className="flex items-center">
                <motion.div initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}
                  transition={{ delay: i * 0.09 }} className="flex flex-col items-center w-[110px] md:w-[118px]">
                  <motion.div
                    animate={{ borderColor: active === i ? phase.color : `${phase.color}25`, boxShadow: active === i ? `0 0 18px ${phase.color}45` : "none" }}
                    className="w-[90px] h-[90px] rounded-xl border-2 bg-card/80 backdrop-blur-sm flex flex-col items-center justify-center gap-1.5 cursor-default">
                    <phase.Icon size={20} style={{ color: active === i ? phase.color : `${phase.color}60` }} />
                    <span className="text-[10px] font-mono font-bold tracking-wider text-center px-1"
                      style={{ color: active === i ? phase.color : `${phase.color}70` }}>{phase.label}</span>
                    {active === i && (
                      <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                        className="text-[9px] font-mono" style={{ color: phase.color }}>{phase.time}</motion.span>
                    )}
                  </motion.div>
                  <div className="mt-2 text-center px-1">
                    <div className="text-[10px] font-mono font-medium" style={{ color: `${phase.color}90` }}>{phase.time}</div>
                    <div className="text-[10px] text-muted-foreground mt-0.5 leading-tight">{phase.desc}</div>
                  </div>
                </motion.div>
                {i < phases.length - 1 && (
                  <div className="relative flex-shrink-0 flex items-center w-7 h-8">
                    <div className="w-full h-px bg-border" />
                    <motion.div className="absolute top-1/2 -mt-1 w-1.5 h-1.5 rounded-full"
                      style={{ backgroundColor: phases[i+1].color, boxShadow: `0 0 6px ${phases[i+1].color}` }}
                      animate={{ left: [0, 24] }}
                      transition={{ duration: 0.8, repeat: Infinity, delay: i * 0.3, ease: "linear", repeatDelay: 1.5 }} />
                    <div className="absolute right-0 top-1/2 -mt-1" style={{
                      width: 0, height: 0,
                      borderTop: "4px solid transparent", borderBottom: "4px solid transparent",
                      borderLeft: `5px solid ${phases[i+1].color}50`,
                    }} />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
        <motion.div key={active} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}
          className="mt-6 max-w-lg mx-auto p-4 rounded-xl border bg-card/60 text-center"
          style={{ borderColor: `${phases[active].color}30` }}>
          <span className="text-[10px] font-mono" style={{ color: phases[active].color }}>{phases[active].label} · {phases[active].time}</span>
          <p className="text-sm text-muted-foreground mt-1 font-mono">{phases[active].detail}</p>
        </motion.div>
        <motion.div initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}
          transition={{ delay: 0.4 }} className="mt-10 grid grid-cols-2 md:grid-cols-4 gap-4 max-w-2xl mx-auto">
          {metrics.map(m => (
            <div key={m.label} className="p-4 rounded-xl border bg-card/50 text-center" style={{ borderColor: `${m.color}20` }}>
              <div className="text-2xl font-display font-bold" style={{ color: m.color }}>{m.value}</div>
              <div className="text-[10px] font-mono font-bold mt-0.5" style={{ color: m.color }}>{m.label}</div>
              <div className="text-[9px] text-muted-foreground mt-0.5 leading-tight">{m.sub}</div>
            </div>
          ))}
        </motion.div>
      </div>
    </section>
  );
};

export default IncidentSection;
