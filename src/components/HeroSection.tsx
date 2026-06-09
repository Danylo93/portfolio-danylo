import { motion } from "framer-motion";
import { useEffect, useState } from "react";
import { Terminal, ChevronRight, Download } from "lucide-react";

const commands = [
  "$ whoami",
  "> Danylo Alves de Oliveira — São Paulo, BR",
  "$ cat role.txt",
  "> Senior Infrastructure Engineer | DevOps/SRE",
  "$ kubectl get nodes --all-namespaces",
  "> eks-prod-node-01   Ready   <5+ years>",
  "$ terraform --version",
  "> AWS · Azure · GCP · EKS · Ansible · ArgoCD",
  "$ echo $SLO",
  "> 99.9% · incident response · post-mortem",
];

const TypingText = ({ text, delay }: { text: string; delay: number }) => {
  const [displayed, setDisplayed] = useState("");
  const [done, setDone] = useState(false);

  useEffect(() => {
    const timeout = setTimeout(() => {
      let i = 0;
      const speed = text.startsWith(">") ? 16 : 30;
      const interval = setInterval(() => {
        setDisplayed(text.slice(0, i + 1));
        i++;
        if (i >= text.length) {
          clearInterval(interval);
          setDone(true);
        }
      }, speed);
      return () => clearInterval(interval);
    }, delay);
    return () => clearTimeout(timeout);
  }, [text, delay]);

  const isCommand = text.startsWith("$");
  const isOutput = text.startsWith(">");

  return (
    <span
      className={
        isOutput
          ? "text-primary"
          : isCommand
          ? "text-accent"
          : "text-foreground"
      }
    >
      {displayed}
      {!done && <span className="terminal-cursor text-primary">▊</span>}
    </span>
  );
};

const HeroSection = () => {
  return (
    <section className="relative min-h-screen flex items-center justify-center overflow-hidden">
      <div className="absolute inset-0 grid-bg opacity-40" />
      <div className="absolute inset-0 scanline" />

      {/* Floating blobs */}
      <motion.div
        className="absolute top-1/4 left-1/4 w-72 h-72 rounded-full bg-primary/5 blur-3xl"
        animate={{ x: [0, 40, 0], y: [0, -25, 0] }}
        transition={{ duration: 9, repeat: Infinity, ease: "easeInOut" }}
      />
      <motion.div
        className="absolute bottom-1/3 right-1/4 w-96 h-96 rounded-full bg-accent/5 blur-3xl"
        animate={{ x: [0, -50, 0], y: [0, 35, 0] }}
        transition={{ duration: 11, repeat: Infinity, ease: "easeInOut" }}
      />
      <motion.div
        className="absolute top-1/2 right-1/3 w-48 h-48 rounded-full blur-3xl"
        style={{ backgroundColor: "#FF990008" }}
        animate={{ x: [0, 25, 0], y: [0, -20, 0] }}
        transition={{ duration: 7, repeat: Infinity, ease: "easeInOut" }}
      />

      <div className="container relative z-10 px-6">
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8 }}
          className="max-w-3xl mx-auto"
        >
          {/* Terminal window */}
          <div className="rounded-xl border border-border bg-card/80 backdrop-blur-sm overflow-hidden box-glow">
            {/* Title bar */}
            <div className="flex items-center gap-2 px-4 py-3 border-b border-border bg-secondary/60">
              <div className="w-3 h-3 rounded-full bg-destructive/70" />
              <div className="w-3 h-3 rounded-full bg-yellow-500/50" />
              <div className="w-3 h-3 rounded-full bg-primary/70" />
              <span className="ml-2 text-xs font-mono text-muted-foreground flex items-center gap-1.5">
                <Terminal size={11} />
                danylo@devops:~/infrastructure
              </span>
              <div className="ml-auto flex items-center gap-1.5">
                <div className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                <span className="text-[10px] font-mono text-green-400/80">ONLINE</span>
              </div>
            </div>

            {/* Terminal body */}
            <div className="p-5 font-mono text-sm leading-loose space-y-0.5">
              {commands.map((cmd, i) => (
                <div key={i}>
                  <TypingText text={cmd} delay={i * 1200} />
                </div>
              ))}
            </div>
          </div>

          {/* Hero text */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 11, duration: 1 }}
            className="mt-10 text-center"
          >
            <h1 className="text-4xl md:text-6xl font-display font-bold mb-3">
              <span className="gradient-text">Danylo</span>{" "}
              <span className="text-foreground">Oliveira</span>
            </h1>
            <p className="text-muted-foreground text-base md:text-lg mb-2">
              Senior Infrastructure Engineer · DevOps/SRE
            </p>
            <p className="text-muted-foreground/60 text-sm font-mono mb-8">
              Automatizando o futuro, um pipeline por vez.
            </p>
            <div className="flex items-center justify-center gap-4 flex-wrap">
              <motion.a
                href="#about"
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                className="inline-flex items-center gap-2 px-6 py-3 rounded-lg bg-primary text-primary-foreground font-medium transition-all box-glow"
              >
                Explorar <ChevronRight size={16} />
              </motion.a>
              <motion.a
                href="https://www.linkedin.com/in/danylo-oliveira-ti/"
                target="_blank"
                rel="noopener noreferrer"
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                className="inline-flex items-center gap-2 px-6 py-3 rounded-lg border border-border bg-card/50 text-foreground font-medium transition-all hover:border-glow"
              >
                <Download size={16} className="text-primary" /> LinkedIn
              </motion.a>
            </div>
          </motion.div>
        </motion.div>
      </div>
    </section>
  );
};

export default HeroSection;
