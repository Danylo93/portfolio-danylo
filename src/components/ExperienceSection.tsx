import { motion } from "framer-motion";
import { Briefcase, Calendar, MapPin } from "lucide-react";

const experiences = [
  { role: "Senior Infrastructure Engineer / SRE", company: "Argo IT", location: "São Paulo, SP",
    period: "07/2025 – atual", current: true, color: "#f59e0b",
    highlights: [
      "Definição e monitoramento de SLIs/SLOs com alertas de burn rate multi-janela via Prometheus + AlertManager",
      "Condução de war rooms em incidentes P1/P2: troubleshooting em Kubernetes, traces e logs correlacionados",
      "Post-mortems blameless com root cause analysis e action items rastreados",
      "Observabilidade unificada: OpenTelemetry + CloudWatch + Cloud Monitoring + Grafana + ELK Stack",
      "IaC multi-cloud (Terraform) — AWS, Azure e GCP com pipelines automatizadas de plan/apply",
      "IDPs com Backstage: catálogos de serviços, golden paths e redução de toil para developers",
    ],
    tags: ["SLO/SLI", "Incident Response", "OpenTelemetry", "EKS", "Terraform", "Backstage"] },
  { role: "Senior Infrastructure Engineer / SRE", company: "Minsait → F1rst Digital (Banco Santander)",
    location: "São Paulo, SP", period: "07/2024 – 07/2025", current: false, color: "#3b82f6",
    highlights: [
      "Gerenciamento de clusters Kubernetes via Rancher: RBAC, Workloads, Policies e Observabilidade Centralizada",
      "HA e autoscaling (HPA + VPA) em ambientes financeiros críticos",
      "Incident response e RCA em produção — MTTR médio de 11min em incidentes P1",
      "GitOps com ArgoCD: blue/green e canary deployments, versionamento de estado dos ambientes",
      "Prometheus + Grafana + ELK Stack — dashboards de SLO e burn rate alerts",
      "Post-mortems com 5-Whys que eliminaram classes de falha recorrentes",
    ],
    tags: ["Kubernetes", "ArgoCD", "Prometheus", "Grafana", "MTTR", "Incident Response"] },
  { role: "Senior Infrastructure Engineer", company: "Minsait → Prefeitura de São Paulo",
    location: "São Paulo, SP", period: "08/2023 – 06/2024", current: false, color: "#a78bfa",
    highlights: [
      "Kubernetes via Rancher: ambientes estáveis, seguros e altamente disponíveis",
      "Observabilidade: Prometheus + Grafana + Loki — logs e métricas integrados",
      "GitOps com ArgoCD, automação de deploy com versionamento de estado",
      "IaC com Terraform e automações Ansible para consistência entre ambientes",
    ],
    tags: ["Kubernetes", "Prometheus", "Grafana", "Loki", "Terraform"] },
  { role: "Senior Infrastructure Engineer", company: "Minsait → Banco do Brasil",
    location: "São Paulo, SP", period: "11/2022 – 08/2023", current: false, color: "#22c55e",
    highlights: [
      "Observabilidade com Prometheus, Grafana e ELK: correlação de métricas e logs de serviços Java",
      "Migração Jenkins → GitHub Actions — redução de MTBF e aumento de automação de testes",
      "Pipelines CI/CD multi-cloud com SAST/DAST integrado",
      "IaC com Terraform + Ansible: rastreabilidade entre On-Premise e multi-cloud",
    ],
    tags: ["Prometheus", "Grafana", "ELK", "GitHub Actions", "Terraform"] },
  { role: "DevOps Engineer / Mobile Developer", company: "HND Labs",
    location: "São Paulo, SP", period: "11/2020 – 10/2022", current: false, color: "#fb923c",
    highlights: [
      "Pipelines CI/CD para mobile e backend, conteinerização com Docker",
      "Monitoramento e troubleshooting de aplicações em ambientes Linux",
      "Desenvolvimento React Native com integração REST APIs",
    ],
    tags: ["CI/CD", "Docker", "Linux", "React Native"] },
];

const ExperienceSection = () => (
  <section id="experience" className="py-24 relative">
    <div className="container px-6">
      <motion.div initial={{ opacity: 0, y: 40 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}
        className="text-center mb-16">
        <span className="font-mono text-primary text-sm">// experiência</span>
        <h2 className="text-3xl md:text-4xl font-display font-bold mt-2">
          Trajetória <span className="gradient-text">Profissional</span>
        </h2>
      </motion.div>
      <div className="max-w-3xl mx-auto relative">
        <div className="absolute left-[19px] md:left-[23px] top-0 bottom-0 w-px bg-border" />
        <div className="space-y-6">
          {experiences.map((exp, i) => (
            <motion.div key={i} initial={{ opacity: 0, x: -30 }} whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true }} transition={{ delay: i * 0.08 }} className="relative pl-12 md:pl-14">
              <motion.div className="absolute left-[14px] md:left-[18px] top-4 w-3 h-3 rounded-full"
                style={{ backgroundColor: exp.color }}
                animate={exp.current ? { boxShadow: [`0 0 0px ${exp.color}00`, `0 0 10px ${exp.color}`, `0 0 0px ${exp.color}00`] } : {}}
                transition={{ duration: 2, repeat: Infinity }} />
              <div className="p-5 rounded-xl border bg-card/50 backdrop-blur-sm hover:shadow-lg transition-all"
                style={{ borderColor: `${exp.color}22` }}>
                <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2 mb-3">
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="font-display font-semibold text-foreground text-sm flex items-center gap-1.5">
                        <Briefcase size={13} style={{ color: exp.color }} /> {exp.role}
                      </h3>
                      {exp.current && (
                        <span className="text-[10px] font-mono px-2 py-0.5 rounded-full"
                          style={{ color: exp.color, backgroundColor: `${exp.color}15`, border: `1px solid ${exp.color}30` }}>● atual</span>
                      )}
                    </div>
                    <p className="text-sm font-mono mt-0.5" style={{ color: `${exp.color}cc` }}>{exp.company}</p>
                  </div>
                  <div className="flex flex-col items-start sm:items-end gap-1 flex-shrink-0">
                    <span className="text-xs text-muted-foreground font-mono flex items-center gap-1"><Calendar size={11} /> {exp.period}</span>
                    <span className="text-xs text-muted-foreground font-mono flex items-center gap-1"><MapPin size={11} /> {exp.location}</span>
                  </div>
                </div>
                <ul className="space-y-1.5 mb-4">
                  {exp.highlights.map((h, j) => (
                    <li key={j} className="text-xs text-muted-foreground flex gap-2">
                      <span className="mt-0.5 shrink-0" style={{ color: exp.color }}>›</span>{h}
                    </li>
                  ))}
                </ul>
                <div className="flex flex-wrap gap-1.5">
                  {exp.tags.map(tag => (
                    <span key={tag} className="text-[10px] font-mono px-2 py-0.5 rounded"
                      style={{ color: `${tag}aa`, backgroundColor: `${exp.color}10`, border: `1px solid ${exp.color}25`, color: `${exp.color}aa` }}>{tag}</span>
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

export default ExperienceSection;
