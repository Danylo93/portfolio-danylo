#!/usr/bin/env bash
# Ubuntu on WSL2. Run as your normal user; sudo is only used for apt/system services.
set -Eeuo pipefail
trap 'printf "\nInstalação interrompida na linha %s. Corrija o erro e execute novamente.\n" "$LINENO" >&2' ERR

usage() {
  cat <<'HELP'
Uso: bash scripts/install-wsl.sh [--app-only] [--docker-engine] [--help]
  padrão          Node.js + ferramentas de laboratório; usa Docker Desktop integrado ao WSL
  --app-only      apenas Node.js e dependências básicas para executar o site
  --docker-engine instala Docker Engine no Ubuntu (alternativa ao Docker Desktop)
Não cria cluster nem executa npm install. Downloads são verificados com SHA-256.
HELP
}
app_only=false
docker_engine=false
for arg in "$@"; do
  case "$arg" in
    --app-only) app_only=true ;;
    --docker-engine) docker_engine=true ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'Opção desconhecida: %s\n' "$arg" >&2; usage; exit 2 ;;
  esac
done
if $app_only && $docker_engine; then echo 'Use --app-only ou --docker-engine, não ambos.' >&2; exit 2; fi
[[ $EUID -ne 0 ]] || { echo 'Execute sem sudo, como seu usuário do WSL.' >&2; exit 1; }
[[ -f /etc/os-release ]] || { echo 'Este script requer Ubuntu no WSL2.' >&2; exit 1; }
# shellcheck disable=SC1091
source /etc/os-release
[[ $ID == ubuntu && ( $VERSION_ID == 24.04 || $VERSION_ID == 22.04 ) ]] || {
  echo 'Suportado: Ubuntu 22.04 ou 24.04 no WSL2.' >&2; exit 1;
}
grep -qi 'microsoft.*WSL2' /proc/sys/kernel/osrelease || {
  echo 'WSL2 não detectado. No PowerShell, confira: wsl --list --verbose' >&2; exit 1;
}
case "$(uname -m)" in
  x86_64) arch=amd64; node_arch=x64 ;;
  aarch64|arm64) arch=arm64; node_arch=arm64 ;;
  *) echo 'Arquitetura não suportada (use x86_64 ou arm64).' >&2; exit 1 ;;
esac

NODE_VERSION=v22.23.2
KUBECTL_VERSION=v1.35.8
KIND_VERSION=v0.33.0
HELM_VERSION=v3.19.0
K9S_VERSION=v0.51.0
TERRAFORM_VERSION=1.14.3
install_root="$HOME/.local/share/danylo-labs"
mkdir -p "$install_root/bin"
export PATH="$install_root/bin:$PATH"
tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT
fetch() { curl --fail --silent --show-error --location --retry 3 --connect-timeout 20 --max-time 300 --proto '=https' --tlsv1.2 "$1" -o "$2"; }
verify() {
  local file=$1 checksum_file=$2 expected
  expected=$(awk -v name="$(basename "$file")" '$2 == name || $2 == "*" name {print $1}' "$checksum_file")
  # kubectl and Helm publish the bare checksum instead of a manifest.
  if [[ -z $expected && $(wc -w < "$checksum_file") -eq 1 ]]; then expected=$(cat "$checksum_file"); fi
  [[ $expected =~ ^[[:xdigit:]]{64}$ ]] || { echo "Checksum ausente/inválido: $file" >&2; return 1; }
  printf '%s  %s\n' "$expected" "$file" | sha256sum --check --status
}
install_binary() { install -m 0755 "$1" "$install_root/bin/$2"; }

sudo apt-get update
sudo apt-get install -y ca-certificates curl git jq unzip xz-utils build-essential python3
node_archive="node-${NODE_VERSION}-linux-${node_arch}.tar.xz"
if [[ ! -x $install_root/node-${NODE_VERSION}-linux-${node_arch}/bin/node ]]; then
  fetch "https://nodejs.org/dist/${NODE_VERSION}/${node_archive}" "$tmp_dir/$node_archive"
  fetch "https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt" "$tmp_dir/node-checksums"
  verify "$tmp_dir/$node_archive" "$tmp_dir/node-checksums"
  tar -xJf "$tmp_dir/$node_archive" -C "$install_root"
fi
for executable in node npm npx; do
  ln -sfn "$install_root/node-${NODE_VERSION}-linux-${node_arch}/bin/$executable" "$install_root/bin/$executable"
done

if ! $app_only; then
  sudo apt-get install -y bash-completion shellcheck pipx gh kubectx
  fetch "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${arch}/kubectl" "$tmp_dir/kubectl"
  fetch "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${arch}/kubectl.sha256" "$tmp_dir/kubectl.sha256"
  verify "$tmp_dir/kubectl" "$tmp_dir/kubectl.sha256"
  install_binary "$tmp_dir/kubectl" kubectl

  kind_asset="kind-linux-${arch}"
  fetch "https://github.com/kubernetes-sigs/kind/releases/download/${KIND_VERSION}/${kind_asset}" "$tmp_dir/$kind_asset"
  fetch "https://github.com/kubernetes-sigs/kind/releases/download/${KIND_VERSION}/${kind_asset}.sha256sum" "$tmp_dir/kind-checksums"
  verify "$tmp_dir/$kind_asset" "$tmp_dir/kind-checksums"
  install_binary "$tmp_dir/$kind_asset" kind

  helm_asset="helm-${HELM_VERSION}-linux-${arch}.tar.gz"
  fetch "https://get.helm.sh/${helm_asset}" "$tmp_dir/$helm_asset"
  fetch "https://get.helm.sh/${helm_asset}.sha256sum" "$tmp_dir/helm-checksums"
  verify "$tmp_dir/$helm_asset" "$tmp_dir/helm-checksums"
  tar -xzf "$tmp_dir/$helm_asset" -C "$tmp_dir" "linux-${arch}/helm"
  install_binary "$tmp_dir/linux-${arch}/helm" helm

  k9s_asset="k9s_Linux_${arch}.tar.gz"
  fetch "https://github.com/derailed/k9s/releases/download/${K9S_VERSION}/${k9s_asset}" "$tmp_dir/$k9s_asset"
  fetch "https://github.com/derailed/k9s/releases/download/${K9S_VERSION}/checksums.sha256" "$tmp_dir/k9s-checksums"
  verify "$tmp_dir/$k9s_asset" "$tmp_dir/k9s-checksums"
  tar -xzf "$tmp_dir/$k9s_asset" -C "$tmp_dir" k9s
  install_binary "$tmp_dir/k9s" k9s

  tf_asset="terraform_${TERRAFORM_VERSION}_linux_${arch}.zip"
  fetch "https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/${tf_asset}" "$tmp_dir/$tf_asset"
  fetch "https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_SHA256SUMS" "$tmp_dir/tf-checksums"
  verify "$tmp_dir/$tf_asset" "$tmp_dir/tf-checksums"
  unzip -q "$tmp_dir/$tf_asset" terraform -d "$tmp_dir"
  install_binary "$tmp_dir/terraform" terraform
fi

if $docker_engine; then
  if command -v docker >/dev/null 2>&1; then
    echo 'Docker já encontrado. Mantendo a instalação existente.'
  else
    [[ $(ps -p 1 -o comm=) == systemd ]] || {
      echo 'Habilite systemd no WSL seguindo docs/WSL.md e execute novamente.' >&2; exit 1;
    }
    sudo apt-get install -y docker.io docker-compose-v2
    sudo systemctl enable --now docker
    sudo usermod -aG docker "$(id -un)"
    echo 'Docker instalado. O grupo docker concede acesso privilegiado. Feche e reabra o WSL para ativá-lo.'
  fi
fi

# Dedicated PATH file: repeat runs do not duplicate lines or replace existing shell configuration.
cat > "$install_root/env.sh" <<'ENV'
case ":$PATH:" in
  *":$HOME/.local/share/danylo-labs/bin:"*) ;;
  *) export PATH="$HOME/.local/share/danylo-labs/bin:$PATH" ;;
esac
ENV
# The variable must expand when the user's shell loads this line.
# shellcheck disable=SC2016
source_line='[ ! -f "$HOME/.local/share/danylo-labs/env.sh" ] || . "$HOME/.local/share/danylo-labs/env.sh"'
for profile in "$HOME/.profile" "$HOME/.bashrc"; do
  touch "$profile"
  grep -Fqx "$source_line" "$profile" || printf '\n%s\n' "$source_line" >> "$profile"
done
if [[ -f $HOME/.zshrc ]]; then
  grep -Fqx "$source_line" "$HOME/.zshrc" || printf '\n%s\n' "$source_line" >> "$HOME/.zshrc"
fi
{
  date -u '+Instalado em: %Y-%m-%dT%H:%M:%SZ'
  node --version
  npm --version
  if ! $app_only; then
    kubectl version --client
    kind version
    helm version --short
    k9s version --short
    terraform version
  fi
} | tee "$install_root/versions.txt"
cat <<'DONE'

Instalação concluída. No terminal atual, execute:
  source "$HOME/.local/share/danylo-labs/env.sh"
Depois, na pasta do projeto:
  npm ci
  npm run dev
Abra http://localhost:8080/labs
Para verificar as ferramentas: bash scripts/check-local.sh
Para criar o cluster: bash scripts/lab-cluster.sh create
DONE
if ! $app_only && ! docker info >/dev/null 2>&1; then
  echo 'Docker ainda não está acessível. Ative a integração WSL no Docker Desktop ou siga docs/WSL.md.'
fi
