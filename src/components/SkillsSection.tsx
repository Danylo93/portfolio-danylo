import { motion } from "framer-motion";

const skillCategories = [
  {
    title: "Cloud & Infra",
    skills: ["AWS", "Azure", "Terraform", "Ansible", "OpenShift", "IaC"],
  },
  {
    title: "Containers & Orquestração",
    skills: ["Docker", "Kubernetes", "Rancher", "ArgoCD", "Helm", "GitOps"],
  },
  {
    title: "CI/CD & Automação",
    skills: ["GitHub Actions", "Azure DevOps", "Jenkins", "Rundeck", "Bash", "Python"],
  },
  {
    title: "Monitoramento & Observabilidade",
    skills: ["Prometheus", "Grafana", "ELK Stack", "Loki", "Zabbix", "Kibana"],
  },
  {
    title: "Backend & Dev",
    skills: ["Java Spring Boot", "Node.js/NestJS", "React Native", "Kafka", "PostgreSQL", "MySQL"],
  },
  {
    title: "Metodologias & Práticas",
    skills: ["DevSecOps", "SAST/DAST", "Clean Architecture", "TDD", "Scrum", "GitOps"],
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

        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6 max-w-5xl mx-auto">
          {skillCategories.map((cat, catIndex) => (
            <motion.div
              key={cat.title}
              initial={{ opacity: 0, y: 30 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5, delay: catIndex * 0.1 }}
              className="p-6 rounded-lg border border-border bg-card/50 backdrop-blur-sm hover:box-glow transition-shadow"
            >
              <h3 className="font-mono text-primary text-sm mb-4">{`> ${cat.title}`}</h3>
              <div className="flex flex-wrap gap-2">
                {cat.skills.map((skill, i) => (
                  <motion.span
                    key={skill}
                    initial={{ opacity: 0, scale: 0.8 }}
                    whileInView={{ opacity: 1, scale: 1 }}
                    viewport={{ once: true }}
                    transition={{ delay: catIndex * 0.1 + i * 0.05 }}
                    whileHover={{ scale: 1.1 }}
                    className="px-3 py-1.5 text-sm font-mono rounded-md border border-border bg-secondary/50 text-foreground hover:border-glow hover:text-primary transition-colors cursor-default"
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
