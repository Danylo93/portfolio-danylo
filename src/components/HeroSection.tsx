import { motion } from "framer-motion";
import { useEffect, useState } from "react";
import { Terminal, ChevronRight } from "lucide-react";

const commands = [
  "$ whoami",
  "> Danylo Alves de Oliveira",
  "$ cat role.txt",
  "> DevOps Engineer | Senior Infrastructure Engineer",
  "$ cat skills.txt",
  "> CI/CD • Kubernetes • Terraform • AWS • Docker • ArgoCD",
  "$ uptime",
  "> 4+ anos de experiência em infraestrutura e DevOps",
];

const TypingText = ({ text, delay }: { text: string; delay: number }) => {
  const [displayed, setDisplayed] = useState("");
  const [done, setDone] = useState(false);

  useEffect(() => {
    const timeout = setTimeout(() => {
      let i = 0;
      const interval = setInterval(() => {
        setDisplayed(text.slice(0, i + 1));
        i++;
        if (i >= text.length) {
          clearInterval(interval);
          setDone(true);
        }
      }, text.startsWith(">") ? 18 : 35);
      return () => clearInterval(interval);
    }, delay);
    return () => clearTimeout(timeout);
  }, [text, delay]);

  return (
    <span className={text.startsWith(">") ? "text-primary" : "text-foreground"}>
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

      <motion.div
        className="absolute top-1/4 left-1/4 w-64 h-64 rounded-full bg-primary/5 blur-3xl"
        animate={{ x: [0, 30, 0], y: [0, -20, 0] }}
        transition={{ duration: 8, repeat: Infinity, ease: "easeInOut" }}
      />
      <motion.div
        className="absolute bottom-1/4 right-1/4 w-96 h-96 rounded-full bg-accent/5 blur-3xl"
        animate={{ x: [0, -40, 0], y: [0, 30, 0] }}
        transition={{ duration: 10, repeat: Infinity, ease: "easeInOut" }}
      />

      <div className="container relative z-10 px-6">
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8 }}
          className="max-w-3xl mx-auto"
        >
          <div className="rounded-lg border border-border bg-card/80 backdrop-blur-sm overflow-hidden box-glow">
            <div className="flex items-center gap-2 px-4 py-3 border-b border-border bg-secondary/50">
              <div className="w-3 h-3 rounded-full bg-destructive/70" />
              <div className="w-3 h-3 rounded-full bg-primary/40" />
              <div className="w-3 h-3 rounded-full bg-primary/70" />
              <span className="ml-2 text-xs font-mono text-muted-foreground flex items-center gap-1">
                <Terminal size={12} /> danylo@devops:~
              </span>
            </div>

            <div className="p-6 font-mono text-sm leading-relaxed space-y-1">
              {commands.map((cmd, i) => (
                <div key={i}>
                  <TypingText text={cmd} delay={i * 1400} />
                </div>
              ))}
            </div>
          </div>

          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 10, duration: 1 }}
            className="mt-10 text-center"
          >
            <h1 className="text-4xl md:text-6xl font-display font-bold mb-4">
              <span className="gradient-text">Danylo</span>{" "}
              <span className="text-foreground">Oliveira</span>
            </h1>
            <p className="text-muted-foreground text-lg mb-8">
              DevOps Engineer · Automatizando o futuro, um pipeline por vez.
            </p>
            <motion.a
              href="#about"
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              className="inline-flex items-center gap-2 px-6 py-3 rounded-md bg-primary text-primary-foreground font-medium transition-all box-glow"
            >
              Explore <ChevronRight size={16} />
            </motion.a>
          </motion.div>
        </motion.div>
      </div>
    </section>
  );
};

export default HeroSection;
