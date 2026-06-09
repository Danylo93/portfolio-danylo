import Navbar from "@/components/Navbar";
import HeroSection from "@/components/HeroSection";
import AboutSection from "@/components/AboutSection";
import SLODashboard from "@/components/SLODashboard";
import IncidentSection from "@/components/IncidentSection";
import ObservabilitySection from "@/components/ObservabilitySection";
import SkillsSection from "@/components/SkillsSection";
import ExperienceSection from "@/components/ExperienceSection";
import ProjectsSection from "@/components/ProjectsSection";
import ContactSection from "@/components/ContactSection";

const Index = () => (
  <div className="min-h-screen bg-background">
    <Navbar />
    <HeroSection />
    <AboutSection />
    <SLODashboard />
    <IncidentSection />
    <ObservabilitySection />
    <SkillsSection />
    <ExperienceSection />
    <ProjectsSection />
    <ContactSection />
    <footer className="py-8 text-center border-t border-border">
      <p className="text-sm font-mono text-muted-foreground">
        © 2026 Danylo Oliveira · SRE Portfolio ·{" "}
        <span className="text-primary">99.9% uptime</span> commitment
      </p>
    </footer>
  </div>
);

export default Index;
