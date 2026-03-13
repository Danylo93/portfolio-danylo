import { motion } from "framer-motion";
import { ExternalLink, GitBranch } from "lucide-react";

const projects = [
  {
    title: "mobile-web-devops-lab",
    description: "Laboratório de DevOps integrando mobile e web com pipelines automatizados.",
    tags: ["Python", "DevOps", "CI/CD"],
    url: "https://github.com/Danylo93/mobile-web-devops-lab",
  },
  {
    title: "shield-platform",
    description: "Plataforma de segurança e governança com foco em DevSecOps.",
    tags: ["TypeScript", "Security", "Platform"],
    url: "https://github.com/Danylo93/shield-platform",
  },
  {
    title: "shield-platform-idp",
    description: "Internal Developer Platform com foco em padronização e self-service.",
    tags: ["TypeScript", "IDP", "MIT License"],
    url: "https://github.com/Danylo93/shield-platform-idp",
  },
  {
    title: "Desafio-DevOps-Lacrei-Saúde",
    description: "Pipeline de deploy seguro e escalável com boas práticas de IaC e automação.",
    tags: ["Shell", "CI/CD", "Terraform"],
    url: "https://github.com/Danylo93/Desafio-DevOps-Lacrei-Sa-de",
  },
  {
    title: "devops-teste-tecnico-dot-k8s",
    description: "Teste técnico DevOps com provisionamento Kubernetes via Terraform.",
    tags: ["HCL", "Kubernetes", "Terraform"],
    url: "https://github.com/Danylo93/devops-teste-tecnico-dot-k8s",
  },
  {
    title: "arcs-service",
    description: "Serviço backend com arquitetura de microsserviços em Python.",
    tags: ["Python", "Backend", "Microservices"],
    url: "https://github.com/Danylo93/arcs-service",
  },
];

const ProjectsSection = () => {
  return (
    <section id="projects" className="py-24 relative">
      <div className="container px-6">
        <motion.div
          initial={{ opacity: 0, y: 40 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="text-center mb-16"
        >
          <span className="font-mono text-primary text-sm">// projetos</span>
          <h2 className="text-3xl md:text-4xl font-display font-bold mt-2">
            Projetos no <span className="gradient-text">GitHub</span>
          </h2>
        </motion.div>

        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6 max-w-5xl mx-auto">
          {projects.map((project, i) => (
            <motion.a
              key={project.title}
              href={project.url}
              target="_blank"
              rel="noopener noreferrer"
              initial={{ opacity: 0, y: 30 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5, delay: i * 0.1 }}
              whileHover={{ y: -4 }}
              className="group p-6 rounded-lg border border-border bg-card/50 backdrop-blur-sm hover:box-glow transition-all block"
            >
              <div className="flex items-center justify-between mb-3">
                <GitBranch size={20} className="text-primary" />
                <ExternalLink size={16} className="text-muted-foreground group-hover:text-primary transition-colors" />
              </div>
              <h3 className="font-display font-semibold text-foreground mb-2 truncate">{project.title}</h3>
              <p className="text-sm text-muted-foreground mb-4 leading-relaxed line-clamp-2">{project.description}</p>
              <div className="flex flex-wrap gap-2">
                {project.tags.map((tag) => (
                  <span key={tag} className="text-xs font-mono px-2 py-1 rounded bg-secondary/50 text-primary/80">
                    {tag}
                  </span>
                ))}
              </div>
            </motion.a>
          ))}
        </div>
      </div>
    </section>
  );
};

export default ProjectsSection;
