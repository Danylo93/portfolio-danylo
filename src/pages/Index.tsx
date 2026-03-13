import Navbar from "@/components/Navbar";
import HeroSection from "@/components/HeroSection";
import AboutSection from "@/components/AboutSection";
import SkillsSection from "@/components/SkillsSection";
import ExperienceSection from "@/components/ExperienceSection";
import ProjectsSection from "@/components/ProjectsSection";
import ContactSection from "@/components/ContactSection";

const Index = () => {
  return (
    <div className="min-h-screen bg-background">
      <Navbar />
      <HeroSection />
      <AboutSection />
      <SkillsSection />
      <ExperienceSection />
      <ProjectsSection />
      <ContactSection />
      <footer className="py-8 text-center border-t border-border">
        <p className="text-sm font-mono text-muted-foreground">
          © 2026 Danylo Oliveira · Built with <span className="text-primary">♥</span> and automation
        </p>
      </footer>
    </div>
  );
};

export default Index;
