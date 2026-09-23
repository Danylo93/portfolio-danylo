// Terraform CLI plugin (AWS EKS example workspace).
import { registerTool } from "../registry";
import type { Shell } from "../shell";

export const terraformRun = (sh: Shell, args: string[]): string => {
    const [sub] = args;
    const tf = sh.state.tf;
    const needInit = "│ Error: Backend initialization required, please run \"terraform init\"";
    switch (sub) {
      case "version":
      case "-version":
      case "--version":
        return "Terraform v1.9.5\non linux_amd64\n+ provider registry.terraform.io/hashicorp/aws v5.62.0";
      case "init":
        tf.initialized = true;
        return "Initializing the backend...\nInitializing provider plugins...\n- Finding hashicorp/aws versions matching \"~> 5.0\"...\n- Installing hashicorp/aws v5.62.0...\n- Installed hashicorp/aws v5.62.0 (signed by HashiCorp)\n\nTerraform has been successfully initialized!";
      case "fmt":
        return "";
      case "validate":
        if (!tf.initialized) return needInit;
        return "Success! The configuration is valid.";
      case "plan":
        if (!tf.initialized) return needInit;
        tf.planned = true;
        return [
          "Terraform used the selected providers to generate the following execution plan.",
          "Resource actions are indicated with the following symbols:",
          "  + create",
          "",
          "Terraform will perform the following actions:",
          "",
          "  # aws_vpc.lab will be created",
          "  + resource \"aws_vpc\" \"lab\" {",
          "      + cidr_block = \"10.0.0.0/16\"",
          "      + id         = (known after apply)",
          "    }",
          "",
          "  # aws_eks_cluster.lab will be created",
          "  + resource \"aws_eks_cluster\" \"lab\" {",
          "      + name     = \"danylo-lab\"",
          "      + version  = \"1.30\"",
          "      + endpoint = (known after apply)",
          "    }",
          "",
          "  # aws_eks_node_group.workers will be created",
          "  + resource \"aws_eks_node_group\" \"workers\" {",
          "      + instance_types = [\"t3.medium\"]",
          "      + scaling_config { desired_size = 2, max_size = 4, min_size = 1 }",
          "    }",
          "",
          "Plan: 3 to add, 0 to change, 0 to destroy.",
        ].join("\n");
      case "apply":
        if (!tf.initialized) return needInit;
        tf.applied = true;
        tf.planned = true;
        return [
          ...(args.includes("-auto-approve") ? [] : ["Do you want to perform these actions?", "  Enter a value: yes", ""]),
          "aws_vpc.lab: Creating...",
          "aws_vpc.lab: Creation complete after 2s [id=vpc-0a1b2c3d4e5f67890]",
          "aws_eks_cluster.lab: Creating...",
          "aws_eks_cluster.lab: Still creating... [9m50s elapsed]",
          "aws_eks_cluster.lab: Creation complete after 9m58s [id=danylo-lab]",
          "aws_eks_node_group.workers: Creating...",
          "aws_eks_node_group.workers: Creation complete after 2m11s [id=danylo-lab:workers]",
          "",
          "Apply complete! Resources: 3 added, 0 changed, 0 destroyed.",
          "",
          "Outputs:",
          "",
          "cluster_endpoint = \"https://A1B2C3D4E5.gr7.sa-east-1.eks.amazonaws.com\"",
          "cluster_name = \"danylo-lab\"",
        ].join("\n");
      case "state":
        if (args[1] !== "list") return "Usage: terraform state list";
        return tf.applied ? "aws_eks_cluster.lab\naws_eks_node_group.workers\naws_vpc.lab" : "";
      case "output":
        return tf.applied ? "cluster_endpoint = \"https://A1B2C3D4E5.gr7.sa-east-1.eks.amazonaws.com\"\ncluster_name = \"danylo-lab\"" : "│ Warning: No outputs found";
      case "destroy":
        if (!tf.applied) return "No changes. No objects need to be destroyed.";
        tf.applied = false;
        return "aws_eks_node_group.workers: Destroying...\naws_eks_cluster.lab: Destroying...\naws_vpc.lab: Destroying...\n\nDestroy complete! Resources: 3 destroyed.";
      default:
        return "Usage: terraform [global options] <subcommand> [args]\n\nMain commands:\n  init, validate, plan, apply, destroy, output, state list";
    }
};

registerTool({
  name: "terraform",
  aliases: ["tf"],
  summary: "Infrastructure as Code (init, plan, apply, state)",
  subcommands: { init: "baixa providers/módulos e prepara o backend de state", plan: "mostra o que será criado/alterado/destruído — sem aplicar nada", apply: "aplica as mudanças na infraestrutura", destroy: "remove toda a infraestrutura gerenciada", state: "subcomandos que leem o arquivo de state", output: "mostra os outputs definidos no código", validate: "valida a sintaxe do código", fmt: "formata os arquivos .tf", version: "versão do Terraform e providers" },
  flags: { "-auto-approve": "aplica sem pedir confirmação (comum em pipelines)" },
  run: ({ sh, args }) => terraformRun(sh, args),
});
