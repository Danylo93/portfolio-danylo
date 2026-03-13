import { motion } from "framer-motion";
import { Server, GitBranch, Shield } from "lucide-react";

const highlights = [
  { icon: Server, title: "Cloud & Infra", desc: "AWS, Azure, Terraform, Ansible, OpenShift" },
  { icon: GitBranch, title: "CI/CD & GitOps", desc: "GitHub Actions, Azure DevOps, ArgoCD" },
  { icon: Shield, title: "DevSecOps", desc: "SAST/DAST, RBAC, compliance como código" },
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

        <div className="grid md:grid-cols-2 gap-12 items-center max-w-5xl mx-auto">
          <motion.div
            initial={{ opacity: 0, x: -40 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6 }}
            className="space-y-4 text-muted-foreground leading-relaxed"
          >
            <p>
              Profissional com sólida experiência em DevOps e desenvolvimento de microserviços, 
              atuando em empresas como Banco Santander (F1rst Digital), Prefeitura de São Paulo 
              e Banco do Brasil. Expertise em automação de ambientes, pipelines CI/CD e 
              monitoramento de infraestrutura crítica.
            </p>
            <p>
              Forte atuação com containers, orquestração Kubernetes e provisionamento de 
              ambientes em nuvem com Terraform e Ansible. Conhecimento aprofundado em práticas 
              ágeis e DevSecOps. Formado em Análise e Desenvolvimento de Sistemas pela FMU.
            </p>
            <p className="text-sm text-primary/80 font-mono">
              📍 São Paulo · 🏆 GitHub Foundations Certified
            </p>
          </motion.div>

          <div className="grid gap-4">
            {highlights.map((item, i) => (
              <motion.div
                key={item.title}
                initial={{ opacity: 0, x: 40 }}
                whileInView={{ opacity: 1, x: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.5, delay: i * 0.15 }}
                whileHover={{ x: 8 }}
                className="flex items-center gap-4 p-4 rounded-lg border border-border bg-card/50 backdrop-blur-sm hover:border-glow transition-colors"
              >
                <div className="p-3 rounded-md bg-primary/10">
                  <item.icon size={22} className="text-primary" />
                </div>
                <div>
                  <h3 className="font-display font-semibold text-foreground">{item.title}</h3>
                  <p className="text-sm text-muted-foreground">{item.desc}</p>
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
