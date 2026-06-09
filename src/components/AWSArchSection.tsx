import { motion } from "framer-motion";
import { Cloud, Server, Database, Monitor, Lock, Zap, Globe, Layers, Eye, Box } from "lucide-react";

interface ServiceItem {
  name: string;
  tag: string;
  color: string;
  Icon: React.ComponentType<{ size?: number; style?: React.CSSProperties }>;
  desc?: string;
}

const devTools: ServiceItem[] = [
  { name: "GitHub", tag: "Source", color: "#f0f6fc", Icon: Globe },
  { name: "GitHub Actions", tag: "CI/CD", color: "#2ea44f", Icon: Zap },
  { name: "GitLab CI", tag: "CI/CD", color: "#fc6d26", Icon: Zap },
  { name: "Terraform", tag: "IaC", color: "#7b42f6", Icon: Layers },
  { name: "Ansible", tag: "Config", color: "#ee0000", Icon: Server },
  { name: "ArgoCD", tag: "GitOps", color: "#ef7b4d", Icon: Box },
];

const awsServices: ServiceItem[] = [
  { name: "Amazon EKS", tag: "Kubernetes", color: "#FF9900", Icon: Server, desc: "Managed K8s" },
  { name: "Amazon ECR", tag: "Registry", color: "#FF9900", Icon: Box, desc: "Container images" },
  { name: "AWS Lambda", tag: "Serverless", color: "#FF9900", Icon: Zap, desc: "Event-driven" },
  { name: "API Gateway", tag: "Gateway", color: "#FF9900", Icon: Globe, desc: "HTTP/REST APIs" },
  { name: "CloudWatch", tag: "Observability", color: "#FF9900", Icon: Monitor, desc: "Logs & metrics" },
  { name: "Amazon VPC", tag: "Network", color: "#FF9900", Icon: Lock, desc: "Isolated network" },
];

const observabilityTools: ServiceItem[] = [
  { name: "Prometheus", tag: "Metrics", color: "#e6522c", Icon: Database },
  { name: "Grafana", tag: "Dashboards", color: "#f46800", Icon: Monitor },
  { name: "OpenTelemetry", tag: "Tracing", color: "#425cc7", Icon: Layers },
  { name: "ELK Stack", tag: "Logs", color: "#00bfb3", Icon: Layers },
  { name: "Kibana", tag: "Visualization", color: "#00bfb3", Icon: Eye },
];

const EKSPods = () => {
  const pods = Array.from({ length: 6 }, (_, i) => i);
  return (
    <div
      className="p-3 rounded-lg border border-dashed mb-2"
      style={{ borderColor: "#FF990040", backgroundColor: "#FF990008" }}
    >
      <div className="text-[10px] font-mono mb-2 flex items-center gap-1" style={{ color: "#FF9900" }}>
        <span>☸</span>
        <span>EKS Cluster · us-east-1</span>
      </div>
      <div className="grid grid-cols-3 gap-1.5">
        {pods.map((i) => (
          <motion.div
            key={i}
            className="h-7 rounded flex items-center justify-center text-[9px] font-mono"
            style={{
              backgroundColor: "#FF990012",
              border: "1px solid #FF990030",
              color: "#FF9900aa",
            }}
            animate={{
              boxShadow: [
                "0 0 0px #FF990000",
                "0 0 8px #FF990060",
                "0 0 0px #FF990000",
              ],
              borderColor: ["#FF990030", "#FF990080", "#FF990030"],
            }}
            transition={{
              duration: 2.5,
              repeat: Infinity,
              delay: i * 0.4,
              ease: "easeInOut",
            }}
          >
            pod-{i + 1}
          </motion.div>
        ))}
      </div>
    </div>
  );
};

const ServiceCard = ({ item, delay }: { item: ServiceItem; delay: number }) => (
  <motion.div
    initial={{ opacity: 0, y: 10 }}
    whileInView={{ opacity: 1, y: 0 }}
    viewport={{ once: true }}
    transition={{ delay }}
    whileHover={{ x: 3 }}
    className="flex items-center gap-2 p-2.5 rounded-lg border transition-all cursor-default"
    style={{ borderColor: `${item.color}25`, backgroundColor: `${item.color}08` }}
  >
    <div
      className="w-7 h-7 rounded flex items-center justify-center flex-shrink-0"
      style={{ backgroundColor: `${item.color}18` }}
    >
      <item.Icon size={14} style={{ color: item.color }} />
    </div>
    <div className="min-w-0">
      <div className="text-xs font-mono font-medium text-foreground leading-tight truncate">
        {item.name}
      </div>
      <div className="text-[10px] font-mono leading-tight" style={{ color: `${item.color}80` }}>
        {item.tag}
      </div>
    </div>
    {item.desc && (
      <div className="text-[9px] text-muted-foreground ml-auto hidden lg:block">{item.desc}</div>
    )}
  </motion.div>
);

const ColumnConnector = () => (
  <div className="hidden md:flex flex-col items-center justify-center gap-2 px-1 py-4 self-stretch">
    {[0, 1, 2, 3, 4].map((i) => (
      <motion.div
        key={i}
        className="w-1.5 h-1.5 rounded-full"
        style={{ backgroundColor: "hsl(155 80% 50%)" }}
        animate={{ opacity: [0.15, 0.9, 0.15], scale: [0.8, 1.2, 0.8] }}
        transition={{ duration: 2, repeat: Infinity, delay: i * 0.3 }}
      />
    ))}
  </div>
);

const clouds = [
  { name: "AWS", color: "#FF9900" },
  { name: "Azure", color: "#0078D4" },
  { name: "GCP", color: "#4285F4" },
  { name: "On-Premise", color: "#6b7280" },
  { name: "Multi-Cloud", color: "#4ade80" },
];

const AWSArchSection = () => {
  return (
    <section id="architecture" className="py-24 relative overflow-hidden">
      <div className="absolute inset-0 grid-bg opacity-10" />

      <div className="container relative px-6">
        <motion.div
          initial={{ opacity: 0, y: 40 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="text-center mb-16"
        >
          <span className="font-mono text-primary text-sm">// infraestrutura</span>
          <h2 className="text-3xl md:text-4xl font-display font-bold mt-2">
            Cloud <span className="gradient-text">Architecture</span>
          </h2>
          <p className="text-muted-foreground mt-3 text-sm">
            Multi-cloud · AWS · Azure · GCP · On-Premise
          </p>
        </motion.div>

        <div className="max-w-5xl mx-auto">
          <div className="flex flex-col md:flex-row gap-0 md:gap-0 items-stretch">

            {/* Dev Tools Column */}
            <motion.div
              initial={{ opacity: 0, x: -30 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.6 }}
              className="flex-1"
            >
              <div className="h-full rounded-xl border border-border/50 bg-card/30 overflow-hidden">
                <div className="px-4 py-3 border-b border-border/50">
                  <span className="text-[11px] font-mono text-primary">// dev & iac</span>
                  <h3 className="text-sm font-display font-semibold mt-0.5 text-foreground">
                    Developer Tools
                  </h3>
                </div>
                <div className="p-3 space-y-2">
                  {devTools.map((item, i) => (
                    <ServiceCard key={item.name} item={item} delay={i * 0.07} />
                  ))}
                </div>
              </div>
            </motion.div>

            <ColumnConnector />

            {/* AWS Cloud Column */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.6, delay: 0.15 }}
              className="flex-1"
            >
              <div
                className="h-full rounded-xl overflow-hidden"
                style={{
                  border: "2px solid #FF990035",
                  background: "rgba(255,153,0,0.03)",
                }}
              >
                <div
                  className="px-4 py-3 border-b"
                  style={{ borderColor: "#FF990025" }}
                >
                  <span
                    className="text-[11px] font-mono flex items-center gap-1.5"
                    style={{ color: "#FF9900" }}
                  >
                    <Cloud size={12} />
                    // aws cloud
                  </span>
                  <h3 className="text-sm font-display font-semibold mt-0.5 flex items-center gap-2 text-foreground">
                    Amazon Web Services
                  </h3>
                </div>
                <div className="p-3">
                  <EKSPods />
                  <div className="space-y-2">
                    {awsServices
                      .filter((s) => s.name !== "Amazon EKS")
                      .map((item, i) => (
                        <ServiceCard key={item.name} item={item} delay={i * 0.07 + 0.15} />
                      ))}
                  </div>
                </div>
              </div>
            </motion.div>

            <ColumnConnector />

            {/* Observability Column */}
            <motion.div
              initial={{ opacity: 0, x: 30 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.6, delay: 0.3 }}
              className="flex-1"
            >
              <div className="h-full rounded-xl border border-border/50 bg-card/30 overflow-hidden">
                <div className="px-4 py-3 border-b border-border/50">
                  <span className="text-[11px] font-mono text-accent">// observability</span>
                  <h3 className="text-sm font-display font-semibold mt-0.5 text-foreground">
                    Monitoring & Logs
                  </h3>
                </div>
                <div className="p-3 space-y-2">
                  {observabilityTools.map((item, i) => (
                    <ServiceCard key={item.name} item={item} delay={i * 0.07 + 0.3} />
                  ))}
                </div>
              </div>
            </motion.div>
          </div>

          {/* Multi-cloud badges */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ delay: 0.5 }}
            className="mt-8 flex flex-wrap justify-center gap-3"
          >
            {clouds.map((cloud) => (
              <motion.span
                key={cloud.name}
                whileHover={{ scale: 1.05 }}
                className="px-4 py-2 rounded-full font-mono text-xs font-medium cursor-default"
                style={{
                  border: `1px solid ${cloud.color}40`,
                  color: cloud.color,
                  backgroundColor: `${cloud.color}10`,
                }}
              >
                {cloud.name}
              </motion.span>
            ))}
          </motion.div>
        </div>
      </div>
    </section>
  );
};

export default AWSArchSection;
