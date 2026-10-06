import "../tools/ansible";
import type { Shell } from "../shell";
import type { Lab, Track } from "../types";
import { HOME } from "../util";
import { ansibleState, vaultDecrypt } from "../tools/ansible";

export const track: Track = {
  id: "ansible",
  title: "Ansible · Automação",
  desc: "Gerência de configuração em frota: inventário, roles, templates Jinja2, handlers, ansible-vault, dry-run com --check --diff, rolling update com serial e idempotência.",
  color: "#ef4444",
  icon: "⚙️",
};

const WEB = ["web1", "web2", "web3"];
const VAULT_PASS = "S3nh@-do-V4ult";

export const SITE_YML = `---
- name: Configurar servidores web
  hosts: web
  become: true
  roles:
    - nginx
`;

export const SITE_SERIAL_YML = `---
- name: Configurar servidores web
  hosts: web
  become: true
  serial: 1
  roles:
    - nginx
`;

export const GROUP_VARS = `---
app_env: production
# O valor real fica no vault.yml (criptografado); aqui só a referência.
api_token: "{{ vault_api_token }}"
`;

export const HANDLERS_BROKEN = `---
- name: Restart nginx
  ansible.builtin.service:
    name: nginx
    state: restarted
`;

export const HANDLERS_FIXED = HANDLERS_BROKEN.replace("name: Restart nginx", "name: restart nginx");

const TASKS = `---
- name: Install nginx
  ansible.builtin.apt:
    name: nginx
    state: present
    update_cache: true
    cache_valid_time: 3600
  tags: [install]

- name: Deploy nginx.conf
  ansible.builtin.template:
    src: nginx.conf.j2
    dest: /etc/nginx/nginx.conf
    mode: "0644"
  notify: restart nginx
  tags: [config]

- name: Deploy status page
  ansible.builtin.template:
    src: index.html.j2
    dest: /var/www/html/index.html
    mode: "0644"
  tags: [config]

- name: Deploy app environment (secrets)
  ansible.builtin.template:
    src: app.env.j2
    dest: /etc/nginx/app.env
    mode: "0600"
  no_log: true
  tags: [config]

- name: Ensure nginx is running and enabled
  ansible.builtin.service:
    name: nginx
    state: started
    enabled: true
`;

const NGINX_CONF_J2 = `# {{ ansible_managed }}
user www-data;
worker_processes auto;
pid /run/nginx.pid;

events {
    worker_connections {{ nginx_worker_connections }};
}

http {
    sendfile on;
    server {
        listen {{ nginx_port }};
        server_name {{ inventory_hostname }};
        root /var/www/html;

        location /healthz {
            return 200 "ok\\n";
        }
    }
}
`;

const conf = (sh: Shell, host: string) => sh.state.hosts[host]?.files?.["/etc/nginx/nginx.conf"] ?? "";
const connections = (sh: Shell, host: string) => /worker_connections (\d+);/.exec(conf(sh, host))?.[1];
const vaultFile = (sh: Shell) => sh.readFile("group_vars/web/vault.yml") ?? "";
const lastError = (sh: Shell) => ansibleState(sh).runs.at(-1)?.error ?? "";

export const labs: Lab[] = [
  {
    id: "ansible-advanced-rollout",
    track: "ansible",
    kind: "challenge",
    title: "Ansible avançado: role, vault e rolling update da frota web",
    summary: "Corrija uma role, proteja segredos com vault, faça dry-run, rollout com serial, canário com --limit/--tags e prove a idempotência.",
    level: "Avançado",
    minutes: 25,
    skills: ["ansible roles", "handlers", "ansible-vault", "--check --diff", "serial (rolling update)", "idempotência", "--limit e --tags", "ansible ad-hoc"],
    seed: {
      files: {
        "ansible.cfg": "[defaults]\ninventory = inventory.ini\nroles_path = roles\nhost_key_checking = False\nretry_files_enabled = False\n# vault_password_file = ~/.vault_pass\n",
        "inventory.ini": "[web]\nweb1 ansible_host=10.0.1.11\nweb2 ansible_host=10.0.1.12\nweb3 ansible_host=10.0.1.13\n\n[web:vars]\nansible_user=deploy\nansible_python_interpreter=/usr/bin/python3\n",
        "site.yml": SITE_YML,
        "group_vars/web/main.yml": GROUP_VARS,
        "group_vars/web/vault.yml": "---\n# ATENÇÃO: este arquivo está em texto claro no repositório!\nvault_api_token: tk_live_9f3a7c21e8\n",
        "roles/nginx/defaults/main.yml": "---\nnginx_worker_connections: 1024\nnginx_port: 80\n",
        "roles/nginx/tasks/main.yml": TASKS,
        "roles/nginx/handlers/main.yml": HANDLERS_BROKEN,
        "roles/nginx/templates/nginx.conf.j2": NGINX_CONF_J2,
        "roles/nginx/templates/index.html.j2": "<h1>{{ inventory_hostname }}</h1>\n<p>ambiente: {{ app_env }} · {{ ansible_host }}</p>\n",
        "roles/nginx/templates/app.env.j2": "APP_ENV={{ app_env }}\nAPI_TOKEN={{ api_token }}\n",
        [`${HOME}/.vault_pass`]: `${VAULT_PASS}\n`,
      },
      setup: (sh) => {
        WEB.forEach((name, i) => {
          const host = sh.hostOf(name);
          host.ip = `10.0.1.${11 + i}`;
          host.packages = { "openssh-server": "1:9.6p1-3ubuntu13", python3: "3.12.3-0ubuntu2" };
          host.services = { ssh: { active: true, enabled: true, logs: [] } };
        });
      },
    },
    intro: "🏢 Você herdou o repositório Ansible que configura a frota web (web1, web2 e web3). A role nginx está quase pronta, mas tem um bug, o token da API está em texto claro e o time exige rollout gradual. Leve a frota ao estado desejado como faria em produção.",
    steps: [
      {
        title: "Inventário e conectividade",
        body: [
          "O ansible.cfg do projeto aponta para inventory.ini. Veja como o Ansible interpreta o inventário e teste a conexão com os três servidores do grupo web.",
        ],
        code: ["ansible-inventory --graph", "ansible web -m ping"],
        hints: [
          "ansible-inventory mostra o inventário como o Ansible o entende (grupos e hosts). O módulo ping testa SSH + Python no host, não ICMP.",
          "ansible-inventory --graph e depois ansible <grupo> -m ping",
          "ansible-inventory --graph && ansible web -m ping",
        ],
        explain: [
          "web1, web2 e web3 responderam pong: o Ansible conectou por SSH como deploy e executou um módulo Python em cada host.",
          "O ping do Ansible valida o caminho completo que os playbooks vão usar (SSH, usuário, Python). Use ansible-inventory --graph --vars para ver também as variáveis de cada grupo.",
        ],
        diagnose: (sh) => {
          const st = ansibleState(sh);
          if (!st.graph) return "Falta visualizar o inventário: ansible-inventory --graph.";
          const missing = WEB.filter((h) => !st.pings.has(h));
          return missing.length ? `Falta testar a conexão com ${missing.join(", ")}: ansible web -m ping.` : null;
        },
        check: (sh) => ansibleState(sh).graph && WEB.every((h) => ansibleState(sh).pings.has(h)),
      },
      {
        title: "Criptografar o segredo com ansible-vault",
        body: [
          "group_vars/web/vault.yml guarda o token da API em texto claro: qualquer pessoa com acesso ao repositório consegue lê-lo. Criptografe o arquivo com ansible-vault usando a senha de ~/.vault_pass, que fica fora do repositório.",
          "Repare no padrão: a variável real (vault_api_token) fica no arquivo criptografado, e group_vars/web/main.yml apenas a referencia (api_token: \"{{ vault_api_token }}\"). Assim um grep encontra onde a variável é usada sem abrir o vault.",
        ],
        code: ["ansible-vault encrypt group_vars/web/vault.yml --vault-password-file ~/.vault_pass", "cat group_vars/web/vault.yml"],
        hints: [
          "O ansible-vault criptografa o arquivo inteiro com AES256. O Ansible descriptografa em memória durante a execução.",
          "ansible-vault encrypt <arquivo> --vault-password-file <arquivo-com-a-senha>",
          "ansible-vault encrypt group_vars/web/vault.yml --vault-password-file ~/.vault_pass",
        ],
        explain: [
          "O arquivo agora começa com $ANSIBLE_VAULT;1.1;AES256: pode ser versionado sem expor o token. Para consultar ou alterar, use ansible-vault view ou ansible-vault edit.",
          "Em pipelines, a senha vem de um secret do CI (ou de um script que consulta o AWS Secrets Manager/HashiCorp Vault) apontado por vault_password_file. Nunca comite o arquivo de senha: coloque-o no .gitignore.",
        ],
        diagnose: (sh) => (vaultFile(sh).startsWith("$ANSIBLE_VAULT") ? "O arquivo está criptografado, mas não com a senha de ~/.vault_pass. Descriptografe com a senha usada e criptografe de novo com --vault-password-file ~/.vault_pass." : "group_vars/web/vault.yml continua em texto claro."),
        check: (sh) => {
          const text = vaultFile(sh);
          const pass = (sh.readFile("~/.vault_pass") ?? "").split("\n")[0].trim();
          return text.startsWith("$ANSIBLE_VAULT;1.1;AES256") && !!vaultDecrypt(text, pass)?.includes("vault_api_token:");
        },
      },
      {
        title: "Dry-run com --check --diff",
        body: [
          "Antes de alterar produção, simule: --check não muda nada nos hosts e --diff mostra o que cada template mudaria. Rode o playbook em modo de verificação, passando a senha do vault.",
          "O primeiro dry-run vai falhar. Leia o erro, corrija o arquivo da role e rode de novo até o PLAY RECAP sair sem falhas.",
        ],
        code: ["ansible-playbook site.yml --check --diff --vault-password-file ~/.vault_pass", "vi roles/nginx/handlers/main.yml"],
        hints: [
          "O erro fala de um handler que não foi encontrado. Compare o texto de notify: nas tasks com o name: do handler.",
          "tasks/main.yml notifica restart nginx, mas o handler se chama Restart nginx. O nome precisa ser idêntico (maiúsculas contam); outra opção é declarar listen: restart nginx no handler.",
          "- name: restart nginx\n  ansible.builtin.service:\n    name: nginx\n    state: restarted",
        ],
        explain: [
          "Com o nome corrigido, o dry-run percorreu os três hosts: o diff mostrou o nginx.conf e o index.html que seriam criados e o handler que seria disparado, sem instalar nem alterar nada.",
          "A task com no_log: true não mostrou diff: o app.env contém o token, e o --diff o vazaria no log do CI. Use no_log em tudo que manipula segredos.",
        ],
        diagnose: (sh) => {
          const err = lastError(sh);
          if (/requested handler/.test(err)) return "O dry-run parou porque a task notifica restart nginx e o handler se chama Restart nginx. Corrija roles/nginx/handlers/main.yml (vi) e rode de novo.";
          if (/no vault secrets/.test(err)) return "O playbook precisa da senha do vault para ler group_vars/web/vault.yml. Acrescente --vault-password-file ~/.vault_pass.";
          if (ansibleState(sh).runs.some((r) => !r.check)) return "Você rodou sem --check. Este passo pede o dry-run: ansible-playbook site.yml --check --diff --vault-password-file ~/.vault_pass.";
          return null;
        },
        check: (sh) => ansibleState(sh).runs.some((r) => r.check && r.completed && !r.failed && r.hosts.length === 3),
      },
      {
        title: "Rolling update com serial",
        body: [
          "Agora aplique de verdade, mas um servidor por vez: se algo quebrar no web1, web2 e web3 continuam servindo. Adicione serial: 1 ao play em site.yml e rode o playbook sem --check.",
        ],
        code: ["vi site.yml", "ansible-playbook site.yml --vault-password-file ~/.vault_pass"],
        hints: [
          "serial controla quantos hosts recebem o play por vez (número ou porcentagem). Com max_fail_percentage, um lote com falha interrompe o rollout.",
          "No play, no mesmo nível de hosts e become, adicione serial: 1.",
          SITE_SERIAL_YML.replace("---\n", ""),
        ],
        explain: [
          "O PLAY rodou três vezes, um lote por host: instalação, templates e o handler restart nginx em web1, depois em web2, depois em web3.",
          "Em produção, combine serial com um pre_task que tira o host do load balancer e um post_task que valida o /healthz antes de devolvê-lo. Assim o rollout nunca derruba mais de uma instância.",
        ],
        diagnose: (sh) => {
          const st = ansibleState(sh);
          if (!/^\s+serial:\s*1\s*$/m.test(sh.readFile("site.yml") ?? "")) return "site.yml ainda não tem serial: 1 no play.";
          const last = st.runs.at(-1);
          if (last?.check) return "O último run foi com --check. Rode sem --check para aplicar.";
          if (last?.failed) return "O último run falhou. Leia o fatal:/ERROR! acima e corrija antes de rodar de novo.";
          return WEB.every((h) => connections(sh, h) === "1024") ? "Os hosts estão configurados, mas nenhum run completo usou serial: 1. Rode o playbook de novo depois de salvar o site.yml." : null;
        },
        check: (sh) =>
          ansibleState(sh).runs.some((r) => !r.check && r.completed && !r.failed && r.serial === 1 && r.hosts.length === 3) &&
          WEB.every((h) => sh.state.hosts[h].services.nginx?.active && connections(sh, h) === "1024"),
      },
      {
        title: "Provar a idempotência",
        body: ["Rode o mesmo playbook de novo. Um playbook bem escrito é idempotente: se nada mudou, nada deve ser alterado e nenhum handler deve disparar."],
        code: ["ansible-playbook site.yml --vault-password-file ~/.vault_pass"],
        hints: [
          "Idempotência: aplicar N vezes tem o mesmo efeito de aplicar uma. Observe o changed= no PLAY RECAP.",
          "Rode o playbook de novo, com a mesma senha do vault e sem --check.",
          "ansible-playbook site.yml --vault-password-file ~/.vault_pass",
        ],
        explain: [
          "changed=0 nos três hosts: os módulos compararam o estado desejado com o real e não fizeram nada. O handler não rodou porque nenhum template mudou.",
          "Por isso se evita command/shell para instalar e configurar: eles sempre reportam changed. Quando precisar deles, use creates:, removes: ou changed_when: para mantê-los idempotentes.",
        ],
        check: (sh) => {
          const full = ansibleState(sh).runs.filter((r) => !r.check && r.completed && !r.failed && r.hosts.length === 3);
          const last = full.at(-1);
          return full.length >= 2 && !!last && WEB.every((h) => last.changed[h] === 0);
        },
      },
      {
        title: "Canário de configuração com --limit e --tags",
        body: [
          "O time quer testar nginx_worker_connections: 2048. Defina o novo valor em group_vars/web/main.yml e aplique primeiro só no web1 e só nas tasks de configuração (tag config). web2 e web3 devem continuar com 1024.",
        ],
        code: ["vi group_vars/web/main.yml", "ansible-playbook site.yml --limit web1 --tags config --vault-password-file ~/.vault_pass"],
        hints: [
          "group_vars tem precedência maior que os defaults da role. --limit restringe os hosts; --tags restringe as tasks.",
          "Adicione nginx_worker_connections: 2048 em group_vars/web/main.yml e rode o playbook com --limit web1 --tags config.",
          "ansible-playbook site.yml --limit web1 --tags config --vault-password-file ~/.vault_pass",
        ],
        explain: [
          "Só o web1 recebeu o novo nginx.conf e só ele reiniciou o nginx. O handler roda mesmo com --tags, porque foi notificado por uma task selecionada.",
          "Esse é o canário de configuração: valide as métricas no web1 e depois rode sem --limit para os demais. Cuidado: até lá, o repositório já diz 2048 para todos. Não esqueça de completar o rollout.",
        ],
        diagnose: (sh) => {
          if (!/nginx_worker_connections:\s*2048/.test(sh.readFile("group_vars/web/main.yml") ?? "")) return "Defina nginx_worker_connections: 2048 em group_vars/web/main.yml.";
          if (connections(sh, "web2") === "2048" || connections(sh, "web3") === "2048") return "O valor novo chegou também ao web2/web3. Volte-os com: ansible-playbook site.yml --limit web2,web3 --tags config -e nginx_worker_connections=1024 --vault-password-file ~/.vault_pass";
          if (connections(sh, "web1") !== "2048") return "O web1 ainda está com 1024. Rode o playbook com --limit web1 --tags config.";
          return "Aplique com --limit web1 e --tags config, para que só as tasks de configuração rodem no canário.";
        },
        check: (sh) => {
          const st = ansibleState(sh);
          return connections(sh, "web1") === "2048" && connections(sh, "web2") === "1024" && connections(sh, "web3") === "1024" &&
            st.runs.some((r) => !r.check && r.completed && !r.failed && r.hosts.length === 1 && r.hosts[0] === "web1" && r.tags.includes("config")) &&
            (st.restarts.web1 ?? 0) > (st.restarts.web2 ?? 0);
        },
      },
      {
        title: "Verificar a frota com um comando ad-hoc",
        body: [
          "Confirme o estado real dos três servidores de uma vez, sem abrir SSH em cada um: use o módulo command para buscar worker_connections no nginx.conf de todo o grupo web.",
          "Comandos ad-hoc também carregam os group_vars dos hosts, então precisam da senha do vault. Para não repetir a flag, você pode descomentar vault_password_file no ansible.cfg.",
        ],
        code: ["ansible web -m command -a \"grep worker_connections /etc/nginx/nginx.conf\" --vault-password-file ~/.vault_pass"],
        hints: [
          "Comandos ad-hoc (ansible <padrão> -m <módulo> -a <args>) servem para inspeção rápida e emergências.",
          "ansible web -m command -a \"grep <texto> <arquivo>\" --vault-password-file ~/.vault_pass",
          "ansible web -m command -a \"grep worker_connections /etc/nginx/nginx.conf\" --vault-password-file ~/.vault_pass",
        ],
        explain: [
          "web1 mostra 2048 e web2/web3 mostram 1024: a frota está exatamente no estado de canário que você planejou. Confira também com curl http://web1/healthz.",
          "Ad-hoc é ótimo para inspeção e emergências (ansible web -b -m service -a \"name=nginx state=restarted\"), mas mudanças permanentes devem ir para o playbook versionado.",
        ],
        diagnose: (sh) =>
          sh.entries.some((e) => /^ansible /.test(e.cmd) && /no vault secrets found/.test(e.output))
            ? "O ad-hoc também lê group_vars/web/vault.yml. Acrescente --vault-password-file ~/.vault_pass (ou descomente vault_password_file no ansible.cfg)."
            : null,
        check: (sh) => ansibleState(sh).adhoc.some((a) => (a.module === "command" || a.module === "shell") && a.ok && WEB.every((h) => a.hosts.includes(h)) && /nginx\.conf/.test(a.args)),
      },
    ],
    outro: "Frota configurada como em produção: role corrigida, segredo no vault, dry-run antes de aplicar, rollout um host por vez, idempotência comprovada e canário controlado. O próximo passo natural é rodar tudo isso num pipeline (ansible-lint + --check no PR, apply no merge).",
  },
];
