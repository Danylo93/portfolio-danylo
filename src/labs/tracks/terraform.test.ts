import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LEGACY_TF, LOCK_ID, MOVED_TF, labs, lessons } from "./terraform";
import { Shell } from "../shell";
import { expectLessonWellFormed, expectSolvable, expectWellFormed, type Solution } from "../test-utils";
import { tfLastPlan, tfSetLock, tfState } from "../tools/terraform";
import { explainError } from "../coach";
import { fmtHcl } from "../tools/terraform-hcl";

const P = "/home/danylo/project";

const BACKEND = `  backend "s3" {
    bucket         = "acme-tfstate-prod"
    key            = "network/terraform.tfstate"
    region         = "sa-east-1"
    dynamodb_table = "terraform-locks"
    encrypt        = true
  }
`;

const SOLUTIONS: Record<string, Solution> = {
  "terraform-eks": [[() => "terraform init"], [() => "terraform plan"], [() => "terraform apply -auto-approve"], [() => "terraform state list", () => "terraform output"]],
  "terraform-remote-state": [
    [() => "terraform state list"],
    [(sh) => void sh.saveEdit(`${P}/main.tf`, sh.readFile("main.tf")!.replace('  required_version = ">= 1.6"\n', `  required_version = ">= 1.6"\n${BACKEND}`))],
    [() => "terraform init -migrate-state"],
    [() => "terraform plan"],
  ],
  "terraform-modules-moved": [
    [() => "terraform init"],
    [() => "terraform plan"],
    [(sh) => void sh.saveEdit(`${P}/moved.tf`, MOVED_TF)],
    [() => "terraform plan"],
    [() => "terraform apply -auto-approve"],
  ],
  "terraform-workspaces": [
    [() => "terraform workspace new dev"],
    [() => "terraform apply -var-file=env/dev.tfvars -auto-approve"],
    [() => "terraform workspace new prod"],
    [() => "terraform apply -var-file=env/prod.tfvars -auto-approve"],
    [() => "terraform workspace select dev && terraform output"],
  ],
  "terraform-import-drift": [
    [(sh) => void sh.saveEdit(`${P}/legacy.tf`, LEGACY_TF)],
    [() => "terraform import aws_s3_bucket.finance_reports acme-finance-reports"],
    [() => "terraform plan -refresh-only"],
    [() => "terraform apply -auto-approve"],
    [() => "terraform plan"],
  ],
  "terraform-broken-pipeline": [
    [() => "terraform validate", (sh) => void sh.saveEdit(`${P}/main.tf`, sh.readFile("main.tf")!.replace("retention_in_days 365", "retention_in_days = 365"))],
    [() => "terraform validate", (sh) => void sh.saveEdit(`${P}/main.tf`, sh.readFile("main.tf")!.replace("var.enviroment", "var.environment"))],
    [() => "terraform plan"],
    [() => `terraform force-unlock -force ${LOCK_ID}`],
    [() => "terraform apply -auto-approve"],
  ],
};

const lab = (id: string) => labs.find((l) => l.id === id)!;
const last = (sh: Shell) => sh.entries[sh.entries.length - 1];

describe("terraform track", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it.each(labs.map((l) => [l.id, l] as const))("%s", (_, l) => {
    expectWellFormed(l);
    expectSolvable(l, SOLUTIONS[l.id]);
  });

  it.each(lessons.map((l) => [l.id, l] as const))("lesson %s", (_, l) => {
    expectLessonWellFormed(l);
    expect(labs.some((x) => x.id === l.before), `${l.id} before`).toBe(true);
  });
});

describe("terraform engine", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("plan without moved destroys; with moved shows 0 to destroy", () => {
    const sh = new Shell(lab("terraform-modules-moved").seed);
    sh.exec("terraform init");
    const bad = sh.exec("terraform plan").output;
    expect(bad).toContain("Plan: 4 to add, 0 to change, 4 to destroy.");
    expect(bad).toContain("# aws_s3_bucket.logs will be destroyed");
    sh.saveEdit(`${P}/moved.tf`, MOVED_TF);
    const good = sh.exec("terraform plan").output;
    expect(good).toContain("# aws_s3_bucket.logs has moved to module.logs.aws_s3_bucket.this");
    expect(good).toContain("Plan: 0 to add, 0 to change, 0 to destroy.");
  });

  it("state mv is an alternative to moved blocks", () => {
    const sh = new Shell(lab("terraform-modules-moved").seed);
    sh.exec("terraform init");
    expect(sh.exec("terraform state mv aws_s3_bucket.logs module.logs.aws_s3_bucket.this").output).toContain("Successfully moved 1 object(s).");
    expect(sh.exec("terraform state mv aws_s3_bucket.nope module.logs.aws_s3_bucket.x").output).toContain("Invalid source address");
    expect(explainError(last(sh), sh)).toContain("Endereço");
  });

  it("reports the state lock and force-unlock needs the right ID", () => {
    const sh = new Shell(lab("terraform-workspaces").seed);
    tfSetLock(sh, "acme-tfstate-prod/web/terraform.tfstate", { ID: "abc-123" });
    const out = sh.exec("terraform plan -var-file=env/dev.tfvars").output;
    expect(out).toContain("│ Error: Error acquiring the state lock");
    expect(out).toContain("ID:        abc-123");
    expect(last(sh).ok).toBe(false);
    expect(explainError(last(sh), sh)).toContain("force-unlock -force abc-123");
    expect(sh.exec("terraform force-unlock -force wrong").output).toContain('does not match existing lock ID "abc-123"');
    expect(sh.exec("terraform force-unlock -force abc-123").output).toContain("successfully unlocked");
    expect(sh.exec("terraform plan -var-file=env/dev.tfvars").output).toContain("Plan: 1 to add");
  });

  it("validate reports syntax errors with file:line, then undeclared references", () => {
    const sh = new Shell(lab("terraform-broken-pipeline").seed);
    const out = sh.exec("terraform validate").output;
    expect(out).toContain("│ Error: Invalid block definition");
    expect(out).toMatch(/on main\.tf line \d+, in resource "aws_cloudwatch_log_group" "audit":/);
    expect(out).toContain("retention_in_days 365");
    sh.saveEdit(`${P}/main.tf`, sh.readFile("main.tf")!.replace("retention_in_days 365", "retention_in_days = 365"));
    const out2 = sh.exec("terraform validate").output;
    expect(out2).toContain("Reference to undeclared input variable");
    expect(out2).toContain('Did you mean "environment"?');
  });

  it("backend change requires init and migration keeps resources", () => {
    const sh = new Shell(lab("terraform-remote-state").seed);
    sh.saveEdit(`${P}/main.tf`, sh.readFile("main.tf")!.replace('  required_version = ">= 1.6"\n', `  required_version = ">= 1.6"\n${BACKEND}`));
    expect(sh.exec("terraform plan").output).toContain("Backend initialization required");
    expect(explainError(last(sh), sh)).toContain("-migrate-state");
    expect(sh.exec("terraform init").output).toContain("-migrate-state");
    sh.exec("terraform init -migrate-state");
    expect(Object.keys(tfState(sh)!.resources)).toEqual(["aws_subnet.private[0]", "aws_subnet.private[1]", "aws_vpc.main"]);
    expect(sh.exec("terraform plan").output).toContain("No changes.");
  });

  it("detects drift and imports", () => {
    const sh = new Shell(lab("terraform-import-drift").seed);
    const out = sh.exec("terraform plan -refresh-only").output;
    expect(out).toContain("Objects have changed outside of Terraform");
    expect(out).toContain('~ "Owner"');
    expect(tfLastPlan(sh)?.drift).toBe(2);
    expect(sh.exec("terraform import aws_s3_bucket.finance_reports acme-finance-reports").output).toContain("does not exist");
    sh.saveEdit(`${P}/legacy.tf`, LEGACY_TF);
    expect(sh.exec("terraform import aws_s3_bucket.finance_reports nope").output).toContain("Cannot import non-existent remote object");
    expect(sh.exec("terraform import aws_s3_bucket.finance_reports acme-finance-reports").output).toContain("Import successful!");
  });

  it("workspaces and vars", () => {
    const sh = new Shell(lab("terraform-workspaces").seed);
    expect(sh.exec("terraform plan").output).toContain("No value for required variable");
    expect(sh.exec("terraform workspace select qa").output).toContain(`Workspace "qa" doesn't exist.`);
    expect(last(sh).ok).toBe(false);
    expect(explainError(last(sh), sh)).toContain("workspace new qa");
    sh.exec("terraform workspace new dev");
    sh.exec("terraform apply -var-file=env/dev.tfvars -auto-approve");
    expect(sh.exec("terraform output -raw instance_type").output).toBe("t3.micro");
    expect(sh.exec("terraform workspace list").output).toContain("* dev");
    expect(sh.exec("terraform output -json instance_ids").output).toMatch(/"i-[0-9a-f]{17}"/);
  });

  it("plan -out and apply of a saved plan; replace and update diffs", () => {
    const sh = new Shell(lab("terraform-eks").seed);
    sh.exec("terraform init");
    sh.exec("terraform plan -out=tfplan");
    expect(sh.exec("terraform apply tfplan").output).toContain("Apply complete! Resources: 3 added, 0 changed, 0 destroyed.");
    expect(sh.exec("terraform apply tfplan").output).toContain("Failed to load");
    sh.saveEdit(`${P}/main.tf`, sh.readFile("main.tf")!.replace('"10.0.0.0/16"', '"10.1.0.0/16"').replace('"1.30"', '"1.31"'));
    const out = sh.exec("terraform plan").output;
    expect(out).toContain("# aws_vpc.lab must be replaced");
    expect(out).toContain("# forces replacement");
    expect(out).toContain('~ version = "1.30" -> "1.31"');
    expect(sh.exec("terraform destroy -auto-approve").output).toContain("Destroy complete! Resources: 3 destroyed.");
  });

  it("unknown subcommand suggests the closest one", () => {
    const sh = new Shell();
    expect(sh.exec("terraform pln").output).toContain('Terraform has no command named "pln". Did you mean "plan"?');
    expect(last(sh).ok).toBe(false);
    expect(explainError(last(sh), sh)).toContain('"plan"');
  });

  it("fmt aligns equals signs", () => {
    expect(fmtHcl('resource "a" "b" {\nbucket="x"\n    instance_type = "y"\n}\n')).toBe('resource "a" "b" {\n  bucket        = "x"\n  instance_type = "y"\n}\n');
    const sh = new Shell({ files: { "main.tf": 'resource "aws_s3_bucket" "b" {\nbucket="x"\n}\n' } });
    expect(sh.exec("terraform fmt -check").output).toBe("main.tf");
    expect(last(sh).ok).toBe(false);
    sh.exec("terraform fmt");
    expect(sh.readFile("main.tf")).toBe('resource "aws_s3_bucket" "b" {\n  bucket = "x"\n}\n');
  });
});
