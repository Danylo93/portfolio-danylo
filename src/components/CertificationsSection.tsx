import { motion } from "framer-motion";
import { Award, Clock, CheckCircle, BookOpen } from "lucide-react";

interface Cert {
  title: string;
  issuer: string;
  status: "earned" | "in-progress" | "planned";
  badge: string;
  color: string;
}

const certifications: Cert[] = [
  {
    title: "GitHub Foundations",
    issuer: "GitHub",
    status: "earned",
    badge: "⚙",
    color: "#f0f6fc",
  },
  {
    title: "Azure Administrator Associate",
    issuer: "Microsoft · AZ-104",
    status: "in-progress",
    badge: "☁",
    color: "#0078D4",
  },
  {
    title: "DevOps Engineer Expert",
    issuer: "Microsoft · AZ-400",
    status: "planned",
    badge: "⚡",
    color: "#0078D4",
  },
  {
    title: "Azure Solutions Architect",
    issuer: "Microsoft · AZ-305",
    status: "planned",
    badge: "🏗",
    color: "#0078D4",
  },
];

const education = [
  {
    degree: "Pós-Graduação · Engenharia de Software com IA",
    institution: "UNIPDS",
    period: "03/2026 – 03/2027",
    status: "Cursando",
    color: "#4ade80",
  },
  {
    degree: "Pós-Graduação · Cloud & AI DevOps",
    institution: "Impacta",
    period: "01/2026 – 01/2027",
    status: "Cursando",
    color: "#22d3ee",
  },
  {
    degree: "Graduação · Análise e Desenvolvimento de Sistemas",
    institution: "FMU",
    period: "02/2019 – 12/2021",
    status: "Concluído",
    color: "#a78bfa",
  },
];

const statusConfig = {
  earned: { label: "Obtida", Icon: CheckCircle, color: "#4ade80" },
  "in-progress": { label: "Em andamento", Icon: Clock, color: "#fbbf24" },
  planned: { label: "Planejado", Icon: BookOpen, color: "#6b7280" },
};

const CertificationsSection = () => {
  return (
    <section id="certifications" className="py-24 relative">
      <div className="absolute inset-0 grid-bg opacity-20" />
      <div className="container relative px-6">
        <motion.div
          initial={{ opacity: 0, y: 40 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="text-center mb-16"
        >
          <span className="font-mono text-primary text-sm">// certificações & formação</span>
          <h2 className="text-3xl md:text-4xl font-display font-bold mt-2">
            Credenciais & <span className="gradient-text">Educação</span>
          </h2>
        </motion.div>

        <div className="max-w-4xl mx-auto grid md:grid-cols-2 gap-10">
          {/* Certifications */}
          <div>
            <div className="flex items-center gap-2 mb-6">
              <Award size={18} className="text-primary" />
              <h3 className="font-display font-semibold text-foreground">Certificações</h3>
            </div>
            <div className="space-y-3">
              {certifications.map((cert, i) => {
                const { label, Icon, color: statusColor } = statusConfig[cert.status];
                return (
                  <motion.div
                    key={cert.title}
                    initial={{ opacity: 0, x: -20 }}
                    whileInView={{ opacity: 1, x: 0 }}
                    viewport={{ once: true }}
                    transition={{ delay: i * 0.1 }}
                    whileHover={{ x: 4 }}
                    className="flex items-center gap-4 p-4 rounded-lg border bg-card/50 backdrop-blur-sm transition-all"
                    style={{ borderColor: `${cert.color}25` }}
                  >
                    <div
                      className="w-10 h-10 rounded-lg flex items-center justify-center text-lg flex-shrink-0"
                      style={{ backgroundColor: `${cert.color}15` }}
                    >
                      {cert.badge}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-display font-medium text-foreground leading-tight">
                        {cert.title}
                      </div>
                      <div className="text-xs text-muted-foreground font-mono mt-0.5">
                        {cert.issuer}
                      </div>
                    </div>
                    <div
                      className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-mono flex-shrink-0"
                      style={{
                        color: statusColor,
                        backgroundColor: `${statusColor}15`,
                        border: `1px solid ${statusColor}30`,
                      }}
                    >
                      <Icon size={10} />
                      {label}
                    </div>
                  </motion.div>
                );
              })}
            </div>
          </div>

          {/* Education */}
          <div>
            <div className="flex items-center gap-2 mb-6">
              <BookOpen size={18} className="text-primary" />
              <h3 className="font-display font-semibold text-foreground">Formação Acadêmica</h3>
            </div>
            <div className="space-y-3">
              {education.map((edu, i) => (
                <motion.div
                  key={edu.degree}
                  initial={{ opacity: 0, x: 20 }}
                  whileInView={{ opacity: 1, x: 0 }}
                  viewport={{ once: true }}
                  transition={{ delay: i * 0.1 }}
                  whileHover={{ x: -4 }}
                  className="p-4 rounded-lg border bg-card/50 backdrop-blur-sm transition-all"
                  style={{ borderColor: `${edu.color}25` }}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="text-sm font-display font-medium text-foreground leading-snug">
                        {edu.degree}
                      </div>
                      <div
                        className="text-xs font-mono mt-1"
                        style={{ color: edu.color }}
                      >
                        {edu.institution}
                      </div>
                    </div>
                    <span
                      className="text-[10px] font-mono px-2 py-0.5 rounded-full flex-shrink-0"
                      style={{
                        color: edu.color,
                        backgroundColor: `${edu.color}15`,
                        border: `1px solid ${edu.color}30`,
                      }}
                    >
                      {edu.status}
                    </span>
                  </div>
                  <div className="text-[11px] text-muted-foreground font-mono mt-2">
                    {edu.period}
                  </div>
                </motion.div>
              ))}
            </div>

            {/* Languages */}
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: 0.35 }}
              className="mt-6 p-4 rounded-lg border border-border bg-card/50"
            >
              <div className="text-xs font-mono text-primary mb-3">// idiomas</div>
              <div className="space-y-2.5">
                {[
                  { lang: "Português", level: "Nativo", pct: 100, color: "#4ade80" },
                  { lang: "Espanhol", level: "Avançado", pct: 85, color: "#22d3ee" },
                  { lang: "Inglês", level: "Intermediário", pct: 60, color: "#a78bfa" },
                ].map((l) => (
                  <div key={l.lang}>
                    <div className="flex justify-between text-xs font-mono mb-1">
                      <span className="text-foreground">{l.lang}</span>
                      <span style={{ color: l.color }}>{l.level}</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-border overflow-hidden">
                      <motion.div
                        className="h-full rounded-full"
                        style={{ backgroundColor: l.color }}
                        initial={{ width: 0 }}
                        whileInView={{ width: `${l.pct}%` }}
                        viewport={{ once: true }}
                        transition={{ duration: 1, delay: 0.3, ease: "easeOut" }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </motion.div>
          </div>
        </div>
      </div>
    </section>
  );
};

export default CertificationsSection;
