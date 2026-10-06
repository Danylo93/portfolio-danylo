export type ExamInfo = {
  id: string; title: string; code: string; description: string; minutes: number;
  guide: string; domains: { name: string; weight: number }[];
  questionCount: number; note?: string;
};

export const EXAMS: ExamInfo[] = [
  {
    id: "cloud-practitioner", title: "AWS Cloud Practitioner", code: "CLF-C02", minutes: 90,
    questionCount: 65,
    description: "Conceitos de nuvem, segurança, serviços AWS, custos e suporte.",
    guide: "https://docs.aws.amazon.com/aws-certification/latest/cloud-practitioner-02/cloud-practitioner-02.html",
    domains: [
      { name: "Conceitos da nuvem", weight: 24 }, { name: "Segurança e conformidade", weight: 30 },
      { name: "Tecnologia e serviços", weight: 34 }, { name: "Cobrança, preços e suporte", weight: 12 },
    ],
  },
  {
    id: "ai-practitioner", title: "AWS AI Practitioner", code: "AIF-C01", minutes: 90,
    questionCount: 65,
    description: "IA e ML, IA generativa, foundation models, IA responsável e governança.",
    guide: "https://docs.aws.amazon.com/aws-certification/latest/ai-practitioner-01/ai-practitioner-01.html",
    domains: [
      { name: "Fundamentos de IA e ML", weight: 20 }, { name: "Fundamentos de IA generativa", weight: 24 },
      { name: "Aplicações de foundation models", weight: 28 }, { name: "IA responsável", weight: 14 },
      { name: "Segurança, conformidade e governança", weight: 14 },
    ],
  },
  {
    id: "devops-professional", title: "AWS DevOps Engineer – Professional", code: "DOP-C02", minutes: 180,
    questionCount: 75,
    description: "Cenários de CI/CD, infraestrutura como código, resiliência, observabilidade, incidentes e segurança.",
    note: "A certificação AWS de DevOps é do nível Professional.",
    guide: "https://docs.aws.amazon.com/aws-certification/latest/devops-engineer-professional-02/devops-engineer-professional-02.html",
    domains: [
      { name: "Automação do SDLC", weight: 22 }, { name: "Configuração e IaC", weight: 17 },
      { name: "Soluções resilientes", weight: 15 }, { name: "Monitoramento e logs", weight: 15 },
      { name: "Resposta a incidentes e eventos", weight: 14 }, { name: "Segurança e conformidade", weight: 17 },
    ],
  },
];
