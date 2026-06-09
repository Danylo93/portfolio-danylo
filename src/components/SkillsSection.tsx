import { motion } from "framer-motion";

const categories = [
  { icon: "☸", title: "Container Orchestration", color: "#f59e0b",
    skills: ["Kubernetes", "EKS", "GKE", "AKS", "OpenShift", "Rancher", "Helm", "Kustomize"] },
  { icon: "📊", title: "SRE & Reliability", color: "#22c55e",
    skills: ["SLI / SLO / SLA", "Error Budgets", "Burn Rate Alerts", "Chaos Engineering", "Toil Reduction", "Runbooks", "GameDays", "Post-Mortem"] },
  { icon: "🔭", title: "Observability", color: "#3b82f6",
    skills: ["Prometheus", "Grafana", "OpenTelemetry", "Datadog APM", "ELK Stack", "Loki", "Jaeger", "CloudWatch"] },
  { icon: "🚨", title: "Incident Response", color: "#ef4444",
    skills: ["PagerDuty", "AlertManager", "War Room", "RCA / 5-Whys", "MTTD / MTTR", "On-call Rotation", "Escalation Policies", "Blameless Culture"] },
  { icon: "☁", title: "Cloud Platforms", color: "#FF9900",
    skills: ["AWS EKS", "AWS Lambda", "CloudWatch", "Azure DevOps", "GKE", "Cloud Run", "GCP Monitoring", "Multi-Cloud"] },
  { icon: "🏗", title: "IaC & Automation", color: "#a78bfa",
    skills: ["Terraform", "Ansible", "ArgoCD (GitOps)", "FluxCD", "GitHub Actions", "Azure Pipelines", "Cloud Build", "Bash / Python"] },
  { icon: "🛡", title: "Segurança & Governance", color: "#f97316",
    skills: ["RBAC", "SSL/TLS", "SAST / DAST / SCA", "Secrets Mgmt", "Network Policies", "OPA / Gatekeeper", "Compliance as Code", "APIM"] },
  { icon: "⚙", title: "Backend & Platform", color: "#6ee7b7",
    skills: ["Node.js (NestJS)", "Java Spring Boot", "REST APIs", "Kafka", "Backstage IDP", "Service Mesh", "PostgreSQL", "Clean Architecture"] },
];

const SkillsSection = () => (
  <section id="skills" className="py-24 relative">
    <div className="absolute inset-0 grid-bg opacity-20" />
    <div className="container relative px-6">
      <motion.div initial={{ opacity: 0, y: 40 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}
        className="text-center mb-16">
        <span className="font-mono text-primary text-sm">// habilidades</span>
        <h2 className="text-3xl md:text-4xl font-display font-bold mt-2">
          Tech <span className="gradient-text">Stack</span>
        </h2>
      </motion.div>
      <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-4 max-w-6xl mx-auto">
        {categories.map((cat, ci) => (
          <motion.div key={cat.title} initial={{ opacity: 0, y: 30 }} whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }} transition={{ delay: ci * 0.07 }} whileHover={{ y: -4 }}
            className="p-5 rounded-xl border bg-card/50 backdrop-blur-sm transition-all"
            style={{ borderColor: `${cat.color}22` }}>
            <div className="flex items-center gap-2 mb-4">
              <span className="text-xl">{cat.icon}</span>
              <h3 className="font-mono text-[11px] font-bold tracking-wider" style={{ color: cat.color }}>
                {cat.title.toUpperCase()}
              </h3>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {cat.skills.map((skill, si) => (
                <motion.span key={skill} initial={{ opacity: 0, scale: 0.8 }} whileInView={{ opacity: 1, scale: 1 }}
                  viewport={{ once: true }} transition={{ delay: ci * 0.07 + si * 0.04 }} whileHover={{ scale: 1.08 }}
                  className="px-2.5 py-1 text-[11px] font-mono rounded-md border cursor-default"
                  style={{ borderColor: `${cat.color}28`, color: `${cat.color}cc`, backgroundColor: `${cat.color}08` }}>
                  {skill}
                </motion.span>
              ))}
            </div>
          </motion.div>
        ))}
      </div>
    </div>
  </section>
);

export default SkillsSection;
