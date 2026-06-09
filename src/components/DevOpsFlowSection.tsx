import { motion } from "framer-motion";
import { useEffect, useState } from "react";
import {
  GitBranch,
  Wrench,
  ShieldCheck,
  Package,
  Rocket,
  BarChart3,
  CheckCircle2,
  Code2,
} from "lucide-react";

interface Stage {
  id: string;
  label: string;
  sublabel: string;
  Icon: React.ComponentType<{ size?: number; style?: React.CSSProperties }>;
  tools: string[];
  color: string;
}

const stages: Stage[] = [
  {
    id: "code",
    label: "CODE",
    sublabel: "Source",
    Icon: GitBranch,
    tools: ["GitHub", "GitLab"],
    color: "#60a5fa",
  },
  {
    id: "build",
    label: "BUILD",
    sublabel: "Compile",
    Icon: Wrench,
    tools: ["Docker", "Maven", "npm"],
    color: "#fbbf24",
  },
  {
    id: "test",
    label: "TEST",
    sublabel: "Validate",
    Icon: Code2,
    tools: ["JUnit", "Jest"],
    color: "#34d399",
  },
  {
    id: "security",
    label: "SECURITY",
    sublabel: "Scan",
    Icon: ShieldCheck,
    tools: ["SAST", "DAST", "SCA"],
    color: "#f87171",
  },
  {
    id: "package",
    label: "PACKAGE",
    sublabel: "Registry",
    Icon: Package,
    tools: ["ECR", "Helm"],
    color: "#c084fc",
  },
  {
    id: "deploy",
    label: "DEPLOY",
    sublabel: "Release",
    Icon: Rocket,
    tools: ["ArgoCD", "EKS"],
    color: "#4ade80",
  },
  {
    id: "monitor",
    label: "MONITOR",
    sublabel: "Observe",
    Icon: BarChart3,
    tools: ["Prometheus", "Grafana"],
    color: "#22d3ee",
  },
];

const metrics = [
  { label: "Build Time", value: "< 5min", color: "#fbbf24" },
  { label: "Deploy Freq", value: "Multi/day", color: "#4ade80" },
  { label: "MTTR", value: "< 15min", color: "#60a5fa" },
  { label: "SLO Target", value: "99.9%", color: "#22d3ee" },
];

const FlowArrow = ({ color, delay }: { color: string; delay: number }) => (
  <div className="relative flex-shrink-0 flex items-center w-8 md:w-10 h-10">
    <div className="w-full h-px" style={{ backgroundColor: "hsl(220 15% 18%)" }} />
    <motion.div
      className="absolute w-2 h-2 rounded-full"
      style={{
        backgroundColor: color,
        boxShadow: `0 0 8px ${color}`,
        left: 0,
        top: "50%",
        marginTop: -4,
      }}
      animate={{ left: [0, 28] }}
      transition={{
        duration: 0.9,
        repeat: Infinity,
        delay,
        ease: "linear",
        repeatDelay: 1.4,
      }}
    />
    <div
      className="absolute right-0 top-1/2 -mt-1"
      style={{
        width: 0,
        height: 0,
        borderTop: "4px solid transparent",
        borderBottom: "4px solid transparent",
        borderLeft: `5px solid ${color}70`,
      }}
    />
  </div>
);

const DevOpsFlowSection = () => {
  const [activeStage, setActiveStage] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setActiveStage((prev) => (prev + 1) % stages.length);
    }, 1600);
    return () => clearInterval(interval);
  }, []);

  return (
    <section id="pipeline" className="py-24 relative overflow-hidden">
      <div className="absolute inset-0 grid-bg opacity-20" />

      <div className="container relative px-6">
        <motion.div
          initial={{ opacity: 0, y: 40 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="text-center mb-16"
        >
          <span className="font-mono text-primary text-sm">// pipeline</span>
          <h2 className="text-3xl md:text-4xl font-display font-bold mt-2">
            DevOps <span className="gradient-text">Flow</span>
          </h2>
          <p className="text-muted-foreground mt-3 text-sm font-mono">
            CI/CD end-to-end · commit to production
          </p>
        </motion.div>

        {/* Pipeline stages */}
        <div className="overflow-x-auto pb-6">
          <div className="flex items-start justify-start md:justify-center min-w-max md:min-w-0 gap-0 mx-auto">
            {stages.map((stage, i) => {
              const isActive = activeStage === i;
              const isPassed = i < activeStage;
              return (
                <div key={stage.id} className="flex items-center">
                  <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ delay: i * 0.08 }}
                    className="flex flex-col items-center w-[88px] md:w-[100px]"
                  >
                    {/* Stage card */}
                    <motion.div
                      animate={{
                        borderColor: isActive
                          ? stage.color
                          : isPassed
                          ? `${stage.color}60`
                          : "hsl(220 15% 18%)",
                        boxShadow: isActive
                          ? `0 0 20px ${stage.color}50, 0 0 40px ${stage.color}20`
                          : "none",
                      }}
                      transition={{ duration: 0.4 }}
                      className="w-[76px] h-[76px] md:w-[84px] md:h-[84px] rounded-xl border-2 bg-card/80 backdrop-blur-sm flex flex-col items-center justify-center gap-1 cursor-default"
                    >
                      <stage.Icon
                        size={22}
                        style={{ color: isActive ? stage.color : isPassed ? `${stage.color}90` : "#6b7280" }}
                      />
                      <span
                        className="text-[10px] font-mono font-bold tracking-wider"
                        style={{ color: isActive ? stage.color : isPassed ? `${stage.color}90` : "#6b7280" }}
                      >
                        {stage.label}
                      </span>
                      {isActive && (
                        <motion.div
                          initial={{ scale: 0 }}
                          animate={{ scale: 1 }}
                          className="flex items-center gap-1"
                        >
                          <div className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                          <span className="text-[9px] text-green-400 font-mono">running</span>
                        </motion.div>
                      )}
                      {isPassed && !isActive && (
                        <CheckCircle2 size={12} style={{ color: `${stage.color}80` }} />
                      )}
                    </motion.div>

                    {/* Tools */}
                    <div className="mt-2 flex flex-wrap gap-1 justify-center max-w-[90px]">
                      {stage.tools.map((tool) => (
                        <span
                          key={tool}
                          className="text-[9px] font-mono px-1.5 py-0.5 rounded"
                          style={{
                            border: `1px solid ${stage.color}30`,
                            color: `${stage.color}aa`,
                            backgroundColor: `${stage.color}10`,
                          }}
                        >
                          {tool}
                        </span>
                      ))}
                    </div>
                  </motion.div>

                  {i < stages.length - 1 && (
                    <FlowArrow color={stages[i + 1].color} delay={i * 0.45} />
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* SRE Metrics */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ delay: 0.5 }}
          className="mt-10 grid grid-cols-2 md:grid-cols-4 gap-4 max-w-2xl mx-auto"
        >
          {metrics.map((m) => (
            <div
              key={m.label}
              className="p-4 rounded-lg border border-border bg-card/50 text-center"
              style={{ borderColor: `${m.color}25` }}
            >
              <div
                className="text-xl md:text-2xl font-display font-bold"
                style={{ color: m.color }}
              >
                {m.value}
              </div>
              <div className="text-[11px] text-muted-foreground font-mono mt-1">{m.label}</div>
            </div>
          ))}
        </motion.div>
      </div>
    </section>
  );
};

export default DevOpsFlowSection;
