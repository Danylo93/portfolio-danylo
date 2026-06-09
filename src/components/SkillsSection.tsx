import { motion } from "framer-motion";

const skillCategories = [
  {
    title: "Platform Engineering",
    icon: "☸",
    color: "#4ade80",
    skills: ["Kubernetes", "Docker", "Terraform", "Ansible", "OpenShift", "GitOps", "FluxCD", "ArgoCD", "Helm", "Rancher"],
  },
  {
    title: "Cloud · AWS",
    icon: "☁",
    color: "#FF9900",
    skills: ["EKS", "Lambda", "API Gateway", "CloudWatch", "ECR", "VPC", "IAM", "S3"],
  },
  {
    title: "Cloud · Azure & GCP",
    icon: "⛅",
    color: "#0078D4",
    skills: ["Azure DevOps", "APIM", "AKS", "GKE", "Cloud Run", "Cloud Build", "GCP IAM", "Compute Engine"],
  },
  {
    title: "CI/CD & Automação",
    icon: "⚡",
    color: "#fbbf24",
    skills: ["GitHub Actions", "GitLab CI/CD", "Azure Pipelines", "Cloud Build", "Jenkins", "Rundeck", "Bash", "Python"],
  },
  {
    title: "Observabilidade & SRE",
    icon: "📊",
    color: "#22d3ee",
    skills: ["Prometheus", "Grafana", "ELK Stack", "Loki", "Kibana", "OpenTelemetry", "Zabbix", "SLI/SLO/SLA"],
  },
  {
    title: "Segurança & Governança",
    icon: "🛡",
    color: "#f87171",
    skills: ["SAST", "DAST", "SCA", "RBAC", "SSL/TLS", "Secrets Mgmt", "Branch Policies", "Compliance as Code"],
  },
  {
    title: "Backend & APIs",
    icon: "⚙",
    color: "#a78bfa",
    skills: ["Node.js (NestJS)", "Java Spring Boot", "REST APIs", "Microservices", "Kafka", "PostgreSQL", "MySQL", "OAuth2/JWT"],
  },
  {
    title: "Arquitetura & Práticas",
    icon: "🏗",
    color: "#fb923c",
    skills: ["Clean Architecture", "Design Patterns", "TDD", "Scrum", "Kanban", "Backstage IDP", "Incident Response", "Post-Mortem"],
  },
];

const SkillsSection = () => {
  return (
    <section id="skills" className="py-24 relative">
      <div className="absolute inset-0 grid-bg opacity-20" />
      <div className="container relative px-6">
        <motion.div
          initial={{ opacity: 0, y: 40 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="text-center mb-16"
        >
          <span className="font-mono text-primary text-sm">// habilidades</span>
          <h2 className="text-3xl md:text-4xl font-display font-bold mt-2">
            Tech <span className="gradient-text">Stack</span>
          </h2>
        </motion.div>

        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-4 max-w-6xl mx-auto">
          {skillCategories.map((cat, catIndex) => (
            <motion.div
              key={cat.title}
              initial={{ opacity: 0, y: 30 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5, delay: catIndex * 0.07 }}
              whileHover={{ y: -4 }}
              className="p-5 rounded-xl border bg-card/50 backdrop-blur-sm transition-all hover:shadow-lg"
              style={{ borderColor: `${cat.color}25` }}
            >
              <div className="flex items-center gap-2 mb-4">
                <span className="text-xl">{cat.icon}</span>
                <h3
                  className="font-mono text-xs font-bold tracking-wider"
                  style={{ color: cat.color }}
                >
                  {cat.title.toUpperCase()}
                </h3>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {cat.skills.map((skill, i) => (
                  <motion.span
                    key={skill}
                    initial={{ opacity: 0, scale: 0.8 }}
                    whileInView={{ opacity: 1, scale: 1 }}
                    viewport={{ once: true }}
                    transition={{ delay: catIndex * 0.07 + i * 0.04 }}
                    whileHover={{ scale: 1.08 }}
                    className="px-2.5 py-1 text-[11px] font-mono rounded-md border cursor-default transition-all"
                    style={{
                      borderColor: `${cat.color}30`,
                      color: `${cat.color}cc`,
                      backgroundColor: `${cat.color}08`,
                    }}
                  >
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
};

export default SkillsSection;
