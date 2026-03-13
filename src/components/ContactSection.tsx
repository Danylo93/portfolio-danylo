import { motion } from "framer-motion";
import { Github, Linkedin, Mail, Send, MessageCircle } from "lucide-react";

const socials = [
  { icon: Github, label: "GitHub", href: "https://github.com/Danylo93" },
  { icon: Linkedin, label: "LinkedIn", href: "https://www.linkedin.com/in/danylo-oliveira-ti/" },
  { icon: Mail, label: "Email", href: "mailto:danylo.oliveira73@gmail.com" },
  { icon: MessageCircle, label: "WhatsApp", href: "https://wa.me/5511964891128" },
];

const ContactSection = () => {
  return (
    <section id="contact" className="py-24 relative">
      <div className="absolute inset-0 grid-bg opacity-20" />
      <div className="container relative px-6">
        <motion.div
          initial={{ opacity: 0, y: 40 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="text-center max-w-xl mx-auto"
        >
          <span className="font-mono text-primary text-sm">// contato</span>
          <h2 className="text-3xl md:text-4xl font-display font-bold mt-2 mb-4">
            Vamos <span className="gradient-text">Conversar</span>
          </h2>
          <p className="text-muted-foreground mb-10">
            Interessado em trabalhar juntos? Entre em contato por email ou conecte-se comigo nas redes.
          </p>

          <div className="flex justify-center gap-4 mb-10">
            {socials.map((social, i) => (
              <motion.a
                key={social.label}
                href={social.href}
                target="_blank"
                rel="noopener noreferrer"
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: i * 0.1 }}
                whileHover={{ y: -4, scale: 1.1 }}
                className="p-4 rounded-lg border border-border bg-card/50 backdrop-blur-sm hover:border-glow hover:box-glow transition-all"
                title={social.label}
              >
                <social.icon size={22} className="text-foreground" />
              </motion.a>
            ))}
          </div>

          <motion.a
            href="https://wa.me/5511964891128"
            target="_blank"
            rel="noopener noreferrer"
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            className="inline-flex items-center gap-2 px-6 py-3 rounded-md bg-primary text-primary-foreground font-medium box-glow"
          >
            <MessageCircle size={16} /> WhatsApp
          </motion.a>
        </motion.div>
      </div>
    </section>
  );
};

export default ContactSection;
