# Laboratório local no WSL2

O site funciona com Node.js. Docker, Kubernetes e as demais CLIs servem para praticar **fora** do simulador, em um ambiente real. Instalar essas ferramentas não conecta automaticamente o terminal do navegador ao WSL.

## 1. Preparar o Windows

No PowerShell como administrador:

```powershell
wsl --install -d Ubuntu-24.04
wsl --update
wsl --list --verbose
```

Reinicie se solicitado, abra Ubuntu e crie seu usuário Linux. A distribuição deve aparecer com VERSION 2. Para converter uma instalação existente, use `wsl --set-version Ubuntu-24.04 2` (ajuste o nome conforme a listagem).

Mantenha o projeto no filesystem Linux (`~/projetos`), evitando `/mnt/c` para melhorar o desempenho de npm e Docker.

## 2. Clonar e instalar

No terminal Ubuntu, **sem executar o script com sudo**:

```bash
sudo apt-get update && sudo apt-get install -y git
mkdir -p ~/projetos
cd ~/projetos
git clone https://github.com/Danylo93/portfolio-danylo.git
cd portfolio-danylo
bash scripts/install-wsl.sh
source "$HOME/.local/share/danylo-labs/env.sh"
npm ci
npm run dev
```

Abra **http://localhost:8080/labs** no Windows. Para usar apenas o site, substitua a instalação por `bash scripts/install-wsl.sh --app-only`: nenhum cluster é necessário.

O instalador suporta Ubuntu 22.04/24.04 no WSL2, x86_64 e ARM64. Usa apt para dependências e releases oficiais com SHA-256 para os binários. As versões são fixadas no script; não executa scripts remotos via `curl | bash`, não altera kubeconfig e não cria recursos de nuvem.

| Ferramentas | Uso |
| --- | --- |
| Node.js 22 + npm, Git, build-essential | Rodar e desenvolver a plataforma |
| kubectl, Kind | Kubernetes local em containers |
| K9s, kubectx, kubens | Navegar pelo cluster, contextos e namespaces |
| Helm 3 | Instalar charts |
| Terraform | Praticar infraestrutura como código |
| GitHub CLI (`gh`) | Repositórios e workflows; autenticação separada com `gh auth login` |
| jq, curl, unzip, Python 3, pipx, ShellCheck | Diagnóstico, scripts e ferramentas isoladas |

Binários ficam em `~/.local/share/danylo-labs/bin`. O script acrescenta uma linha de PATH aos perfis, sem substituir suas configurações. Pode ser executado novamente; instala as mesmas versões. O registro fica em `~/.local/share/danylo-labs/versions.txt`. Node/Kubernetes de outras instalações permanecem no disco; o PATH dos labs tem prioridade depois de carregar `env.sh`.

## 3. Escolher um Docker

**Docker Desktop:** instale-o no Windows pelo [site oficial](https://docs.docker.com/desktop/setup/install/windows-install/), habilite o backend WSL2 e a integração em Settings → Resources → WSL Integration para sua distribuição. Reinicie o terminal e confira `docker info` e `docker compose version`.

**Docker Engine dentro do Ubuntu:** alternativa sem Docker Desktop. Habilite systemd adicionando (ou mesclando) em `/etc/wsl.conf`:

```ini
[boot]
systemd=true
```

Execute `wsl --shutdown` no PowerShell, reabra Ubuntu e rode:

```bash
bash scripts/install-wsl.sh --docker-engine
```

Feche e reabra a sessão para aplicar o grupo `docker` (esse grupo concede privilégios equivalentes a root). O script preserva Docker existente. Use uma das opções e evite instalar dois engines para a mesma distribuição.

## 4. Verificar e criar o cluster

```bash
bash scripts/check-local.sh
bash scripts/lab-cluster.sh create
kubectl --context kind-danylo-lab get nodes
k9s --context kind-danylo-lab
```

O diagnóstico informa ferramentas ausentes e conexão com Docker; retorna código diferente de zero se faltar requisito do ambiente completo. O cluster é opcional no diagnóstico. O helper usa o contexto explícito `kind-danylo-lab`; a criação/exportação do Kind seleciona esse contexto no kubeconfig. Confirme seu contexto antes de voltar ao trabalho.

O padrão é **1 nó**, mais leve para máquinas com 8 GB de RAM total. Comece com aproximadamente 4 GB disponíveis ao WSL; o consumo varia com os workloads. Para estudar scheduling/drain com 1 control plane e 2 workers, reserve mais memória (cerca de 6–8 GB livres para o WSL):

```bash
bash scripts/lab-cluster.sh create --multinode
```

Se o cluster já existir, ele é preservado e a topologia não muda. Para trocar, apague explicitamente o cluster local e recrie. Dados dentro desse cluster serão perdidos:

```bash
bash scripts/lab-cluster.sh delete --yes
bash scripts/lab-cluster.sh create --multinode
```

Kubernetes está fixado em 1.35.8 (imagem com digest) e kubectl usa a mesma versão. A simulação do site modela uma versão independente; algumas saídas serão diferentes.

## 5. Primeiro exercício real

```bash
kubectl --context kind-danylo-lab create namespace pratica
kubectl --context kind-danylo-lab -n pratica create deployment web --image=nginx:stable-alpine
kubectl --context kind-danylo-lab -n pratica rollout status deployment/web --timeout=120s
kubectl --context kind-danylo-lab -n pratica scale deployment/web --replicas=2
kubectl --context kind-danylo-lab -n pratica get pods -o wide
kubectl --context kind-danylo-lab -n pratica expose deployment web --port=80
kubectl --context kind-danylo-lab -n pratica port-forward service/web 8081:80
```

Abra http://localhost:8081. Encerre o encaminhamento com Ctrl+C. No K9s: `:pods` lista pods, `:deploy` lista deployments, `:ns` troca namespace, `l` abre logs, `d` descreve e `?` mostra atalhos. Para limpar somente o exercício: `kubectl --context kind-danylo-lab delete namespace pratica`.

## Limites e próximos passos

- Progresso, quizzes e verificações pertencem ao navegador; comandos rodados no WSL não marcam os labs como concluídos.
- Seeds do simulador (arquivos, falhas, recursos AWS) não são provisionadas no cluster real. O exemplo acima é um exercício independente.
- AWS CLI, Argo CD, Ansible e scanners DevSecOps não são necessários para rodar o site e não são instalados pelo perfil base. Para praticar essas trilhas fora do simulador, instale/configure cada ferramenta e prepare seus recursos reais separadamente.
- Não execute os exemplos Terraform/AWS do simulador diretamente em uma conta real sem revisar credenciais, recursos e custos.
- Falha de download/checksum: não pule a verificação; confira conexão/proxy e disponibilidade da versão oficial e execute novamente.
- `docker: permission denied`: reabra a sessão após configurar o grupo. Com Docker Desktop, confira a integração da distribuição.
- `node` antigo: carregue `env.sh` e confira `which node`. NVM ou configurações posteriores do shell podem alterar a prioridade do PATH.
- Porta 8080 ocupada: `npm run dev -- --port 8082`; abra localhost:8082/labs.

Referências: [WSL](https://learn.microsoft.com/windows/wsl/install), [systemd no WSL](https://learn.microsoft.com/windows/wsl/systemd), [Kind](https://kind.sigs.k8s.io/docs/user/quick-start/), [kubectl](https://kubernetes.io/docs/tasks/tools/install-kubectl-linux/), [K9s](https://k9scli.io/topics/install/).
