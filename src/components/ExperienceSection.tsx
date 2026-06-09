import { motion } from "framer-motion";
import { Briefcase, Calendar, MapPin } from "lucide-react";

const experiences = [
  {
    role: "Senior Infrastructure Engineer",
    company: "Argo IT",
    location: "São Paulo, SP",
    period: "07/2025 – atual",
    current: true,
    highlights: [
      "Governança multi-cloud (AWS, Azure, GCP): branch policies, permissões e templates YAML reutilizáveis",
      "Pipelines CI/CD com Azure Pipelines, GitHub Actions e Cloud Build — foco em reuso e compliance",
      "Implementação de SRE: SLI/SLO, war rooms, troubleshooting em Kubernetes e serviços gerenciados",
      "Observabilidade com OpenTelemetry, CloudWatch, Cloud Monitoring, Grafana e ELK Stack",
      "IDPs com Backstage: catálogos de serviços, templates, golden paths e padrões de engenharia",
      "IaC com Terraform — VPC, redes, clusters Kubernetes em AWS, Azure e GCP",
      "Atuação com times globais: Argentina, Chile e Espanha",
    ],
    tags: ["AWS", "Azure", "GCP", "EKS", "Terraform", "SRE", "Backstage"],
    color: "#4ade80",
  },
  {
    role: "Senior Infrastructure Engineer",
    company: "Minsait → F1rst Digital (Banco Santander)",
    location: "São Paulo, SP",
    period: "07/2024 – 07/2025",
    current: false,
    highlights: [
      "Pipelines CI/CD com GitHub Actions e Azure DevOps (stages: build, testes, SAST/DAST, deploy)",
      "Clusters Kubernetes via Rancher: RBAC, Workloads, Policies e Observabilidade Centralizada",
      "GitOps com ArgoCD: blue/green e canary deployments, sincronização contínua",
      "IaC com Terraform + automações Ansible entre Cloud e On-Premise",
      "Kafka: integração de sistemas internos e suporte a microsserviços em produção",
      "Times globais: Chile e Espanha",
    ],
    tags: ["GitHub Actions", "Kubernetes", "ArgoCD", "Terraform", "Ansible", "SAST/DAST"],
    color: "#22d3ee",
  },
  {
    role: "Senior Infrastructure Engineer",
    company: "Minsait → Prefeitura de São Paulo",
    location: "São Paulo, SP",
    period: "08/2023 – 06/2024",
    current: false,
    highlights: [
      "Pipelines CI/CD com GitHub Actions e Azure DevOps",
      "Kubernetes via Rancher: ambientes estáveis, seguros e altamente disponíveis",
      "GitOps com ArgoCD: ciclo completo de deploy baseado em versionamento",
      "IaC com Terraform e automações Ansible (roles, templates, certificados)",
      "Observabilidade com Prometheus, Grafana e Loki: logs e métricas integrados",
    ],
    tags: ["GitHub Actions", "Kubernetes", "ArgoCD", "Terraform", "Prometheus", "Grafana"],
    color: "#a78bfa",
  },
  {
    role: "Senior Infrastructure Engineer",
    company: "Minsait → Banco do Brasil",
    location: "São Paulo, SP",
    period: "11/2022 – 08/2023",
    current: false,
    highlights: [
      "APIs e microsserviços em Java 11 + Spring Boot, integração de sistemas legados",
      "Migração de Jenkins para GitHub Actions — redução de build time e aumento de automação",
      "Pipelines CI/CD multi-cloud (AWS, Azure e GCP): build → testes → análise → deploy",
      "IaC com Terraform e Ansible: ambientes On-Premise e multi-cloud rastreáveis",
      "Observabilidade com Prometheus, Grafana e ELK para serviços Java",
    ],
    tags: ["Java/Spring", "GitHub Actions", "Terraform", "Ansible", "Multi-cloud"],
    color: "#fbbf24",
  },
  {
    role: "DevOps Engineer / Mobile Developer",
    company: "HND Labs",
    location: "São Paulo, SP",
    period: "11/2020 – 10/2022",
    current: false,
    highlights: [
      "Pipelines CI/CD para apps mobile e backend (build, testes, publicação)",
      "Conteinerização com Docker, versionamento com Git/Bitbucket",
      "Desenvolvimento React Native com integração REST APIs",
      "Administração de ambientes Linux para serviços internos",
    ],
    tags: ["CI/CD", "Docker", "React Native", "Git", "Linux"],
    color: "#fb923c",
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

          <div className="space-y-6">
            {experiences.map((exp, i) => (
              <motion.div
                key={i}
                initial={{ opacity: 0, x: -30 }}
                whileInView={{ opacity: 1, x: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.5, delay: i * 0.08 }}
                className="relative pl-12 md:pl-14"
              >
                {/* Timeline dot */}
                <motion.div
                  className="absolute left-[14px] md:left-[18px] top-4 w-3 h-3 rounded-full"
                  style={{ backgroundColor: exp.color }}
                  animate={
                    exp.current
                      ? { boxShadow: [`0 0 0px ${exp.color}00`, `0 0 10px ${exp.color}`, `0 0 0px ${exp.color}00`] }
                      : {}
                  }
                  transition={{ duration: 2, repeat: Infinity }}
                />

                <div
                  className="p-5 rounded-xl border bg-card/50 backdrop-blur-sm hover:shadow-lg transition-all"
                  style={{ borderColor: `${exp.color}25` }}
                >
                  {/* Header */}
                  <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2 mb-3">
                    <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="font-display font-semibold text-foreground flex items-center gap-1.5 text-sm">
                          <Briefcase size={13} style={{ color: exp.color }} />
                          {exp.role}
                        </h3>
                        {exp.current && (
                          <span
                            className="text-[10px] font-mono px-2 py-0.5 rounded-full"
                            style={{
                              color: exp.color,
                              backgroundColor: `${exp.color}15`,
                              border: `1px solid ${exp.color}30`,
                            }}
                          >
                            ● atual
                          </span>
                        )}
                      </div>
                      <p className="text-sm font-mono mt-0.5" style={{ color: `${exp.color}cc` }}>
                        {exp.company}
                      </p>
                    </div>
                    <div className="flex flex-col items-start sm:items-end gap-1 flex-shrink-0">
                      <span className="text-xs text-muted-foreground font-mono flex items-center gap-1">
                        <Calendar size={11} /> {exp.period}
                      </span>
                      <span className="text-xs text-muted-foreground font-mono flex items-center gap-1">
                        <MapPin size={11} /> {exp.location}
                      </span>
                    </div>
                  </div>

                  {/* Highlights */}
                  <ul className="space-y-1.5 mb-4">
                    {exp.highlights.map((h, j) => (
                      <li key={j} className="text-xs text-muted-foreground flex gap-2">
                        <span className="mt-0.5 shrink-0" style={{ color: exp.color }}>›</span>
                        {h}
                      </li>
                    ))}
                  </ul>

                  {/* Tags */}
                  <div className="flex flex-wrap gap-1.5">
                    {exp.tags.map((tag) => (
                      <span
                        key={tag}
                        className="text-[10px] font-mono px-2 py-0.5 rounded"
                        style={{
                          color: `${exp.color}aa`,
                          backgroundColor: `${exp.color}10`,
                          border: `1px solid ${exp.color}25`,
                        }}
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
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
