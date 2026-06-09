import { motion } from "framer-motion";
import { BarChart3, FileText, GitMerge, Layers } from "lucide-react";

const pillars = [
  { Icon: BarChart3, title: "Metrics", subtitle: "What is happening?", color: "#f59e0b",
    tools: [
      { name: "Prometheus", desc: "Time-series metrics scraping" },
      { name: "Grafana", desc: "Dashboards & alerting" },
      { name: "CloudWatch", desc: "AWS native metrics" },
      { name: "Cloud Monitoring", desc: "GCP observability" },
      { name: "Datadog", desc: "SaaS observability platform" },
      { name: "Zabbix", desc: "Infrastructure monitoring" },
    ] },
  { Icon: FileText, title: "Logs", subtitle: "Why did it happen?", color: "#3b82f6",
    tools: [
      { name: "ELK Stack", desc: "Elasticsearch + Logstash + Kibana" },
      { name: "Loki", desc: "Log aggregation by Grafana" },
      { name: "Kibana", desc: "Log search & visualization" },
      { name: "CloudWatch Logs", desc: "AWS log management" },
      { name: "Datadog Logs", desc: "Unified log management" },
      { name: "Fluent Bit", desc: "Log forwarding agent" },
    ] },
  { Icon: GitMerge, title: "Traces", subtitle: "Where did it break?", color: "#a78bfa",
    tools: [
      { name: "OpenTelemetry", desc: "Vendor-neutral instrumentation" },
      { name: "Datadog APM", desc: "Distributed tracing + profiling" },
      { name: "Jaeger", desc: "Open-source tracing backend" },
      { name: "Zipkin", desc: "Distributed tracing system" },
      { name: "AWS X-Ray", desc: "AWS distributed tracing" },
      { name: "Grafana Tempo", desc: "Scalable trace backend" },
    ] },
];

const golden = [
  { label: "Latency",    desc: "How long requests take",         color: "#f59e0b" },
  { label: "Traffic",    desc: "How much demand on the system",   color: "#3b82f6" },
  { label: "Errors",     desc: "Rate of failed requests",         color: "#ef4444" },
  { label: "Saturation", desc: "How full the service is",         color: "#a78bfa" },
];

const ObservabilitySection = () => (
  <section id="observability" className="py-24 relative">
    <div className="absolute inset-0 grid-bg opacity-15" />
    <div className="container relative px-6">
      <motion.div initial={{ opacity: 0, y: 40 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}
        className="text-center mb-16">
        <span className="font-mono text-primary text-sm">// observabilidade</span>
        <h2 className="text-3xl md:text-4xl font-display font-bold mt-2">
          Observability <span className="gradient-text">Stack</span>
        </h2>
        <p className="text-muted-foreground mt-3 text-sm">Metrics · Logs · Traces — os três pilares da observabilidade</p>
      </motion.div>
      <motion.div initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}
        className="max-w-3xl mx-auto mb-12">
        <div className="text-xs font-mono text-primary mb-4 text-center">// 4 golden signals · Google SRE</div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {golden.map((g, i) => (
            <motion.div key={g.label} initial={{ opacity: 0, scale: 0.9 }} whileInView={{ opacity: 1, scale: 1 }}
              viewport={{ once: true }} transition={{ delay: i * 0.08 }} whileHover={{ y: -3 }}
              className="p-4 rounded-xl border text-center cursor-default"
              style={{ borderColor: `${g.color}25`, backgroundColor: `${g.color}08` }}>
              <div className="text-sm font-display font-bold" style={{ color: g.color }}>{g.label}</div>
              <div className="text-[10px] text-muted-foreground mt-1 leading-tight">{g.desc}</div>
            </motion.div>
          ))}
        </div>
      </motion.div>
      <div className="grid md:grid-cols-3 gap-6 max-w-5xl mx-auto">
        {pillars.map((pillar, pi) => (
          <motion.div key={pillar.title} initial={{ opacity: 0, y: 30 }} whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }} transition={{ delay: pi * 0.15 }}
            className="rounded-xl border overflow-hidden" style={{ borderColor: `${pillar.color}25` }}>
            <div className="px-5 py-4 border-b" style={{ borderColor: `${pillar.color}20`, backgroundColor: `${pillar.color}08` }}>
              <div className="flex items-center gap-2">
                <pillar.Icon size={18} style={{ color: pillar.color }} />
                <div>
                  <div className="font-display font-bold text-foreground">{pillar.title}</div>
                  <div className="text-[11px] font-mono" style={{ color: `${pillar.color}90` }}>{pillar.subtitle}</div>
                </div>
              </div>
            </div>
            <div className="p-4 space-y-2 bg-card/40">
              {pillar.tools.map((tool, ti) => (
                <motion.div key={tool.name} initial={{ opacity: 0, x: -10 }} whileInView={{ opacity: 1, x: 0 }}
                  viewport={{ once: true }} transition={{ delay: pi * 0.15 + ti * 0.06 }}
                  className="flex items-center gap-3 p-2.5 rounded-lg border transition-all cursor-default"
                  style={{ borderColor: `${pillar.color}18` }}>
                  <div className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: pillar.color }} />
                  <div>
                    <div className="text-xs font-mono font-medium text-foreground">{tool.name}</div>
                    <div className="text-[10px] text-muted-foreground">{tool.desc}</div>
                  </div>
                </motion.div>
              ))}
            </div>
          </motion.div>
        ))}
      </div>
      <motion.div initial={{ opacity: 0, y: 15 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}
        transition={{ delay: 0.5 }}
        className="mt-8 max-w-xl mx-auto p-4 rounded-xl border border-border bg-card/40 text-center">
        <div className="flex items-center justify-center gap-2 mb-2">
          <Layers size={14} className="text-primary" />
          <span className="text-xs font-mono text-primary">// correlação unificada</span>
        </div>
        <p className="text-sm text-muted-foreground">
          Correlação entre métricas, logs e traces reduz MTTR em até{" "}
          <span className="text-primary font-mono">60%</span> —
          o que antes levava 20min de debugging manual, agora é identificado em segundos via trace ID.
        </p>
      </motion.div>
    </div>
  </section>
);

export default ObservabilitySection;
