import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Shell } from "../shell";
import { expectSolvable, expectWellFormed, type Solution } from "../test-utils";
import { GROUP_VARS, HANDLERS_FIXED, labs, SITE_SERIAL_YML } from "./ansible";

const PASS = "--vault-password-file ~/.vault_pass";
const lab = labs[0];

const SOLUTIONS: Record<string, Solution> = {
  "ansible-advanced-rollout": [
    [() => "ansible-inventory --graph", () => "ansible web -m ping"],
    [() => `ansible-vault encrypt group_vars/web/vault.yml ${PASS}`],
    [
      () => `ansible-playbook site.yml --check --diff ${PASS}`,
      (sh) => void sh.saveEdit(sh.resolve("roles/nginx/handlers/main.yml"), HANDLERS_FIXED),
      () => `ansible-playbook site.yml --check --diff ${PASS}`,
    ],
    [(sh) => void sh.saveEdit(sh.resolve("site.yml"), SITE_SERIAL_YML), () => `ansible-playbook site.yml ${PASS}`],
    [() => `ansible-playbook site.yml ${PASS}`],
    [(sh) => void sh.saveEdit(sh.resolve("group_vars/web/main.yml"), `${GROUP_VARS}nginx_worker_connections: 2048\n`), () => `ansible-playbook site.yml --limit web1 --tags config ${PASS}`],
    [() => `ansible web -m command -a "grep worker_connections /etc/nginx/nginx.conf" ${PASS}`],
  ],
};

/** Shell with the lab seed, the secret encrypted and the handler fixed. */
const ready = () => {
  const sh = new Shell(lab.seed);
  sh.exec(`ansible-vault encrypt group_vars/web/vault.yml ${PASS}`);
  sh.saveEdit(sh.resolve("roles/nginx/handlers/main.yml"), HANDLERS_FIXED);
  return sh;
};

describe("ansible", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it.each(labs.map((l) => [l.id, l] as const))("%s is solvable", (_, l) => {
    expectWellFormed(l);
    expectSolvable(l, SOLUTIONS[l.id]);
  });

  it("shows the inventory graph and pings every host", () => {
    const sh = new Shell(lab.seed);
    expect(sh.exec("ansible-inventory --graph").output).toBe("@all:\n  |--@ungrouped:\n  |--@web:\n  |  |--web1\n  |  |--web2\n  |  |--web3");
    const ping = sh.exec("ansible web -m ping").output;
    expect(ping.match(/\| SUCCESS =>/g)).toHaveLength(3);
    expect(ping).toContain('"ping": "pong"');
    expect(sh.exec("ansible web4 -m ping").output).toContain("No hosts matched");
  });

  it("fails like Ansible on a missing handler, a missing vault password and a wrong one", () => {
    const sh = new Shell(lab.seed);
    const broken = sh.exec("ansible-playbook site.yml --check");
    expect(broken.output).toContain("ERROR! The requested handler 'restart nginx' was not found");
    sh.exec(`ansible-vault encrypt group_vars/web/vault.yml ${PASS}`);
    expect(sh.exec("ansible-vault encrypt group_vars/web/vault.yml " + PASS).output).toContain("already encrypted");
    expect(sh.exec("ansible-playbook site.yml --check").output).toContain("ERROR! Attempting to decrypt but no vault secrets found");
    sh.writeFile("/tmp/wrong", "nope\n");
    expect(sh.exec("ansible-playbook site.yml --check --vault-password-file /tmp/wrong").output).toContain("Decryption failed");
    expect(sh.exec(`ansible-vault view group_vars/web/vault.yml ${PASS}`).output).toContain("vault_api_token: tk_live_9f3a7c21e8");
  });

  it("check mode reports changes with a diff but changes nothing, and hides no_log diffs", () => {
    const sh = ready();
    const out = sh.exec(`ansible-playbook site.yml --check --diff ${PASS}`).output;
    expect(out).toContain("TASK [nginx : Deploy nginx.conf]");
    expect(out).toContain("+    worker_connections 1024;");
    expect(out).toContain("RUNNING HANDLER [nginx : restart nginx]");
    expect(out).not.toContain("tk_live_9f3a7c21e8");
    expect(out).toMatch(/web1\s+: ok=\d+\s+changed=\d+\s+unreachable=0\s+failed=0/);
    expect(sh.state.hosts.web1.packages.nginx).toBeUndefined();
  });

  it("applies in serial batches, renders templates with vault vars and is idempotent", () => {
    const sh = ready();
    sh.saveEdit(sh.resolve("site.yml"), SITE_SERIAL_YML);
    const first = sh.exec(`ansible-playbook site.yml ${PASS}`).output;
    expect(first.match(/PLAY \[Configurar servidores web\]/g)).toHaveLength(3);
    expect(first).toContain("changed: [web1]");
    const files = sh.state.hosts.web2.files!;
    expect(files["/etc/nginx/nginx.conf"]).toContain("server_name web2;");
    expect(files["/etc/nginx/nginx.conf"]).toContain("# Ansible managed");
    expect(files["/etc/nginx/app.env"]).toBe("APP_ENV=production\nAPI_TOKEN=tk_live_9f3a7c21e8\n");
    expect(files["/var/www/html/index.html"]).toContain("10.0.1.12");
    const second = sh.exec(`ansible-playbook site.yml ${PASS}`).output;
    expect(second).not.toContain("changed: [");
    expect(second).not.toContain("RUNNING HANDLER");
    expect(second).toMatch(/web3\s+: ok=\d+\s+changed=0 /);
    expect(sh.exec("curl http://web1/healthz").output).toBe("ok");
    expect(sh.exec("curl 10.0.1.13").output).toContain("<h1>web3</h1>");
    sh.exec("ssh web1");
    expect(sh.exec("cat /etc/nginx/nginx.conf").output).toContain("worker_connections 1024;");
  });

  it("reports undefined variables, missing privileges and bad limits", () => {
    const sh = ready();
    sh.writeFile("roles/nginx/templates/index.html.j2", "<h1>{{ inventory_hostnme }}</h1>\n{{ missing | default('ok') }}\n");
    const undef = sh.exec(`ansible-playbook site.yml ${PASS}`).output;
    expect(undef).toContain("fatal: [web1]: FAILED!");
    expect(undef).toContain("'inventory_hostnme' is undefined");
    expect(undef).toMatch(/web1\s+: ok=\d+\s+changed=\d+\s+unreachable=0\s+failed=1/);

    const sh2 = ready();
    sh2.writeFile("site.yml", "- hosts: web\n  roles: [nginx]\n");
    expect(sh2.exec(`ansible-playbook site.yml ${PASS}`).output).toContain("Permission denied");
    expect(sh2.exec(`ansible-playbook site.yml --limit db ${PASS}`).output).toContain("leaves us with no hosts to target");
  });

  it("supports ad-hoc commands, encrypt_string values and role scaffolding", () => {
    const sh = ready();
    expect(sh.exec(`ansible web1 -m command -a "hostname"`).output).toContain("no vault secrets found");
    const cmd = sh.exec(`ansible web1 -m command -a "cat /etc/missing" ${PASS}`);
    expect(cmd.output).toContain("web1 | FAILED | rc=1 >>");
    const inline = sh.exec(`ansible-vault encrypt_string 'hunter2' --name 'db_password' ${PASS}`).output;
    expect(inline).toMatch(/^db_password: !vault \|\n {10}\$ANSIBLE_VAULT;1\.1;AES256/);
    sh.writeFile("host_vars/web1.yml", inline.replace("\nEncryption successful", "\n"));
    expect(sh.exec(`ansible web1 -m debug -a "var=db_password" ${PASS}`).output).toContain('"db_password": "hunter2"');
    expect(sh.exec("ansible-galaxy role init --init-path roles app").output).toBe("- Role app was created successfully");
    expect(sh.readFile("roles/app/tasks/main.yml")).toContain("tasks file for app");
  });
});
