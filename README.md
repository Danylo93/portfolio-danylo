# Danylo Labs + Portfólio

Plataforma de aprendizado DevOps em React, TypeScript e Vite: lições, quizzes, laboratórios guiados, desafios e mentor com dicas progressivas. Trilhas de Kubernetes, CKA, CKAD, Docker, Terraform, CI/CD e DevSecOps, inspiradas na prática interativa de plataformas como LabEx e KodeKloud.

- `/`: portfólio profissional.
- `/labs`: catálogo, busca, trilhas e progresso.
- `/labs/learn/:id`: lições e quizzes.
- `/labs/:id`: terminal e exercícios com validação.

O terminal é um **simulador local no navegador**, sem acesso ao sistema operacional, cluster real ou conta AWS. Não requer backend ou credenciais. O progresso é salvo no navegador, com exportação/importação de backup JSON. O estado do terminal e os passos de uma tentativa são reiniciados ao sair/recarregar; conclusões já salvas permanecem.

## Rodar localmente

Requisito: Node.js 22+ e npm. No WSL2, siga o [guia completo](docs/WSL.md) ou execute o instalador dentro do Ubuntu:

```bash
bash scripts/install-wsl.sh
source "$HOME/.local/share/danylo-labs/env.sh"
npm ci
npm run dev
```

Abra **http://localhost:8080/labs**. Para instalar somente o necessário para o site, use `bash scripts/install-wsl.sh --app-only`.

## Ambiente real de Kubernetes

O instalador completo adiciona kubectl, Kind, Helm, **K9s**, Terraform, GitHub CLI e utilitários. Ative a integração WSL do Docker Desktop ou use `--docker-engine` conforme o guia.

```bash
bash scripts/check-local.sh
bash scripts/lab-cluster.sh create
k9s --context kind-danylo-lab
```

Um nó por padrão; `create --multinode` cria três nós se o cluster ainda não existir. O ambiente real é separado do simulador.

## Verificação e desenvolvimento

```bash
npm test
npm run typecheck
npm run lint
npm run build
npm run preview -- --host 127.0.0.1
bash -n scripts/*.sh
shellcheck scripts/*.sh
```

Use npm e `package-lock.json` como referência para instalações reproduzíveis. Consulte [AUTHORING.md](src/labs/AUTHORING.md) para criar novos labs. A CI executa testes, TypeScript, lint, build e validação dos scripts.

## Deploy

Vercel: build `npm run build`, saída `dist`; `vercel.json` configura o fallback das rotas SPA. O build não instala nem inicia Kubernetes.
