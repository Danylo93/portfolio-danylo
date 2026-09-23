#!/usr/bin/env bash
set -Eeuo pipefail
repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
name=danylo-lab
context=kind-danylo-lab
image='kindest/node:v1.35.8@sha256:07b2536e30b803ed61d1677a79df6115f798ce64c80f9e22f6ed45afd09323c0'
usage() { echo 'Uso: bash scripts/lab-cluster.sh create [--multinode] | status | delete --yes'; }
action=${1:---help}
case "$action" in
  --help|-h) usage; exit 0 ;;
  create|status|delete) ;;
  *) usage >&2; exit 2 ;;
esac
for tool in kind kubectl docker; do
  command -v "$tool" >/dev/null || { echo "Ferramenta ausente: $tool" >&2; exit 1; }
done
case "$action" in
  create)
    [[ $# -le 2 && ( $# -eq 1 || $2 == --multinode ) ]] || { usage >&2; exit 2; }
    docker info >/dev/null 2>&1 || { echo 'Docker indisponível. Consulte docs/WSL.md.' >&2; exit 1; }
    clusters=$(kind get clusters)
    if grep -Fxq "$name" <<< "$clusters"; then
      echo 'Cluster existente; mantendo seus dados e topologia.'
      kind export kubeconfig --name "$name"
    else
      config="$repo_dir/local/kind.yaml"
      [[ ${2:-} != --multinode ]] || config="$repo_dir/local/kind-multinode.yaml"
      kind create cluster --name "$name" --config "$config" --image "$image" --wait 180s
    fi
    kubectl --context "$context" wait --for=condition=Ready nodes --all --timeout=180s
    kubectl --context "$context" get nodes
    echo "Abra o painel: k9s --context $context"
    ;;
  status)
    [[ $# -eq 1 ]] || { usage >&2; exit 2; }
    kubectl --context "$context" get nodes --request-timeout=10s
    ;;
  delete)
    [[ $# -eq 2 && $2 == --yes ]] || { echo 'Para apagar somente o cluster local danylo-lab: bash scripts/lab-cluster.sh delete --yes' >&2; exit 2; }
    kind delete cluster --name "$name"
    ;;
esac
