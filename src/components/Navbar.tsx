import { motion } from "framer-motion";
import { FlaskConical, Terminal } from "lucide-react";
import { Link } from "react-router-dom";

const links = [
  { label: "Sobre", href: "#about" },
  { label: "Pipeline", href: "#pipeline" },
  { label: "Cloud", href: "#architecture" },
  { label: "Skills", href: "#skills" },
  { label: "Experiência", href: "#experience" },
  { label: "Projetos", href: "#projects" },
  { label: "Contato", href: "#contact" },
];

const Navbar = () => {
  return (
    <motion.nav
      initial={{ y: -80 }}
      animate={{ y: 0 }}
      transition={{ duration: 0.6 }}
      className="fixed top-0 left-0 right-0 z-50 border-b border-border bg-background/85 backdrop-blur-md"
    >
      <div className="container px-6 flex items-center justify-between h-16">
        <a href="#" className="flex items-center gap-2 font-mono text-primary font-bold text-sm">
          <Terminal size={17} />
          <span>
            danylo<span className="animate-pulse-glow">_</span>devops
          </span>
        </a>

        <div className="hidden md:flex items-center gap-6">
          {links.map((link) => (
            <a
              key={link.label}
              href={link.href}
              className="text-xs text-muted-foreground hover:text-primary transition-colors font-mono"
            >
              {link.label}
            </a>
          ))}
          <Link
            to="/labs"
            className="flex items-center gap-1.5 text-xs font-mono px-2.5 py-1 rounded-md border border-primary/40 text-primary hover:bg-primary/10 transition-colors"
          >
            <FlaskConical size={12} /> Labs
          </Link>
        </div>

        <div className="flex items-center gap-2">
          <Link to="/labs" className="md:hidden flex items-center gap-1 text-[10px] font-mono text-primary mr-2">
            <FlaskConical size={12} /> Labs
          </Link>
          <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
          <span className="text-[10px] font-mono text-green-400/70 hidden sm:block">open to work</span>
        </div>
      </div>
    </motion.nav>
  );
};

export default Navbar;
