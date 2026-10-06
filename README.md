# Danylo Labs + Portfólio

Plataforma de aprendizado DevOps em React, TypeScript e Vite: lições, quizzes, laboratórios guiados, desafios e mentor com dicas progressivas. Trilhas de Kubernetes, CKA, CKAD, Docker, Terraform, CI/CD e DevSecOps, inspiradas na prática interativa de plataformas como LabEx e KodeKloud.

- `/`: portfólio profissional.
- `/labs`: catálogo, busca, trilhas e progresso.
- `/labs/learn/:id`: lições e quizzes.
- `/labs/:id`: terminal e exercícios com validação.
- `/labs/exams`: simulados AWS Cloud Practitioner (CLF-C02) e AI Practitioner (AIF-C01).

Os simulados de certificação têm 65 questões autorais e 90 minutos cada, com escolha única e múltiplas respostas. AI Practitioner também inclui ordenação e associação. É possível marcar questões, navegar e revisar respostas antes de entregar. O prazo continua ao sair; a tentativa e o resultado são salvos neste navegador. O gabarito comentado e o desempenho por domínio aparecem após a entrega, inclusive quando o tempo acaba.

Todas as questões são pontuadas no treino, com meta didática de 70% de acertos. Essa porcentagem não equivale à nota escalonada oficial, e o projeto não emite certificação. O conteúdo segue os domínios dos guias oficiais [CLF-C02](https://docs.aws.amazon.com/aws-certification/latest/cloud-practitioner-02/cloud-practitioner-02.html) e [AIF-C01](https://docs.aws.amazon.com/aws-certification/latest/ai-practitioner-01/ai-practitioner-01.html), revisados em 06/10/2026.

O modo padrão é um **simulador local no navegador**, sem acesso ao sistema operacional, cluster real ou conta AWS. O progresso do simulador é salvo no navegador, com exportação/importação de backup JSON.

O `localStorage` também preserva o estado de cada lab simulado (arquivos, recursos, ferramentas, comandos, etapa, dicas e tempo), o histórico e os rascunhos do terminal, as respostas das lições, as preferências do catálogo e as tentativas dos simulados AWS. Atualizar ou reabrir a página retoma os dados neste mesmo navegador e origem. Reiniciar um lab limpa somente sua tentativa, mantendo os itens concluídos. O tempo dos labs conta enquanto a página está ativa; o prazo das provas continua ao sair. O backup de progresso exporta os itens concluídos, não os ambientes completos.

Nos labs reais, o `localStorage` guarda a referência da sessão e o terminal. O servidor valida a sessão ao retomar; os recursos permanecem no Kind e não são armazenados no navegador. Se o servidor perder a sessão, é necessário iniciar outra tentativa. Armazenamento bloqueado ou sem espaço gera um aviso sem impedir a prática.

O **modo real local** conecta os sete labs de Kubernetes Fundamentos ao cluster Kind do WSL. O terminal executa kubectl e o botão Verificar consulta o estado real dos recursos. As outras trilhas continuam simuladas.

```bash
cd ~/portfolio-danylo
source ~/.local/share/danylo-labs/env.sh
bash scripts/lab-cluster.sh create
npm run dev:real
```

Abra **http://localhost:8080/labs** e clique em **Começar no cluster real**. Cada tentativa cria um namespace separado; use **Encerrar e limpar** para removê-lo ao terminar. O servidor só escuta na interface local. Consulte [o funcionamento e os limites do modo real](docs/REAL-LABS.md).

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
