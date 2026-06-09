import { motion } from "framer-motion";
import { Server, GitBranch, Shield, Activity } from "lucide-react";

const highlights = [
  {
    icon: Server,
    title: "Platform Engineering",
    desc: "Kubernetes, EKS, Docker, Terraform, Ansible, OpenShift, GitOps",
  },
  {
    icon: GitBranch,
    title: "CI/CD & Automação",
    desc: "GitHub Actions, Azure DevOps, GitLab CI, ArgoCD, FluxCD",
  },
  {
    icon: Shield,
    title: "DevSecOps",
    desc: "SAST/DAST/SCA, RBAC, SSL/TLS, compliance como código",
  },
  {
    icon: Activity,
    title: "SRE & Confiabilidade",
    desc: "SLI/SLO/SLA, incident response, post-mortem, MTTR",
  },
];

const AboutSection = () => {
  return (
    <section id="about" className="py-24 relative">
      <div className="container px-6">
        <motion.div
          initial={{ opacity: 0, y: 40 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="text-center mb-16"
        >
          <span className="font-mono text-primary text-sm">// sobre mim</span>
          <h2 className="text-3xl md:text-4xl font-display font-bold mt-2">
            Quem é <span className="gradient-text">Danylo</span>
          </h2>
        </motion.div>

        <div className="grid md:grid-cols-2 gap-12 items-start max-w-5xl mx-auto">
          {/* Bio */}
          <motion.div
            initial={{ opacity: 0, x: -40 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6 }}
            className="space-y-4 text-muted-foreground leading-relaxed"
          >
            <p>
              Profissional DevOps/SRE com sólida experiência em ambientes críticos — Kubernetes em produção,
              automação de infraestrutura e confiabilidade de sistemas. Atuação em cloud (AWS, Azure e GCP),
              infraestrutura como código com Terraform, e pipelines CI/CD com foco em segurança, governança
              e escalabilidade.
            </p>
            <p>
              Atuação direta em incidentes críticos, troubleshooting e post-mortem, além da definição de
              métricas de confiabilidade (SLI/SLO) e implementação de observabilidade com métricas, logs e
              tracing. Forte vivência com arquiteturas de microserviços, GitOps e automação de processos.
            </p>
            <p>
              Experiência em projetos globais com times da América Latina (Chile e Argentina),
              utilizando espanhol avançado no dia a dia.
            </p>

            {/* Badges */}
            <div className="flex flex-wrap gap-2 pt-2">
              {[
                { label: "📍 São Paulo, BR", color: "#4ade80" },
                { label: "🏆 GitHub Foundations", color: "#f0f6fc" },
                { label: "☁ AZ-104 in progress", color: "#0078D4" },
                { label: "🌎 Espanhol avançado", color: "#22d3ee" },
              ].map((b) => (
                <span
                  key={b.label}
                  className="text-xs font-mono px-3 py-1.5 rounded-full border"
                  style={{
                    color: b.color,
                    borderColor: `${b.color}30`,
                    backgroundColor: `${b.color}10`,
                  }}
                >
                  {b.label}
                </span>
              ))}
            </div>
          </motion.div>

          {/* Highlights grid */}
          <div className="grid gap-4">
            {highlights.map((item, i) => (
              <motion.div
                key={item.title}
                initial={{ opacity: 0, x: 40 }}
                whileInView={{ opacity: 1, x: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.5, delay: i * 0.12 }}
                whileHover={{ x: 6 }}
                className="flex items-center gap-4 p-4 rounded-lg border border-border bg-card/50 backdrop-blur-sm hover:border-glow transition-all"
              >
                <div className="p-3 rounded-lg bg-primary/10 flex-shrink-0">
                  <item.icon size={20} className="text-primary" />
                </div>
                <div>
                  <h3 className="font-display font-semibold text-foreground text-sm">{item.title}</h3>
                  <p className="text-xs text-muted-foreground mt-0.5">{item.desc}</p>
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
};

export default AboutSection;
