export type ExamInfo = {
  id: string; title: string; code: string; description: string; minutes: number;
  guide: string; domains: { name: string; weight: number }[];
};

export const EXAMS: ExamInfo[] = [
  {
    id: "cloud-practitioner", title: "AWS Cloud Practitioner", code: "CLF-C02", minutes: 90,
    description: "Conceitos de nuvem, segurança, serviços AWS, custos e suporte.",
    guide: "https://docs.aws.amazon.com/aws-certification/latest/cloud-practitioner-02/cloud-practitioner-02.html",
    domains: [
      { name: "Conceitos da nuvem", weight: 24 }, { name: "Segurança e conformidade", weight: 30 },
      { name: "Tecnologia e serviços", weight: 34 }, { name: "Cobrança, preços e suporte", weight: 12 },
    ],
  },
  {
    id: "ai-practitioner", title: "AWS AI Practitioner", code: "AIF-C01", minutes: 90,
    description: "IA e ML, IA generativa, foundation models, IA responsável e governança.",
    guide: "https://docs.aws.amazon.com/aws-certification/latest/ai-practitioner-01/ai-practitioner-01.html",
    domains: [
      { name: "Fundamentos de IA e ML", weight: 20 }, { name: "Fundamentos de IA generativa", weight: 24 },
      { name: "Aplicações de foundation models", weight: 28 }, { name: "IA responsável", weight: 14 },
      { name: "Segurança, conformidade e governança", weight: 14 },
    ],
  },
];
