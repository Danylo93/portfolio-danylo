import { motion } from "framer-motion";
import { Briefcase, Calendar } from "lucide-react";

const experiences = [
  {
    role: "Analista DevOps",
    company: "Argo IT",
    location: "São Paulo",
    period: "08/2025 - Atual",
    highlights: [
      "Governança e padronização no Azure DevOps: permissões, branch policies e templates YAML",
      "Pipelines CI/CD com foco em reuso, segurança e compliance corporativo",
      "Automação de infraestrutura com Terraform (Azure + ADO)",
      "Observabilidade: Grafana, Zabbix e Kibana",
    ],
  },
  {
    role: "Senior Infrastructure Engineer",
    company: "Minsait → F1rst Digital (Banco Santander)",
    location: "São Paulo",
    period: "07/2024 - 07/2025",
    highlights: [
      "Pipelines CI/CD com GitHub Actions e Azure DevOps (SAST/DAST)",
      "Clusters Kubernetes via Rancher com RBAC e observabilidade",
      "GitOps com ArgoCD: blue/green e canary deployments",
      "IaC com Terraform + automação com Ansible",
    ],
  },
  {
    role: "Senior Infrastructure Engineer",
    company: "Minsait → Prefeitura de São Paulo",
    location: "São Paulo",
    period: "08/2023 - 06/2024",
    highlights: [
      "Pipelines CI/CD com GitHub Actions e Azure DevOps",
      "Orquestração Kubernetes via Rancher",
      "Observabilidade com Prometheus, Grafana e Loki",
    ],
  },
  {
    role: "Senior Infrastructure Engineer",
    company: "Minsait → Banco do Brasil",
    location: "São Paulo",
    period: "11/2022 - 08/2023",
    highlights: [
      "Microsserviços em Java 11 + Spring Boot",
      "Migração de Jenkins para GitHub Actions",
      "IaC com Terraform e Ansible",
    ],
  },
  {
    role: "Mobile Developer",
    company: "HND Labs",
    location: "São Paulo",
    period: "11/2020 - 10/2022",
    highlights: [
      "Desenvolvimento React Native e publicação nas stores",
      "Integração backend com APIs REST",
    ],
  },
];

const ExperienceSection = () => {
  return (
    <section id="experience" className="py-24 relative">
      <div className="container px-6">
        <motion.div
          initial={{ opacity: 0, y: 40 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="text-center mb-16"
        >
          <span className="font-mono text-primary text-sm">// experiência</span>
          <h2 className="text-3xl md:text-4xl font-display font-bold mt-2">
            Trajetória <span className="gradient-text">Profissional</span>
          </h2>
        </motion.div>

        <div className="max-w-3xl mx-auto relative">
          {/* Timeline line */}
          <div className="absolute left-[19px] md:left-[23px] top-0 bottom-0 w-px bg-border" />

          <div className="space-y-8">
            {experiences.map((exp, i) => (
              <motion.div
                key={i}
                initial={{ opacity: 0, x: -30 }}
                whileInView={{ opacity: 1, x: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.5, delay: i * 0.1 }}
                className="relative pl-12 md:pl-14"
              >
                {/* Timeline dot */}
                <div className="absolute left-[14px] md:left-[18px] top-1 w-3 h-3 rounded-full bg-primary box-glow" />

                <div className="p-5 rounded-lg border border-border bg-card/50 backdrop-blur-sm hover:box-glow transition-shadow">
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 mb-3">
                    <div>
                      <h3 className="font-display font-semibold text-foreground flex items-center gap-2">
                        <Briefcase size={14} className="text-primary" />
                        {exp.role}
                      </h3>
                      <p className="text-sm text-primary/80 font-mono">{exp.company}</p>
                    </div>
                    <span className="text-xs text-muted-foreground font-mono flex items-center gap-1">
                      <Calendar size={12} /> {exp.period}
                    </span>
                  </div>
                  <ul className="space-y-1">
                    {exp.highlights.map((h, j) => (
                      <li key={j} className="text-sm text-muted-foreground flex gap-2">
                        <span className="text-primary mt-1 shrink-0">›</span>
                        {h}
                      </li>
                    ))}
                  </ul>
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
};

export default ExperienceSection;
