import {
  tfBackend, tfCloud, tfCloudGet, tfCloudPut, tfConfig, tfConfigErrors, tfLastPlan, tfLocks, tfOutputsIn, tfPreview, tfSeedRun, tfSetLock, tfState, tfWorkspace,
} from "../tools/terraform";
import type { Shell } from "../shell";
import type { Lab, Lesson, Track } from "../types";

export const track: Track = {
  id: "terraform",
  title: "Terraform Avançado",
  desc: "Terraform como se usa em produção na AWS: state remoto no S3 com lock no DynamoDB, refatoração para módulos sem destruir nada (moved), workspaces por ambiente, import de recursos criados no console, detecção de drift e recuperação de pipelines travados.",
  color: "#c084fc",
  icon: "🏗",
};

const PROVIDER = `terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = "sa-east-1"
}
`;

/** Bucket + DynamoDB table created by the platform "bootstrap" stack. */
const bootstrapBackend = (sh: Shell) => {
  tfCloudPut(sh, "aws_s3_bucket", "acme-tfstate-prod", {
    id: "acme-tfstate-prod", bucket: "acme-tfstate-prod", arn: "arn:aws:s3:::acme-tfstate-prod", tags: { ManagedBy: "bootstrap" },
  });
  tfCloudPut(sh, "aws_dynamodb_table", "terraform-locks", {
    id: "terraform-locks", name: "terraform-locks", hash_key: "LockID", arn: "arn:aws:dynamodb:sa-east-1:123456789012:table/terraform-locks",
  });
};

const tfRan = (sh: Shell, re: RegExp) => sh.ran(new RegExp(`^(terraform|tf) ${re.source}`));
const lastOutputOf = (sh: Shell, re: RegExp) => [...sh.entries].reverse().find((e) => new RegExp(`^(terraform|tf) ${re.source}`).test(e.cmd))?.output ?? "";

// ---------------- lab seeds ----------------
const NETWORK_TF = `${PROVIDER}
resource "aws_vpc" "main" {
  cidr_block           = "10.40.0.0/16"
  enable_dns_hostnames = true
  tags = {
    Name = "acme-network-prod"
  }
}

resource "aws_subnet" "private" {
  count             = 2
  vpc_id            = aws_vpc.main.id
  cidr_block        = cidrsubnet(aws_vpc.main.cidr_block, 4, count.index)
  availability_zone = element(["sa-east-1a", "sa-east-1b"], count.index)
  tags = {
    Name = "acme-private-\${count.index}"
  }
}

output "vpc_id" {
  value = aws_vpc.main.id
}
`;

const bucketPair = (name: string, bucket: string) => `resource "aws_s3_bucket" "${name}" {
  bucket = "${bucket}"
  tags = {
    Team = "platform"
  }
}

resource "aws_s3_bucket_versioning" "${name}" {
  bucket = aws_s3_bucket.${name}.id
  versioning_configuration {
    status = "Enabled"
  }
}
`;

const MODULES_OLD = `${PROVIDER}
${bucketPair("logs", "acme-prod-logs")}
${bucketPair("artifacts", "acme-prod-artifacts")}`;

const MODULES_NEW = `${PROVIDER}
module "logs" {
  source      = "./modules/s3-bucket"
  bucket_name = "acme-prod-logs"
  team        = "platform"
}

module "artifacts" {
  source      = "./modules/s3-bucket"
  bucket_name = "acme-prod-artifacts"
  team        = "platform"
}

output "bucket_arns" {
  value = [module.logs.arn, module.artifacts.arn]
}
`;

const S3_MODULE = `variable "bucket_name" {
  type        = string
  description = "Nome globalmente único do bucket"
}

variable "team" {
  type = string
}

resource "aws_s3_bucket" "this" {
  bucket = var.bucket_name
  tags = {
    Team = var.team
  }
}

resource "aws_s3_bucket_versioning" "this" {
  bucket = aws_s3_bucket.this.id
  versioning_configuration {
    status = "Enabled"
  }
}

output "arn" {
  value = aws_s3_bucket.this.arn
}
`;

export const MOVED_TF = ["logs", "artifacts"]
  .flatMap((m) => [
    `moved {\n  from = aws_s3_bucket.${m}\n  to   = module.${m}.aws_s3_bucket.this\n}\n`,
    `moved {\n  from = aws_s3_bucket_versioning.${m}\n  to   = module.${m}.aws_s3_bucket_versioning.this\n}\n`,
  ])
  .join("\n");

const WEB_TF = `terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
  backend "s3" {
    bucket         = "acme-tfstate-prod"
    key            = "web/terraform.tfstate"
    region         = "sa-east-1"
    dynamodb_table = "terraform-locks"
    encrypt        = true
  }
}

provider "aws" {
  region = "sa-east-1"
}

variable "instance_type" {
  type = string
}

variable "instance_count" {
  type = number
}

variable "ami_id" {
  type    = string
  default = "ami-0c1a7f89451184c8b"
}

resource "aws_instance" "web" {
  count         = var.instance_count
  ami           = var.ami_id
  instance_type = var.instance_type
  tags = {
    Name        = "web-\${terraform.workspace}-\${count.index}"
    Environment = terraform.workspace
  }
}

output "instance_ids" {
  value = aws_instance.web[*].id
}

output "instance_type" {
  value = var.instance_type
}
`;

const ASSETS_TF = `${PROVIDER}
resource "aws_s3_bucket" "assets" {
  bucket = "acme-web-assets"
  tags = {
    Owner       = "platform"
    Environment = "prod"
  }
}

resource "aws_s3_bucket_versioning" "assets" {
  bucket = aws_s3_bucket.assets.id
  versioning_configuration {
    status = "Enabled"
  }
}
`;

export const LEGACY_TF = `resource "aws_s3_bucket" "finance_reports" {
  bucket = "acme-finance-reports"
  tags = {
    Owner      = "finance"
    CostCenter = "cc-1234"
  }
}
`;

const OBS_HEAD = `terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
  backend "s3" {
    bucket         = "acme-tfstate-prod"
    key            = "platform/observability.tfstate"
    region         = "sa-east-1"
    dynamodb_table = "terraform-locks"
  }
}

provider "aws" {
  region = "sa-east-1"
}

variable "environment" {
  type    = string
  default = "prod"
}

locals {
  common_tags = {
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

resource "aws_cloudwatch_log_group" "app" {
  name              = "/acme/\${var.environment}/app"
  retention_in_days = 30
  tags              = local.common_tags
}
`;

const OBS_BROKEN = `${OBS_HEAD}
# PR #482: log group de auditoria exigido pelo time de segurança (retenção de 1 ano)
resource "aws_cloudwatch_log_group" "audit" {
  name              = "/acme/\${var.enviroment}/audit"
  retention_in_days 365
  tags              = local.common_tags
}
`;

export const LOCK_ID = "9f1c2e7a-4b3d-4e8f-a1c6-5d2b7e9f0a34";

const bucketDeclared = (sh: Shell, bucket: string) =>
  tfConfig(sh).resources.some((r) => r.type === "aws_s3_bucket" && r.body.attrs.some((a) => a.name === "bucket" && a.expr.t === "lit" && a.expr.v === bucket));

// ---------------- labs ----------------
export const labs: Lab[] = [
  {
    id: "terraform-eks",
    track: "terraform",
    kind: "lab",
    title: "Provisionar um cluster EKS com Terraform",
    summary: "IaC na AWS: VPC, EKS e node group.",
    level: "Intermediário",
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
  cluster_name    = aws_eks_cluster.lab.name
  node_group_name = "workers"
  instance_types  = ["t3.medium"]
  scaling_config {
    desired_size = 2
    max_size     = 4
    min_size     = 1
  }
}

output "cluster_endpoint" { value = aws_eks_cluster.lab.endpoint }
output "cluster_name"     { value = aws_eks_cluster.lab.name }`,
        "variables.tf": `variable "cluster_role_arn" {
  type    = string
  default = "arn:aws:iam::123456789012:role/danylo-lab-eks-cluster"
}

variable "subnet_ids" {
  type    = list(string)
  default = ["subnet-0a1b2c3d4e5f60001", "subnet-0a1b2c3d4e5f60002"]
}
`,
      },
    },
    intro: "O arquivo main.tf descreve uma VPC, um cluster EKS e um node group. Siga o fluxo padrão de IaC.",
    steps: [
      {
        title: "Revisar e inicializar",
        body: ["Leia o main.tf e inicialize o diretório para baixar o provider AWS."],
        code: ["terraform init", "cat main.tf"],
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

  // ---------------------------------------------------------------------------
  {
    id: "terraform-remote-state",
    track: "terraform",
    kind: "lab",
    title: "Migrar o state local para S3 com lock no DynamoDB",
    summary: "Tire o terraform.tfstate do notebook: backend S3 criptografado, lock no DynamoDB e migração sem recriar nada.",
    level: "Intermediário",
    minutes: 15,
    skills: ["backend s3", "state locking", "terraform init -migrate-state", "state list"],
    seed: {
      files: { "main.tf": NETWORK_TF },
      setup: (sh) => {
        bootstrapBackend(sh);
        tfSeedRun(sh, "terraform init");
        tfSeedRun(sh, "terraform apply -auto-approve");
      },
    },
    intro:
      "A rede de produção (VPC + 2 subnets privadas) foi criada por um colega que rodou terraform apply do próprio notebook: o state está num terraform.tfstate local. O time de plataforma já criou o bucket acme-tfstate-prod e a tabela DynamoDB terraform-locks (stack de bootstrap). Sua missão: migrar o state para lá sem recriar nenhum recurso.",
    steps: [
      {
        title: "Inspecionar o state local",
        body: [
          "Antes de mexer em backend, veja o que está no state atual. Liste os recursos gerenciados — e, se quiser, espie o JSON com cat terraform.tfstate.",
        ],
        code: ["terraform state list", "cat terraform.tfstate"],
        hints: [
          "O state é o mapa endereço-do-código → ID real na AWS. É isso que será migrado.",
          "O subcomando state tem uma ação que lista os endereços: terraform state <ação>.",
          "terraform state list",
        ],
        explain: [
          "Três objetos: aws_vpc.main e as duas instâncias de aws_subnet.private ([0] e [1], por causa do count). O arquivo terraform.tfstate guarda os IDs (vpc-…, subnet-…), o serial e o lineage.",
          "State local é um risco em produção: não tem lock (dois applies simultâneos corrompem), não tem versionamento e costuma conter segredos em texto puro. Por isso o próximo passo é mover para um backend remoto.",
        ],
        check: (sh) => tfRan(sh, /state list/) && !!sh.readFile("terraform.tfstate"),
      },
      {
        title: "Declarar o backend S3",
        body: [
          "Edite o main.tf (vi main.tf) e adicione, DENTRO do bloco terraform { }, um backend \"s3\" com:",
          "bucket = \"acme-tfstate-prod\", key = \"network/terraform.tfstate\", region = \"sa-east-1\", dynamodb_table = \"terraform-locks\" e encrypt = true.",
        ],
        code: ["vi main.tf"],
        hints: [
          "O backend é configuração do próprio Terraform, não um recurso: ele fica aninhado no bloco terraform { }, ao lado de required_providers.",
          "terraform {\n  backend \"s3\" {\n    bucket         = \"acme-tfstate-prod\"\n    key            = \"network/terraform.tfstate\"\n    region         = \"sa-east-1\"\n    dynamodb_table = \"terraform-locks\"\n    encrypt        = true\n  }\n}",
          "vi main.tf (adicione o bloco backend \"s3\" { … } dentro de terraform { })",
        ],
        explain: [
          "Você declarou onde o state vai morar: s3://acme-tfstate-prod/network/terraform.tfstate, criptografado (encrypt = true) e com lock numa tabela DynamoDB cuja chave de partição é LockID.",
          "O bloco backend não aceita variáveis. Para reaproveitar o mesmo código em várias contas, deixe o bloco parcial e passe o resto com terraform init -backend-config=prod.s3.tfbackend.",
        ],
        diagnose: (sh) => {
          const errs = tfConfigErrors(sh);
          if (errs.length) return `O main.tf tem erro: ${errs[0].summary}${errs[0].line ? ` (linha ${errs[0].line})` : ""}. ${/Unsupported block type/.test(errs[0].summary) ? "O backend precisa ficar dentro de terraform { }." : ""}`;
          const be = tfConfig(sh).backend;
          if (!be) return "Ainda não há bloco backend no main.tf. Ele vai dentro de terraform { }.";
          if (be.type !== "s3") return `O backend declarado é "${be.type}", mas o pedido é "s3".`;
          return "Confira os argumentos: bucket = \"acme-tfstate-prod\", key = \"network/terraform.tfstate\", region e dynamodb_table = \"terraform-locks\".";
        },
        check: (sh) => {
          if (tfConfigErrors(sh).length) return false;
          const be = tfConfig(sh).backend;
          const v = (n: string) => be?.attrs.find((a) => a.name === n)?.expr;
          const lit = (n: string) => (v(n)?.t === "lit" ? (v(n) as { v: unknown }).v : undefined);
          return be?.type === "s3" && lit("bucket") === "acme-tfstate-prod" && lit("key") === "network/terraform.tfstate" && lit("dynamodb_table") === "terraform-locks";
        },
      },
      {
        title: "Migrar o state",
        body: [
          "Qualquer comando agora falha com \"Backend initialization required\" — o código diz S3, mas o diretório ainda usa o state local. Reinicialize pedindo para COPIAR o state existente para o novo backend.",
        ],
        code: ["terraform init -migrate-state"],
        hints: [
          "Mudou backend → precisa de init. A pergunta é: copiar o state antigo ou começar vazio?",
          "terraform init tem duas flags para isso: -migrate-state (copia) e -reconfigure (não copia).",
          "terraform init -migrate-state",
        ],
        explain: [
          "O Terraform detectou a troca local → s3, perguntou se devia copiar o state (respondido yes) e gravou o JSON em acme-tfstate-prod/network/terraform.tfstate. O terraform.tfstate local virou só um .backup.",
          "Com -reconfigure você apontaria para o S3 vazio e o próximo plan tentaria CRIAR tudo de novo — o erro clássico de migração. Em produção, habilite versionamento no bucket de state para poder voltar um serial.",
        ],
        diagnose: (sh) => {
          if (tfBackend(sh).type === "s3") return "O backend já é S3, mas o state não foi copiado (você usou -reconfigure?). Volte o bloco backend, rode init de novo e use -migrate-state.";
          return /Backend configuration changed|Migration of existing state required/.test(lastOutputOf(sh, /init/))
            ? "O init recusou porque já existe state local. Diga a ele para copiar: terraform init -migrate-state."
            : null;
        },
        check: (sh) => tfBackend(sh).type === "s3" && Object.keys(tfCloud(sh).s3).some((k) => k === "acme-tfstate-prod/network/terraform.tfstate") && Object.keys(tfState(sh)?.resources ?? {}).length === 3,
      },
      {
        title: "Provar que nada muda",
        body: ["Rode um plan. Depois de uma migração de backend, o resultado esperado é zero mudanças — é a prova de que o state chegou inteiro."],
        code: ["terraform plan"],
        hints: [
          "Se o state migrou certo, o Terraform encontra no S3 os mesmos IDs e não quer criar nada.",
          "Use o comando de dry-run do Terraform.",
          "terraform plan",
        ],
        explain: [
          "\"No changes\": o plan leu o state do S3 (com lock no DynamoDB — veja o Acquiring state lock), fez refresh de cada recurso na AWS e concluiu que código, state e realidade batem.",
          "Faça sempre esse plan de verificação depois de mexer em backend, state mv ou import. Em pipelines, terraform plan -detailed-exitcode retorna 2 quando há mudanças — ótimo para alertas de drift.",
        ],
        diagnose: (sh) => {
          const lp = tfLastPlan(sh);
          if (lp && lp.backend !== "s3") return "Esse plan ainda rodou com o backend local. Termine a migração (terraform init -migrate-state) antes.";
          if (lp && !lp.noChanges) return `O plan mostrou mudanças (${lp.add} to add). Isso indica que o state não foi copiado — o S3 está vazio.`;
          return null;
        },
        check: (sh) => {
          const lp = tfLastPlan(sh);
          return !!lp && lp.backend === "s3" && lp.noChanges && !sh.readFile("terraform.tfstate");
        },
      },
    ],
    outro: "State remoto, criptografado e com lock. Próximos passos em produção: versionamento + MFA delete no bucket, bloqueio de acesso público, e IAM que só o pipeline consegue escrever no prefixo do state.",
  },

  // ---------------------------------------------------------------------------
  {
    id: "terraform-modules-moved",
    track: "terraform",
    kind: "lab",
    title: "Refatorar para módulos sem destruir nada",
    summary: "Troque recursos duplicados por um módulo local e use blocos moved para o plan mostrar 0 to destroy.",
    level: "Avançado",
    minutes: 20,
    skills: ["módulos locais", "moved blocks", "endereços de recurso", "refactor seguro"],
    seed: {
      files: { "main.tf": MODULES_OLD, "modules/s3-bucket/main.tf": S3_MODULE },
      setup: (sh) => {
        tfSeedRun(sh, "terraform init");
        tfSeedRun(sh, "terraform apply -auto-approve");
        sh.writeFile("main.tf", MODULES_NEW);
      },
    },
    intro:
      "Os buckets acme-prod-logs e acme-prod-artifacts (com versionamento) foram escritos copiando e colando recursos. Um colega abriu um PR que troca tudo pelo módulo ./modules/s3-bucket — o main.tf deste diretório já é o do PR. Antes de aprovar, você precisa garantir que o refactor não vai destruir buckets com dados de produção.",
    steps: [
      {
        title: "Instalar o módulo novo",
        body: ["O PR adicionou blocos module. Prepare o diretório para que o Terraform conheça o módulo local."],
        code: ["terraform init"],
        hints: [
          "Qualquer module novo (ou com source alterado) precisa ser instalado antes do plan — senão: Module not installed.",
          "É o mesmo comando que baixa providers.",
          "terraform init",
        ],
        explain: [
          "O init registrou os módulos em .terraform/modules/modules.json (logs e artifacts apontando para modules/s3-bucket). Módulo local não é copiado; módulos do registry seriam baixados.",
          "Em repositórios grandes, prefira versionar módulos compartilhados (registry privado ou git com ?ref=v1.4.0) — módulo local é ótimo para organizar um único stack.",
        ],
        check: (sh) => tfPreview(sh) !== null,
      },
      {
        title: "Ver o estrago no plan",
        body: ["Rode o plan do PR e leia o resumo com atenção."],
        code: ["terraform plan"],
        hints: [
          "Para o Terraform, endereço mudou = recurso diferente.",
          "Rode o plan e olhe a linha Plan: X to add, Y to change, Z to destroy.",
          "terraform plan",
        ],
        explain: [
          "4 to add, 4 to destroy: o Terraform não sabe que module.logs.aws_s3_bucket.this é o antigo aws_s3_bucket.logs. Ele destruiria os buckets (com os dados!) e criaria novos — na prática o apply ainda falharia no meio com BucketAlreadyExists.",
          "Regra de revisão: todo PR de refactor deve ter plan com 0 to destroy. Coloque isso como política no CI (OPA/conftest ou um simples grep no plan JSON).",
        ],
        check: (sh) => tfRan(sh, /plan/) && !!tfLastPlan(sh),
      },
      {
        title: "Declarar os moves",
        body: [
          "Crie o arquivo moved.tf (vi moved.tf) com um bloco moved para cada um dos 4 recursos, por exemplo:",
          "moved { from = aws_s3_bucket.logs  to = module.logs.aws_s3_bucket.this } — um argumento por linha. Faça o mesmo para aws_s3_bucket_versioning e para artifacts.",
        ],
        code: ["vi moved.tf"],
        hints: [
          "O moved diz ao Terraform: \"o objeto que estava no endereço A agora vive no endereço B\". Endereço dentro de módulo: module.<nome>.<tipo>.<nome>.",
          "moved {\n  from = aws_s3_bucket.logs\n  to   = module.logs.aws_s3_bucket.this\n}",
          "vi moved.tf (4 blocos moved: bucket e versioning de logs e de artifacts)",
        ],
        explain: [
          "Com os 4 moves, o Terraform renomeia os endereços no state antes de calcular o diff. Como o conteúdo do módulo é idêntico ao dos recursos antigos, sobra zero mudança real.",
          "Blocos moved (Terraform ≥ 1.1) são revisáveis em PR e funcionam em todos os workspaces/ambientes — bem melhor que terraform state mv manual em cada state. Deixe-os no código por algumas releases e depois remova.",
        ],
        diagnose: (sh) => {
          const errs = tfConfigErrors(sh);
          if (errs.length) return `Erro no código: ${errs[0].summary}${errs[0].file ? ` (${errs[0].file}:${errs[0].line})` : ""}.`;
          const pv = tfPreview(sh);
          if (!pv) return "O plan não roda com o código atual — rode terraform validate para ver o motivo.";
          if (pv.destroy) return `Ainda sobram ${pv.destroy} destroy no plano. Confira se há um moved para cada recurso (bucket E versioning, logs E artifacts) e os endereços de destino (module.logs.aws_s3_bucket.this).`;
          return null;
        },
        check: (sh) => {
          const pv = tfPreview(sh);
          return !!pv && pv.destroy === 0 && pv.add === 0;
        },
      },
      {
        title: "Plano limpo",
        body: ["Rode o plan de novo e confirme: só moves, 0 to add, 0 to change, 0 to destroy."],
        code: ["terraform plan"],
        hints: [
          "O plan agora deve listar \"has moved to\" para cada recurso.",
          "Mesmo comando do passo anterior.",
          "terraform plan",
        ],
        explain: [
          "Cada recurso aparece como \"# aws_s3_bucket.logs has moved to module.logs.aws_s3_bucket.this\" e o resumo é 0/0/0. Esse é o plan que você anexa ao PR para aprovar o refactor.",
          "Se aparecesse ~ update depois do move, seria diferença real entre o código antigo e o módulo (ex.: uma tag a menos) — vale corrigir o módulo, não aceitar a mudança sem querer.",
        ],
        diagnose: (sh) => {
          const lp = tfLastPlan(sh);
          return lp && lp.destroy ? "O último plan ainda destrói recursos — revise o moved.tf." : null;
        },
        check: (sh) => {
          const lp = tfLastPlan(sh);
          return !!lp && lp.destroy === 0 && lp.add === 0 && lp.moved > 0;
        },
      },
      {
        title: "Aplicar o refactor",
        body: ["Aplique para gravar os novos endereços no state."],
        code: ["terraform apply -auto-approve"],
        hints: [
          "Os moves só são persistidos no state quando você aplica.",
          "terraform apply, sem esperar confirmação.",
          "terraform apply -auto-approve",
        ],
        explain: [
          "Apply complete! Resources: 0 added, 0 changed, 0 destroyed — mas o state agora usa module.logs.aws_s3_bucket.this etc. Confira com terraform state list.",
          "Nenhuma chamada de API de criação/remoção foi feita: refactor de código com risco zero para os dados. É exatamente o que se espera de uma mudança \"só de organização\".",
        ],
        check: (sh) => {
          const st = tfState(sh);
          return !!st?.resources["module.logs.aws_s3_bucket.this"] && !!st.resources["module.artifacts.aws_s3_bucket_versioning.this"] && !st.resources["aws_s3_bucket.logs"];
        },
      },
    ],
    outro: "Refactor aprovado sem destruir nada. Guarde a regra: mudou endereço → moved (ou state mv); plan de refactor tem que dar 0 to destroy.",
  },

  // ---------------------------------------------------------------------------
  {
    id: "terraform-workspaces",
    track: "terraform",
    kind: "lab",
    title: "Ambientes dev e prod com workspaces e tfvars",
    summary: "Mesmo código, states isolados por workspace e tamanhos diferentes por ambiente via -var-file.",
    level: "Intermediário",
    minutes: 15,
    skills: ["terraform workspace", "-var-file", "terraform.workspace", "outputs"],
    seed: {
      files: {
        "main.tf": WEB_TF,
        "env/dev.tfvars": 'instance_type  = "t3.micro"\ninstance_count = 1\n',
        "env/prod.tfvars": 'instance_type  = "m6i.large"\ninstance_count = 3\n',
      },
      setup: (sh) => {
        bootstrapBackend(sh);
        tfSeedRun(sh, "terraform init");
      },
    },
    intro:
      "O serviço web precisa de dois ambientes: dev (1 × t3.micro) e prod (3 × m6i.large). O código é um só; as diferenças ficam em env/dev.tfvars e env/prod.tfvars, e cada ambiente terá seu próprio state no S3 graças aos workspaces.",
    steps: [
      {
        title: "Criar o workspace dev",
        body: ["Crie um workspace chamado dev. Ele já passa a ser o workspace ativo."],
        code: ["terraform workspace new dev"],
        hints: [
          "Workspace = um state separado para o mesmo código e backend.",
          "terraform workspace <ação> <nome> — a ação que cria é new.",
          "terraform workspace new dev",
        ],
        explain: [
          "No backend S3, o state do workspace dev fica em acme-tfstate-prod/env:/dev/web/terraform.tfstate (prefixo workspace_key_prefix = env:). O default continua em web/terraform.tfstate.",
          "Dentro do código, terraform.workspace vale \"dev\" — aqui ele entra no Name e na tag Environment das instâncias.",
        ],
        check: (sh) => tfWorkspace(sh) === "dev",
      },
      {
        title: "Aplicar dev com o tfvars de dev",
        body: ["Aplique passando as variáveis de dev (env/dev.tfvars)."],
        code: ["terraform apply -var-file=env/dev.tfvars -auto-approve"],
        hints: [
          "instance_type e instance_count não têm default — sem o arquivo de variáveis o Terraform recusa.",
          "terraform apply -var-file=<arquivo> -auto-approve",
          "terraform apply -var-file=env/dev.tfvars -auto-approve",
        ],
        explain: [
          "Uma instância t3.micro com Name web-dev-0. O count = var.instance_count gerou o endereço aws_instance.web[0].",
          "Padrão comum: um tfvars por ambiente versionado no repo, e o pipeline escolhe workspace + tfvars pelo branch/ambiente. Segredos nunca vão no tfvars — use SSM/Secrets Manager via data source.",
        ],
        diagnose: (sh) => (tfWorkspace(sh) !== "dev" ? "Você não está no workspace dev (terraform workspace show)." : null),
        check: (sh) => {
          const r = Object.values(tfState(sh, "dev")?.resources ?? {}).filter((x) => x.type === "aws_instance");
          return r.length === 1 && r[0].attrs.instance_type === "t3.micro";
        },
      },
      {
        title: "Criar o workspace prod",
        body: ["Agora crie o workspace prod."],
        code: ["terraform workspace new prod"],
        hints: [
          "Mesmo comando do primeiro passo, outro nome.",
          "terraform workspace new <nome>",
          "terraform workspace new prod",
        ],
        explain: [
          "O state de prod começa vazio: o Terraform não \"vê\" a instância de dev. Esse isolamento é o ponto dos workspaces.",
          "Limitação importante: workspaces compartilham backend e credenciais. Muitos times preferem diretórios/contas separadas para prod (blast radius menor) e usam workspaces para ambientes efêmeros (ex.: um por PR).",
        ],
        check: (sh) => tfWorkspace(sh) === "prod",
      },
      {
        title: "Aplicar prod",
        body: ["Aplique prod com o arquivo de variáveis de prod."],
        code: ["terraform apply -var-file=env/prod.tfvars -auto-approve"],
        hints: [
          "Cuidado para não usar o tfvars de dev no workspace de prod — é um erro comum (e caro).",
          "terraform apply -var-file=env/<ambiente>.tfvars -auto-approve",
          "terraform apply -var-file=env/prod.tfvars -auto-approve",
        ],
        explain: [
          "Três m6i.large (aws_instance.web[0..2]) com Name web-prod-N, em um state separado do de dev.",
          "Para evitar trocar tfvars por engano, alguns times validam no código: uma precondition que exige var.environment == terraform.workspace, ou selecionam o tfvars automaticamente pelo nome do workspace no pipeline.",
        ],
        diagnose: (sh) => {
          if (tfWorkspace(sh) !== "prod") return "Você não está no workspace prod.";
          const r = Object.values(tfState(sh, "prod")?.resources ?? {}).filter((x) => x.type === "aws_instance");
          if (r.length && r[0].attrs.instance_type !== "m6i.large") return "O workspace prod recebeu as variáveis erradas. Rode o apply de novo com -var-file=env/prod.tfvars.";
          return null;
        },
        check: (sh) => {
          const r = Object.values(tfState(sh, "prod")?.resources ?? {}).filter((x) => x.type === "aws_instance");
          return r.length === 3 && r.every((x) => x.attrs.instance_type === "m6i.large");
        },
      },
      {
        title: "Comparar os outputs",
        body: ["Volte para dev e leia os outputs. Compare com prod: cada workspace tem os seus."],
        code: ["terraform workspace select dev", "terraform output"],
        hints: [
          "Outputs são lidos do state do workspace ATIVO.",
          "Primeiro terraform workspace select dev, depois terraform output.",
          "terraform workspace select dev && terraform output",
        ],
        explain: [
          "Em dev, instance_ids tem 1 ID e instance_type = \"t3.micro\"; em prod seriam 3 IDs e m6i.large. Mesmo código, estados independentes.",
          "Em scripts, use terraform output -json (ou -raw para um valor único) — por exemplo para passar IDs para o Ansible ou para um smoke test.",
        ],
        diagnose: (sh) => (tfWorkspace(sh) !== "dev" ? "Selecione o workspace dev antes de ler os outputs." : "Agora leia os outputs: terraform output"),
        check: (sh) => tfWorkspace(sh) === "dev" && tfOutputsIn(sh).at(-1) === "dev",
      },
    ],
    outro: "Dois ambientes, um código. Lembre: workspace isola state, não credenciais — prod crítica costuma ganhar conta AWS e diretório próprios.",
  },

  // ---------------------------------------------------------------------------
  {
    id: "terraform-import-drift",
    track: "terraform",
    kind: "challenge",
    title: "Desafio: import de bucket legado e correção de drift",
    summary: "Traga para o Terraform um bucket criado no console e desfaça alterações manuais feitas fora do código.",
    level: "Avançado",
    minutes: 20,
    skills: ["terraform import", "plan -refresh-only", "drift", "ClickOps"],
    seed: {
      files: { "main.tf": ASSETS_TF },
      setup: (sh) => {
        tfSeedRun(sh, "terraform init");
        tfSeedRun(sh, "terraform apply -auto-approve");
        // someone "fixed" things in the console at 2 a.m.
        const assets = tfCloudGet(sh, "aws_s3_bucket", "acme-web-assets")!;
        assets.tags = { Owner: "joao.silva", Environment: "prod", Temp: "debug-cors" };
        const ver = tfCloudGet(sh, "aws_s3_bucket_versioning", "acme-web-assets")!;
        ver.versioning_configuration = [{ status: "Suspended" }];
        // bucket created by the finance team in the console
        tfCloudPut(sh, "aws_s3_bucket", "acme-finance-reports", {
          id: "acme-finance-reports", bucket: "acme-finance-reports", arn: "arn:aws:s3:::acme-finance-reports",
          bucket_domain_name: "acme-finance-reports.s3.amazonaws.com", hosted_zone_id: "Z7KQH4QJS55SO",
          tags: { Owner: "finance", CostCenter: "cc-1234" },
        });
      },
    },
    intro:
      "Auditoria de ClickOps: (1) o time financeiro criou no console o bucket acme-finance-reports (tags Owner = finance, CostCenter = cc-1234) e ele precisa passar a ser gerenciado pelo Terraform; (2) alguém alterou o bucket acme-web-assets direto no console. Sem recriar nada.",
    steps: [
      {
        title: "Escrever o código do bucket legado",
        body: [
          "Crie legacy.tf (vi legacy.tf) com um resource \"aws_s3_bucket\" \"finance_reports\" que descreva o bucket real: bucket = \"acme-finance-reports\" e as mesmas tags.",
        ],
        code: ["vi legacy.tf"],
        hints: [
          "Import não gera código: primeiro você escreve o resource, depois associa o objeto real a ele.",
          "resource \"aws_s3_bucket\" \"finance_reports\" {\n  bucket = \"acme-finance-reports\"\n  tags = {\n    Owner      = \"finance\"\n    CostCenter = \"cc-1234\"\n  }\n}",
          "vi legacy.tf (resource aws_s3_bucket finance_reports com bucket e tags do bucket real)",
        ],
        explain: [
          "O resource descreve o estado desejado. Se ele divergir do objeto real, o próximo plan vai propor mudar o bucket — por isso copie os atributos que importam (nome, tags).",
          "Atalho moderno: com um bloco import { to = …, id = … }, terraform plan -generate-config-out=generated.tf escreve um rascunho do código para você revisar.",
        ],
        diagnose: (sh) => {
          const errs = tfConfigErrors(sh);
          if (errs.length) return `Erro no código: ${errs[0].summary}${errs[0].file ? ` (${errs[0].file}:${errs[0].line})` : ""}.`;
          return "Ainda não há um aws_s3_bucket com bucket = \"acme-finance-reports\" no código.";
        },
        check: (sh) => tfConfigErrors(sh).length === 0 && bucketDeclared(sh, "acme-finance-reports"),
      },
      {
        title: "Importar",
        body: ["Associe o bucket real ao endereço aws_s3_bucket.finance_reports. Para S3, o ID de import é o nome do bucket."],
        code: ["terraform import aws_s3_bucket.finance_reports acme-finance-reports"],
        hints: [
          "terraform import recebe dois argumentos: o ENDEREÇO no código e o ID na AWS.",
          "terraform import <tipo>.<nome> <id-na-aws>",
          "terraform import aws_s3_bucket.finance_reports acme-finance-reports",
        ],
        explain: [
          "O Terraform leu o bucket na AWS e gravou no state sob aws_s3_bucket.finance_reports. Nada foi criado nem alterado na nuvem.",
          "Em equipe prefira o bloco import { } (Terraform ≥ 1.5): ele passa pelo plan/PR como qualquer mudança, em vez de alterar o state direto do seu terminal.",
        ],
        diagnose: (sh) => (!bucketDeclared(sh, "acme-finance-reports") ? "O código do bucket sumiu — volte ao passo anterior." : null),
        check: (sh) => Object.values(tfState(sh)?.resources ?? {}).some((r) => r.type === "aws_s3_bucket" && r.attrs.id === "acme-finance-reports"),
      },
      {
        title: "Detectar o drift",
        body: ["Antes de mudar qualquer coisa, descubra o que foi alterado fora do Terraform — sem propor ações."],
        code: ["terraform plan -refresh-only"],
        hints: [
          "Existe um modo de plan que só compara o state com a realidade.",
          "terraform plan com a flag -refresh-only.",
          "terraform plan -refresh-only",
        ],
        explain: [
          "\"Objects have changed outside of Terraform\": em acme-web-assets, Owner virou joao.silva, apareceu a tag Temp e o versionamento foi Suspended — isso quebra a recuperação de objetos apagados.",
          "Rode plan -refresh-only agendado (ex.: diariamente no CI) para detectar drift cedo. apply -refresh-only ACEITA a realidade no state; um apply normal faz a realidade voltar ao código.",
        ],
        check: (sh) => {
          const lp = tfLastPlan(sh);
          return !!lp && lp.refreshOnly && lp.drift > 0;
        },
      },
      {
        title: "Corrigir o drift",
        body: ["O código é a fonte da verdade: aplique para restaurar as tags e reativar o versionamento."],
        code: ["terraform apply -auto-approve"],
        hints: [
          "Um apply normal faz refresh e depois propõe desfazer as diferenças.",
          "terraform apply sem -refresh-only.",
          "terraform apply -auto-approve",
        ],
        explain: [
          "O Terraform atualizou in-place as tags de acme-web-assets e o versioning voltou a Enabled. O bucket importado ficou intocado porque o código bate com ele.",
          "Para mudanças manuais recorrentes que são legítimas (ex.: tags de custo aplicadas por outra ferramenta), use lifecycle { ignore_changes = [tags[\"CostCenter\"]] } em vez de brigar com o drift.",
        ],
        diagnose: (sh) => {
          const fin = tfCloudGet(sh, "aws_s3_bucket", "acme-finance-reports");
          if (!fin) return "O bucket acme-finance-reports foi DESTRUÍDO — o nome no código não batia com o real e o plan fez replace. Reinicie o lab e confira bucket = \"acme-finance-reports\".";
          return null;
        },
        check: (sh) => {
          const a = tfCloudGet(sh, "aws_s3_bucket", "acme-web-assets");
          const v = tfCloudGet(sh, "aws_s3_bucket_versioning", "acme-web-assets");
          const status = Array.isArray(v?.versioning_configuration) ? (v!.versioning_configuration[0] as { status?: string }).status : undefined;
          return (a?.tags as Record<string, string> | undefined)?.Owner === "platform" && status === "Enabled" && !!tfCloudGet(sh, "aws_s3_bucket", "acme-finance-reports");
        },
      },
      {
        title: "Confirmar convergência",
        body: ["Rode um plan normal. Código, state e AWS devem estar alinhados."],
        code: ["terraform plan"],
        hints: [
          "Depois do apply, não deve sobrar diferença nenhuma.",
          "O plan normal (sem flags).",
          "terraform plan",
        ],
        explain: [
          "\"No changes. Your infrastructure matches the configuration.\" — o bucket legado agora é gerenciado e o drift foi eliminado.",
          "Para evitar a próxima rodada de ClickOps: SCP/IAM negando alterações manuais em recursos com a tag ManagedBy = terraform, e alertas de CloudTrail para ações de console.",
        ],
        diagnose: (sh) => {
          const lp = tfLastPlan(sh);
          if (lp && !lp.refreshOnly && !lp.noChanges) return `O plan ainda mostra mudanças (${lp.change} to change). Se for no finance_reports, as tags no legacy.tf não batem com o bucket real.`;
          return null;
        },
        check: (sh) => {
          const lp = tfLastPlan(sh);
          return !!lp && !lp.refreshOnly && lp.noChanges;
        },
      },
    ],
    outro: "Bucket legado sob gestão e drift revertido. Em produção, combine import em bloco (revisado em PR) com detecção de drift agendada.",
  },

  // ---------------------------------------------------------------------------
  {
    id: "terraform-broken-pipeline",
    track: "terraform",
    kind: "challenge",
    title: "Desafio: pipeline quebrado — erro de sintaxe e lock órfão",
    summary: "O CI caiu no meio de um apply e o PR seguinte tem erros de HCL. Conserte o código e libere o lock com segurança.",
    level: "Avançado",
    minutes: 20,
    skills: ["terraform validate", "HCL", "state lock", "terraform force-unlock"],
    seed: {
      files: { "main.tf": OBS_HEAD },
      setup: (sh) => {
        bootstrapBackend(sh);
        tfSeedRun(sh, "terraform init");
        tfSeedRun(sh, "terraform apply -auto-approve");
        sh.writeFile("main.tf", OBS_BROKEN);
        tfSetLock(sh, "acme-tfstate-prod/platform/observability.tfstate", { ID: LOCK_ID, Who: "runner@gha-runner-7f9c", Operation: "OperationTypeApply" });
      },
    },
    intro:
      "3h da manhã: o job de CI do stack de observabilidade foi morto por timeout no meio de um apply, e o PR #482 (log group de auditoria, pedido pela segurança) foi mergeado com erros. Você está de plantão: faça o pipeline voltar a funcionar sem corromper o state.",
    steps: [
      {
        title: "Corrigir o erro de sintaxe",
        body: ["Rode terraform validate, leia o arquivo e a linha apontados e corrija com vi main.tf."],
        code: ["terraform validate", "vi main.tf"],
        hints: [
          "O validate aponta arquivo e linha. Em HCL, argumento é sempre nome = valor.",
          "Procure a linha retention_in_days sem o sinal de igual.",
          "vi main.tf (troque retention_in_days 365 por retention_in_days = 365)",
        ],
        explain: [
          "\"Invalid block definition\": sem o =, o parser achou que retention_in_days era o início de um bloco. Erros de parse param tudo — nem a checagem de referências roda.",
          "Coloque terraform fmt -check e terraform validate como primeiro job do CI (e num pre-commit hook): falham em segundos, antes de qualquer credencial ou lock.",
        ],
        diagnose: (sh) => {
          const e = tfConfigErrors(sh, sh.cwd, false)[0];
          return e ? `Ainda há erro de sintaxe: ${e.summary} em ${e.file}:${e.line}.` : null;
        },
        check: (sh) => tfConfigErrors(sh, sh.cwd, false).length === 0,
      },
      {
        title: "Corrigir a referência",
        body: ["Rode validate de novo: agora aparece um erro de referência. Corrija o nome."],
        code: ["terraform validate", "vi main.tf"],
        hints: [
          "O Terraform sugere o nome correto em \"Did you mean\".",
          "A variável declarada é environment; o PR escreveu enviroment.",
          "vi main.tf (troque var.enviroment por var.environment)",
        ],
        explain: [
          "\"Reference to undeclared input variable\" — typos em var./local./module. só aparecem depois que a sintaxe está OK, por isso o validate revela os erros em camadas.",
          "Um tflint no CI pega ainda mais: variáveis não usadas, tipos de instância inexistentes, convenções de nome.",
        ],
        diagnose: (sh) => {
          const e = tfConfigErrors(sh)[0];
          return e ? `validate ainda falha: ${e.summary}${e.line ? ` (linha ${e.line})` : ""}. ${/Did you mean "([^"]+)"/.exec(e.detail)?.[0] ?? ""}` : null;
        },
        check: (sh) => tfConfigErrors(sh).length === 0,
      },
      {
        title: "Reproduzir a falha do pipeline",
        body: ["Com o código válido, rode o plan como o CI faria e leia o erro com atenção: anote o ID e quem segura o lock."],
        code: ["terraform plan"],
        hints: [
          "O job morto deixou o item de lock na tabela DynamoDB.",
          "Rode o plan e procure o bloco Lock Info.",
          "terraform plan",
        ],
        explain: [
          "\"Error acquiring the state lock\": o item LockID do DynamoDB ainda existe. O Lock Info diz ID, Path, Operation (OperationTypeApply), Who (o runner do GitHub Actions) e Created.",
          "Antes de forçar: confirme que o job realmente morreu (Actions/CI) e que ninguém está rodando apply. Liberar o lock de um apply vivo é a forma mais rápida de corromper um state.",
        ],
        check: (sh) => sh.entries.some((e) => /^(terraform|tf) plan/.test(e.cmd) && /Error acquiring the state lock/.test(e.output)),
      },
      {
        title: "Liberar o lock",
        body: ["O runner foi destruído pelo timeout — ninguém está usando o state. Remova o lock órfão usando o ID do Lock Info."],
        code: [`terraform force-unlock -force ${LOCK_ID}`],
        hints: [
          "Existe um comando específico para remover o lock, que exige o ID exato.",
          "terraform force-unlock [-force] <LOCK_ID>",
          `terraform force-unlock -force ${LOCK_ID}`,
        ],
        explain: [
          "O item de lock foi apagado da tabela terraform-locks. O ID obrigatório é uma proteção: você só libera o lock que viu, não um lock novo de outra pessoa.",
          "Depois de um apply interrompido, alguns recursos podem ter sido criados sem ir para o state. O próximo plan mostra isso; se aparecer algo já existente, use import em vez de deixar criar duplicado.",
        ],
        diagnose: (sh) => (tfLocks(sh)["acme-tfstate-prod/platform/observability.tfstate"] ? `O lock continua lá. O ID correto é ${LOCK_ID}.` : null),
        check: (sh) => !tfLocks(sh)["acme-tfstate-prod/platform/observability.tfstate"],
      },
      {
        title: "Aplicar o PR",
        body: ["Agora o pipeline pode seguir: aplique a mudança do PR #482."],
        code: ["terraform apply -auto-approve"],
        hints: [
          "Com código válido e sem lock, o apply deve criar só o log group de auditoria.",
          "terraform apply sem confirmação interativa.",
          "terraform apply -auto-approve",
        ],
        explain: [
          "1 added: aws_cloudwatch_log_group.audit com retenção de 365 dias. O log group app, que já existia, não mudou.",
          "Post-mortem: aumente o timeout do job, trate SIGTERM no runner (o Terraform libera o lock ao receber sinal) e adicione concurrency no workflow para impedir dois applies do mesmo stack.",
        ],
        check: (sh) => {
          const r = tfState(sh)?.resources["aws_cloudwatch_log_group.audit"];
          return !!r && r.attrs.retention_in_days === 365;
        },
      },
    ],
    outro: "Pipeline de volta. Ordem de ouro no plantão: validate → entender o lock (quem/quando) → só então force-unlock → plan antes de apply.",
  },
];

// ---------------- lessons ----------------
export const lessons: Lesson[] = [
  {
    id: "learn-tf-state",
    track: "terraform",
    title: "State, backends e locking",
    summary: "O que o state guarda, por que ele não pode ficar no notebook e como S3 + DynamoDB resolvem concorrência.",
    minutes: 6,
    before: "terraform-remote-state",
    blocks: [
      { type: "text", text: "O Terraform é declarativo: você descreve o destino e ele calcula o caminho. Para isso ele precisa lembrar o que já criou — é o **state**, um JSON que mapeia cada endereço do código (`aws_vpc.main`) ao objeto real (`vpc-0a1b…`)." },
      {
        type: "flow",
        steps: [
          { label: "Código .tf", detail: "estado desejado" },
          { label: "State", detail: "o que o Terraform acha que existe" },
          { label: "Refresh", detail: "lê a API da AWS" },
          { label: "Diff", detail: "+ ~ -/+ -" },
          { label: "Apply", detail: "chama a API e grava o state" },
        ],
        caption: "Todo plan compara três visões: código, state e realidade.",
      },
      { type: "heading", text: "Por que state local é um problema" },
      {
        type: "list",
        items: [
          "**Concorrência**: dois applies ao mesmo tempo gravam states diferentes — o último vence e o outro some.",
          "**Perda**: notebook formatado = Terraform não sabe mais o que gerencia (e tenta criar tudo de novo).",
          "**Segredos**: senhas de RDS, chaves geradas e outputs sensíveis ficam em texto puro no JSON.",
        ],
      },
      { type: "heading", text: "Backend S3 com lock" },
      {
        type: "code",
        lang: "hcl",
        code: `terraform {
  backend "s3" {
    bucket         = "acme-tfstate-prod"
    key            = "network/terraform.tfstate"
    region         = "sa-east-1"
    dynamodb_table = "terraform-locks"   # item LockID = bucket/key
    encrypt        = true
  }
}`,
        caption: "Desde o 1.10 também existe use_lockfile = true (lock nativo no S3), mas DynamoDB ainda é o padrão mais comum.",
      },
      {
        type: "table",
        head: ["Situação", "Comando"],
        rows: [
          ["Primeiro init ou backend igual", "terraform init"],
          ["Mudou backend e quer levar o state junto", "terraform init -migrate-state"],
          ["Mudou backend e o state já está lá (ou quer começar vazio)", "terraform init -reconfigure"],
          ["Backend parcial por ambiente", "terraform init -backend-config=prod.s3.tfbackend"],
          ["Lock órfão de um job morto", "terraform force-unlock <LOCK_ID>"],
        ],
      },
      { type: "callout", tone: "warn", text: "O bloco backend não aceita variáveis. Se tentar bucket = var.bucket, o init falha com \"Variables not allowed\" — use -backend-config." },
      { type: "callout", tone: "tip", text: "Bucket de state: versionamento ligado, Block Public Access, criptografia KMS e IAM que só permite ao pipeline escrever. O versionamento é o seu \"undo\" quando um state é corrompido." },
    ],
    quiz: [
      {
        q: "Você adicionou um backend S3 a um projeto que já tem terraform.tfstate local com 20 recursos. Qual init usar?",
        options: ["terraform init -reconfigure", "terraform init -migrate-state", "terraform init -upgrade", "Apagar o .terraform/ e rodar terraform init"],
        answer: 1,
        explain: "-migrate-state copia o state existente para o novo backend. -reconfigure apontaria para um state vazio e o próximo plan tentaria criar os 20 recursos de novo.",
      },
      {
        q: "Para que serve a tabela DynamoDB no backend S3?",
        options: ["Guardar uma cópia do state para backup", "Guardar o lock, impedindo dois applies simultâneos no mesmo state", "Criptografar o state", "Armazenar os outputs para outros stacks"],
        answer: 1,
        explain: "O DynamoDB guarda um item LockID por state durante plan/apply. O state em si fica no S3; criptografia é do S3/KMS.",
      },
      {
        q: "Um plan falha com \"Error acquiring the state lock\" e Who = um runner de CI. O que fazer primeiro?",
        options: ["Rodar com -lock=false", "terraform force-unlock imediatamente", "Confirmar que o job/runner realmente morreu e ninguém está aplicando", "Apagar a tabela DynamoDB"],
        answer: 2,
        explain: "Só libere um lock depois de ter certeza de que não há operação viva. Forçar com um apply em andamento corrompe o state; -lock=false tem o mesmo risco.",
      },
    ],
  },
  {
    id: "learn-tf-modules-moved",
    track: "terraform",
    title: "Módulos, endereços e refactor com moved",
    summary: "Como o Terraform identifica recursos, por que renomear é destrutivo e como moved/state mv evitam isso.",
    minutes: 6,
    before: "terraform-modules-moved",
    blocks: [
      { type: "text", text: "Para o Terraform, a identidade de um recurso é o seu **endereço**, não o nome na AWS. Renomear `aws_s3_bucket.logs` para `module.logs.aws_s3_bucket.this` é, por padrão, destruir um e criar outro." },
      {
        type: "table",
        head: ["Endereço", "Significa"],
        rows: [
          ["aws_s3_bucket.logs", "recurso no módulo raiz"],
          ["aws_instance.web[0]", "instância 0 de um recurso com count"],
          ['aws_subnet.private["a"]', "instância com for_each (chave \"a\")"],
          ["module.logs.aws_s3_bucket.this", "recurso this dentro do módulo logs"],
          ["module.net.module.subnets.aws_subnet.this[1]", "módulos aninhados"],
        ],
      },
      { type: "heading", text: "Duas formas de mover" },
      {
        type: "code",
        lang: "hcl",
        code: `# moved.tf — revisado em PR, vale para todos os workspaces
moved {
  from = aws_s3_bucket.logs
  to   = module.logs.aws_s3_bucket.this
}`,
      },
      {
        type: "code",
        lang: "bash",
        code: `# imperativo: altera o state na hora, um state por vez
terraform state mv aws_s3_bucket.logs module.logs.aws_s3_bucket.this`,
      },
      {
        type: "flow",
        steps: [
          { label: "Refatorar código", detail: "resources → module" },
          { label: "terraform init", detail: "instala o módulo" },
          { label: "plan", detail: "N to destroy 😱" },
          { label: "moved { }", detail: "um por recurso" },
          { label: "plan", detail: "0 to destroy ✅" },
        ],
      },
      { type: "callout", tone: "tip", text: "Prefira moved: fica no histórico do git, passa pelo plan do PR e é aplicado em dev, staging e prod automaticamente. state mv é para emergências ou states que não seguem o código." },
      { type: "callout", tone: "exam", text: "Pergunta clássica de entrevista: \"como renomear um recurso sem recriá-lo?\" — moved block (≥ 1.1) ou terraform state mv; e sempre validar com um plan que mostre 0 to destroy." },
    ],
    quiz: [
      {
        q: "Você trocou count por for_each em aws_subnet.private. O que acontece sem nenhum cuidado extra?",
        options: ["Nada, o Terraform detecta automaticamente", "As subnets serão destruídas e recriadas, porque os endereços mudam de [0] para [\"a\"]", "O plan falha com erro de sintaxe", "Apenas as tags mudam"],
        answer: 1,
        explain: "private[0] e private[\"a\"] são endereços diferentes. É preciso um moved (ou state mv) por instância.",
      },
      {
        q: "Qual a vantagem principal do bloco moved sobre terraform state mv?",
        options: ["É mais rápido", "É declarativo: revisado em PR e aplicado em todos os states/ambientes pelo pipeline", "Não precisa de init", "Funciona sem backend"],
        answer: 1,
        explain: "state mv muda um state específico na hora, fora do fluxo de revisão. moved vive no código e é aplicado onde quer que aquele código rode.",
      },
      {
        q: "Depois dos moves, o plan mostra \"~ update in-place\" num bucket movido. O que isso indica?",
        options: ["Que o move falhou", "Diferença real entre o recurso antigo e o que o módulo declara (ex.: uma tag)", "Que o bucket será recriado", "Que o state está corrompido"],
        answer: 1,
        explain: "O move deu certo; o update é diferença de conteúdo. Ajuste o módulo se a mudança não era intencional.",
      },
    ],
  },
  {
    id: "learn-tf-workspaces",
    track: "terraform",
    title: "Ambientes: workspaces, tfvars ou diretórios?",
    summary: "O que um workspace isola (e o que não isola) e como organizar dev/staging/prod.",
    minutes: 5,
    before: "terraform-workspaces",
    blocks: [
      { type: "text", text: "Um **workspace** é outro state para o mesmo código e o mesmo backend. No S3, o workspace `dev` vira a chave `env:/dev/<key>`. Dentro do código, `terraform.workspace` retorna o nome atual." },
      {
        type: "table",
        head: ["Estratégia", "Isola", "Bom para"],
        rows: [
          ["Workspaces + tfvars", "só o state", "ambientes parecidos, efêmeros (um por PR)"],
          ["Diretórios por ambiente (envs/prod)", "state, backend, versões de módulo", "prod crítica, mudanças promovidas por PR"],
          ["Contas AWS separadas", "state, credenciais, blast radius", "padrão recomendado para produção"],
        ],
      },
      {
        type: "code",
        lang: "bash",
        code: `terraform workspace new dev
terraform apply -var-file=env/dev.tfvars
terraform workspace select prod
terraform plan  -var-file=env/prod.tfvars`,
      },
      {
        type: "flow",
        steps: [
          { label: "workspace select", detail: "qual state" },
          { label: "-var-file", detail: "quais valores" },
          { label: "plan", detail: "revisão" },
          { label: "apply", detail: "só naquele state" },
        ],
      },
      { type: "callout", tone: "warn", text: "Workspace não isola credenciais nem backend: um apply em prod com o tfvars de dev é um erro de um caractere. Automatize a escolha do tfvars pelo nome do workspace no pipeline." },
      { type: "callout", tone: "tip", text: "Precedência de variáveis (menor → maior): default, TF_VAR_*, terraform.tfvars, *.auto.tfvars, -var/-var-file na ordem da linha de comando." },
    ],
    quiz: [
      {
        q: "Você criou o workspace prod e rodou terraform plan. O que o Terraform vê?",
        options: ["Os recursos do workspace default", "Um state vazio: tudo aparece como + create", "Os recursos de todos os workspaces", "Um erro, porque prod não tem backend"],
        answer: 1,
        explain: "Cada workspace tem seu próprio state; um workspace novo começa vazio.",
      },
      {
        q: "O que workspaces NÃO isolam?",
        options: ["O arquivo de state", "O valor de terraform.workspace", "As credenciais/conta AWS e o backend", "Os outputs"],
        answer: 2,
        explain: "Todos os workspaces usam o mesmo backend e as credenciais do terminal/pipeline. Por isso prod costuma ter conta própria.",
      },
      {
        q: "instance_type tem default \"t3.micro\" e prod.tfvars define \"m6i.large\". Rodando apply -var-file=prod.tfvars -var instance_type=t3.small, qual vale?",
        options: ["t3.micro", "m6i.large", "t3.small", "Erro de conflito"],
        answer: 2,
        explain: "-var e -var-file são processados na ordem da linha de comando; o último vence.",
      },
    ],
  },
  {
    id: "learn-tf-drift-import",
    track: "terraform",
    title: "Drift, refresh-only e import",
    summary: "Como detectar mudanças feitas fora do Terraform e trazer recursos existentes para o código.",
    minutes: 6,
    before: "terraform-import-drift",
    blocks: [
      { type: "text", text: "**Drift** é quando a realidade diverge do state: alguém mudou algo no console, um script alterou tags, um recurso foi apagado. Todo plan faz refresh e percebe, mas o `-refresh-only` mostra o drift **sem** propor ações." },
      {
        type: "table",
        head: ["Comando", "O que faz com o drift"],
        rows: [
          ["terraform plan -refresh-only", "mostra o que mudou fora do Terraform"],
          ["terraform apply -refresh-only", "aceita a realidade: grava no state, sem tocar na AWS"],
          ["terraform apply", "desfaz: leva a realidade de volta ao código"],
          ["lifecycle { ignore_changes = [...] }", "ignora atributos gerenciados por outra ferramenta"],
        ],
      },
      { type: "heading", text: "Import: do console para o código" },
      {
        type: "code",
        lang: "hcl",
        code: `# 1. escreva o resource
resource "aws_s3_bucket" "finance_reports" {
  bucket = "acme-finance-reports"
}

# 2a. declarativo (>= 1.5): passa pelo plan/PR
import {
  to = aws_s3_bucket.finance_reports
  id = "acme-finance-reports"
}`,
      },
      { type: "code", lang: "bash", code: "# 2b. imperativo\nterraform import aws_s3_bucket.finance_reports acme-finance-reports" },
      {
        type: "flow",
        steps: [
          { label: "Escrever resource", detail: "atributos reais" },
          { label: "import", detail: "endereço + ID" },
          { label: "plan", detail: "ajustar até 0 mudanças" },
          { label: "Gerenciado", detail: "próximos changes via PR" },
        ],
      },
      { type: "callout", tone: "warn", text: "Se o resource importado tiver um atributo que força replace diferente do real (ex.: outro nome de bucket), o próximo apply DESTRÓI o objeto importado. Sempre rode plan logo depois do import." },
      { type: "callout", tone: "exam", text: "O ID de import depende do tipo: bucket S3 = nome, EC2 = i-…, IAM role = nome, security group = sg-…. A documentação de cada resource tem a seção Import." },
    ],
    quiz: [
      {
        q: "Alguém desligou o versionamento de um bucket no console. Você quer só VER o que mudou, sem risco. Qual comando?",
        options: ["terraform apply", "terraform plan -refresh-only", "terraform apply -refresh-only", "terraform state pull"],
        answer: 1,
        explain: "plan -refresh-only lista o drift e não muda nada. apply -refresh-only gravaria a mudança no state (aceitando-a).",
      },
      {
        q: "O que terraform import faz?",
        options: ["Gera o código .tf do recurso", "Cria o recurso na AWS", "Associa um objeto existente na AWS a um endereço do código, gravando-o no state", "Copia o state de outro projeto"],
        answer: 2,
        explain: "Import só escreve no state. O código precisa existir antes (ou ser gerado com -generate-config-out a partir de um bloco import).",
      },
      {
        q: "Após o import, o plan mostra \"-/+ must be replaced\" com bucket # forces replacement. O que fazer?",
        options: ["Aplicar, é esperado após import", "Corrigir o nome do bucket no código para bater com o real", "Rodar terraform state rm e esquecer", "Usar -target no apply"],
        answer: 1,
        explain: "O código diverge num atributo imutável; aplicar destruiria o bucket importado. Ajuste o código até o plan ficar limpo.",
      },
    ],
  },
];
