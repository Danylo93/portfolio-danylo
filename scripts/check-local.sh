#!/usr/bin/env bash
set -uo pipefail
missing=0
for tool in node npm git kubectl kind helm k9s terraform docker; do
  if command -v "$tool" >/dev/null 2>&1; then
    printf 'OK    %-10s %s\n' "$tool" "$(command -v "$tool")"
  else
    printf 'FALTA %s\n' "$tool"
    missing=1
  fi
done
if command -v node >/dev/null 2>&1 && ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then
  echo 'Use Node.js 22 ou superior.'; missing=1
fi
if docker info >/dev/null 2>&1; then
  echo 'OK    Docker daemon acessível'
else
  echo 'FALTA Docker daemon: ative a integração WSL ou inicie o serviço Docker.'; missing=1
fi
if command -v kubectl >/dev/null 2>&1 && kubectl --context kind-danylo-lab get nodes --request-timeout=5s; then
  echo 'OK    Cluster danylo-lab acessível'
else
  echo 'INFO  Cluster opcional ainda não disponível: bash scripts/lab-cluster.sh create'
fi
exit "$missing"
