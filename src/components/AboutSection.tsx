import { motion } from "framer-motion";
import { Activity, Shield, BarChart3, Globe } from "lucide-react";

const pillars = [
  { icon: Activity, title: "Confiabilidade",  desc: "SLI/SLO/SLA, error budgets, burn rate alerts, blameless post-mortems" },
  { icon: BarChart3, title: "Observabilidade", desc: "Prometheus, Grafana, OpenTelemetry, ELK, Datadog APM — métricas, logs, traces" },
  { icon: Shield,    title: "Resiliência",     desc: "HA, autoscaling, circuit breakers, chaos engineering, runbooks" },
  { icon: Globe,     title: "Multi-Cloud",     desc: "AWS EKS, Azure AKS, GCP GKE — ambientes distribuídos e híbridos" },
];

const AboutSection = () => (
  <section id="about" className="py-24 relative">
    <div className="container px-6">
      <motion.div initial={{ opacity: 0, y: 40 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}
        className="text-center mb-16">
        <span className="font-mono text-primary text-sm">// sobre mim</span>
        <h2 className="text-3xl md:text-4xl font-display font-bold mt-2">
          Quem é <span className="gradient-text">Danylo</span>
        </h2>
      </motion.div>
      <div className="grid md:grid-cols-2 gap-12 items-start max-w-5xl mx-auto">
        <motion.div initial={{ opacity: 0, x: -40 }} whileInView={{ opacity: 1, x: 0 }} viewport={{ once: true }}
          transition={{ duration: 0.6 }} className="space-y-4 text-muted-foreground leading-relaxed">
          <p>SRE / Senior Infrastructure Engineer com sólida experiência em ambientes críticos e financeiros —
            Kubernetes em produção, definição de SLI/SLO, incident response e post-mortem.
            Mentalidade orientada à confiabilidade: sistemas não falham, sistemas operam dentro de um budget de erro.</p>
          <p>Atuação em cloud multi-cloud (AWS, Azure, GCP) com foco em alta disponibilidade, autoscaling,
            observabilidade unificada e automação de toil. Forte experiência em war rooms, troubleshooting
            de ambientes distribuídos e análise de causa raiz (RCA).</p>
          <p>Experiência com times globais na América Latina (Chile e Argentina), comunicação em espanhol avançado e inglês intermediário.</p>
          <div className="flex flex-wrap gap-2 pt-2">
            {[
              { t: "📍 São Paulo, BR",       c: "#4ade80" },
              { t: "🏆 GitHub Foundations",   c: "#f0f6fc" },
              { t: "☁ AZ-104 in progress",   c: "#0078D4" },
              { t: "🌎 ES avançado",          c: "#f59e0b" },
            ].map(b => (
              <span key={b.t} className="text-xs font-mono px-3 py-1.5 rounded-full border"
                style={{ color: b.c, borderColor: `${b.c}30`, backgroundColor: `${b.c}10` }}>{b.t}</span>
            ))}
          </div>
        </motion.div>
        <div className="grid gap-4">
          {pillars.map((p, i) => (
            <motion.div key={p.title} initial={{ opacity: 0, x: 40 }} whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true }} transition={{ delay: i * 0.12 }} whileHover={{ x: 6 }}
              className="flex items-center gap-4 p-4 rounded-lg border border-border bg-card/50 hover:border-glow transition-all">
              <div className="p-3 rounded-lg bg-primary/10 flex-shrink-0">
                <p.icon size={20} className="text-primary" />
              </div>
              <div>
                <h3 className="font-display font-semibold text-foreground text-sm">{p.title}</h3>
                <p className="text-xs text-muted-foreground mt-0.5">{p.desc}</p>
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </div>
  </section>
);

export default AboutSection;
