# Labs no cluster real do WSL

## Executar

Com Node.js 22+, npm, Docker, Kind e kubectl instalados:

```bash
cd ~/portfolio-danylo
source ~/.local/share/danylo-labs/env.sh
npm ci
bash scripts/lab-cluster.sh create
npm run dev:real
```

Abra **http://localhost:8080/labs**. Os dois modos usam a porta 8080; execute apenas um deles por vez. Se 8080 estiver ocupada, use `npm run dev:real -- --port 8083`.

Clique em **Começar no cluster real**, escolha um lab de Kubernetes Fundamentos e clique em **Iniciar lab real**. A preparação cria recursos no contexto `kind-danylo-lab`, em um namespace `dlab-…` exclusivo. Imagens podem demorar para baixar; consulte `kubectl get pods` e aguarde a prontidão antes de verificar.

## Exercícios disponíveis

Os sete labs de Kubernetes Fundamentos têm execução e validação reais:

- Explorar contexto, API e namespaces.
- Verificar nós, condições e versões reais.
- Criar um Pod nginx, esperar Ready e ler logs.
- Criar e escalar um Deployment, apagar um Pod e observar sua substituição.
- Criar um Service NodePort, consultar endpoints e testar HTTP com um Pod de diagnóstico.
- Corrigir a imagem inválida de um Deployment e validar seu rollout.
- Publicar uma imagem nova e fazer rollback.

Seeds são provisionadas pelo servidor: `web` com duas réplicas, `nginx` com imagem inválida ou `api` na versão anterior, conforme o lab. No exercício de Service, o teste usa `wget` dentro do Pod `probe`: o Kind não publica NodePorts automaticamente no localhost do WSL.

CKA, CKAD, Docker, Terraform, CI/CD e DevSecOps permanecem no simulador. O build publicado também permanece simulado; a ponte local não existe no deploy de produção.

## Terminal e limites

O terminal executa o binário kubectl do WSL, sem shell intermediário. Digite `help` para consultar os comandos aceitos. Suporta os comandos dos exercícios, incluindo get, describe, logs, run, create deployment, scale, expose, set image e rollout. Aceita o alias `k`.

O contexto e o namespace são fixos por tentativa. Não aceita troca de kubeconfig/servidor, namespaces externos, plugins, pipes, redirecionamentos, arquivos locais, exec, port-forward ou comandos interativos. Para operações avançadas e K9s, use o terminal WSL; a interface mostra o comando com o namespace correto:

```bash
k9s --context kind-danylo-lab -n <namespace-da-tentativa>
```

O servidor escuta em `127.0.0.1`, valida Host/Origin e exige token de sessão para POST. Não há CORS nem acesso remoto. Não exponha esse servidor por túnel ou proxy público: ele foi feito para uso pessoal local, não para hospedar usuários não confiáveis. O namespace tem quota de 12 Pods, 6 Services e 6 Deployments; containers recebem limites de 256 MiB e 500m de CPU. No terminal web, scale aceita de 1 a 5 réplicas.

Comandos têm timeout de 45 segundos e saída limitada a 1 MiB. Timeout interrompe o cliente kubectl; recursos já criados continuam no cluster. Consulte seu estado antes de repetir uma criação.

## Progresso e limpeza

Os passos validados são guardados no servidor local. A referência da tentativa, o histórico e a entrada do terminal ficam no `localStorage`, permitindo retomar ao reabrir a página no mesmo navegador e origem enquanto o servidor mantiver a sessão. A retomada consulta o servidor e não repete comandos Kubernetes. Uma falha temporária preserva a referência para reconexão. Não contam como conclusões do simulador. Fechar a página não apaga os recursos. **Encerrar e limpar** remove somente o namespace daquela tentativa, após confirmação, e apaga sua referência local.

Reiniciar o servidor perde o registro de tentativas, mas preserva os namespaces para inspeção. Para localizar recursos de tentativas antigas:

```bash
kubectl --context kind-danylo-lab get namespaces -l app.kubernetes.io/managed-by=danylo-labs
```

Após conferir o nome, remova somente a tentativa desejada:

```bash
kubectl --context kind-danylo-lab delete namespace <namespace-da-tentativa>
```

## Verificação de desenvolvimento

```bash
npm run typecheck
npm run lint
npm test -- --maxWorkers=2
npm run build
```

Com `npm run dev:real` ativo em outro terminal, o teste de integração abaixo resolve os sete labs usando recursos reais e remove seus próprios namespaces ao terminar:

```bash
node scripts/test-real-labs.mjs
```

Referências: [middleware de desenvolvimento do Vite](https://v5.vite.dev/guide/api-plugin.html#configureserver), [namespaces no Kubernetes](https://kubernetes.io/docs/tasks/administer-cluster/namespaces/).
