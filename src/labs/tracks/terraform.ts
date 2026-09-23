import "../tools/terraform";
import type { Lab, Track } from "../types";

export const track: Track = {
  id: "terraform",
  title: "Terraform Avançado",
  desc: "IaC na AWS de verdade: state remoto, módulos, workspaces, import, drift e refatoração segura.",
  color: "#c084fc",
  icon: "🏗",
};


export const labs: Lab[] = [
  {
    id: "terraform-eks",
    track: "terraform",
    kind: "lab",
    title: "Provisionar um cluster EKS com Terraform",
    summary: "IaC na AWS: VPC, EKS e node group.",
    level: "Avançado",
    minutes: 12,
    skills: ["terraform init", "terraform plan", "terraform apply", "terraform state"],
    seed: {
      files: {
        "main.tf": `terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}

provider "aws" { region = "sa-east-1" }

resource "aws_vpc" "lab" { cidr_block = "10.0.0.0/16" }

resource "aws_eks_cluster" "lab" {
  name     = "danylo-lab"
  version  = "1.30"
  role_arn = var.cluster_role_arn
  vpc_config { subnet_ids = var.subnet_ids }
}

resource "aws_eks_node_group" "workers" {
  cluster_name   = aws_eks_cluster.lab.name
  instance_types = ["t3.medium"]
  scaling_config {
    desired_size = 2
    max_size     = 4
    min_size     = 1
  }
}

output "cluster_endpoint" { value = aws_eks_cluster.lab.endpoint }
output "cluster_name"     { value = aws_eks_cluster.lab.name }`,
      },
    },
    intro: "O arquivo main.tf descreve uma VPC, um cluster EKS e um node group. Siga o fluxo padrão de IaC.",
    steps: [
      {
        title: "Revisar e inicializar",
        body: ["Leia o main.tf e inicialize o diretório para baixar o provider AWS."],
        code: ["cat main.tf", "terraform init"],
        hints: [
          "Todo diretório Terraform precisa ser inicializado antes do primeiro plan.",
          "O comando que baixa providers e prepara o backend é o init.",
          "terraform init",
        ],
        explain: [
          "O init leu o bloco required_providers, baixou o hashicorp/aws v5.62 para .terraform/ e criou o .terraform.lock.hcl, que fixa a versão exata (commite esse arquivo!).",
          "Em equipe, o init também configura o backend remoto (S3 + DynamoDB para lock), para que todos compartilhem o mesmo state.",
        ],
        check: (sh) => sh.state.tf.initialized,
      },
      {
        title: "Gerar o plano",
        body: ["O plan mostra exatamente o que será criado. Revise antes de aplicar — em CI, isso vira comentário no PR."],
        code: ["terraform plan"],
        hints: [
          "Antes de mudar infraestrutura real, veja o que vai mudar.",
          "O comando que faz o \"dry-run\" do Terraform é o plan.",
          "terraform plan",
        ],
        explain: [
          "O Terraform comparou o código com o state (vazio) e calculou: 3 to add, 0 to change, 0 to destroy. O símbolo + indica criação; ~ seria alteração e - destruição.",
          "Valores como id e endpoint aparecem como (known after apply) porque só a AWS os conhece depois de criar os recursos.",
        ],
        check: (sh) => sh.state.tf.planned,
      },
      {
        title: "Aplicar",
        body: ["Provisione os recursos."],
        code: ["terraform apply -auto-approve"],
        hints: [
          "Chegou a hora de executar o plano.",
          "terraform apply — em pipelines usa-se -auto-approve para não esperar confirmação.",
          "terraform apply -auto-approve",
        ],
        explain: [
          "O Terraform respeitou o grafo de dependências: VPC primeiro, depois o EKS (~10 min, o control plane é gerenciado pela AWS) e por fim o node group.",
          "Os outputs no final (cluster_endpoint, cluster_name) podem alimentar outros módulos ou o pipeline — por exemplo, para gerar o kubeconfig com aws eks update-kubeconfig.",
        ],
        check: (sh) => sh.state.tf.applied,
      },
      {
        title: "Inspecionar o state",
        body: ["Liste os recursos gerenciados e leia os outputs."],
        code: ["terraform state list", "terraform output"],
        hints: [
          "O Terraform guarda tudo o que criou num arquivo de state.",
          "terraform state list mostra os recursos rastreados.",
          "terraform state list",
        ],
        explain: [
          "O state mapeia cada recurso do código ao ID real na AWS. Ele é a fonte da verdade do Terraform — perdê-lo significa perder o controle da infra.",
          "Boas práticas: backend remoto criptografado, lock de concorrência e nunca editar o state à mão (use terraform state mv/rm/import).",
        ],
        diagnose: (sh) => (!sh.state.tf.applied ? "Ainda não há nada no state — rode terraform apply antes." : null),
        check: (sh) => sh.ran(/^(terraform|tf) state list/) && sh.state.tf.applied,
      },
    ],
    outro: "Infra provisionada como código. Em produção: backend remoto S3 + lock no DynamoDB e pipeline com plan/apply aprovados.",
  },
];
