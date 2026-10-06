import "../k8s/controlplane";
import "../k8s/kubectl";
import { CP_NODE, etcdState } from "../k8s/cluster";
import type { Lab } from "../types";

const TLS = "--endpoints=https://127.0.0.1:2379 --cacert=/etc/kubernetes/pki/etcd/ca.crt --cert=/etc/kubernetes/pki/etcd/server.crt --key=/etc/kubernetes/pki/etcd/server.key";

export const controlPlaneLab: Lab = {
  id: "k8s-control-plane", track: "kubernetes", kind: "lab", title: "Control Plane: componentes, saúde e backup",
  summary: "Inspecione os static pods, valide o etcd e salve um snapshot do estado do cluster.",
  level: "Intermediário", minutes: 15, skills: ["Control Plane", "static pods", "etcdctl", "etcd snapshot"],
  intro: "Neste ambiente simulado, kube-apiserver recebe requisições, etcd persiste o estado, scheduler atribui nós aos pods e controller-manager reconcilia recursos. Os componentes rodam como static pods gerenciados pelo kubelet. Vamos inspecionar o control plane e produzir um backup do etcd.",
  steps: [
    {
      title: "Identificar os componentes", body: ["Liste os pods de kube-system e identifique os componentes do control plane."],
      code: ["kubectl get pods -n kube-system"], hints: ["Os componentes ficam no namespace kube-system.", "kubectl get pods -n kube-system"],
      explain: ["API server, scheduler, controller-manager e etcd formam o control plane. CoreDNS e kube-proxy também aparecem em kube-system, mas têm outras responsabilidades."],
      check: (sh) => sh.ran(/^kubectl get pods -n kube-system$/),
    },
    {
      title: "Inspecionar os manifests", body: ["Entre no nó de control plane e leia o manifest do etcd. Observe os caminhos dos certificados e o volume de dados."],
      code: [`ssh ${CP_NODE}`, "cat /etc/kubernetes/manifests/etcd.yaml"],
      hints: ["Static pods são definidos em arquivos locais monitorados pelo kubelet.", `ssh ${CP_NODE} && cat /etc/kubernetes/manifests/etcd.yaml`],
      explain: ["O kubelet monitora /etc/kubernetes/manifests. Alterações nesses arquivos podem recriar os componentes; mantenha cópias de segurança fora desse diretório."],
      check: (sh) => sh.host === CP_NODE && sh.ran(/^cat \/etc\/kubernetes\/manifests\/etcd.yaml$/),
    },
    {
      title: "Validar a saúde do etcd", body: ["Consulte endpoint health usando TLS mútuo com os certificados do lab."],
      code: [`etcdctl ${TLS} endpoint health`], hints: ["O etcd exige CA, certificado cliente e chave para autenticação.", `etcdctl ${TLS} endpoint health`],
      explain: ["O health check confirma que o endpoint consegue confirmar uma proposta. Um processo ativo sozinho não garante que o armazenamento do cluster esteja saudável."],
      check: (sh) => sh.entries.some((e) => e.ok && e.cmd.startsWith("etcdctl ") && e.cmd.includes("endpoint health") && e.output.includes("is healthy")),
    },
    {
      title: "Salvar e verificar um snapshot", body: ["Salve o snapshot em /tmp/control-plane.db e inspecione seu status com etcdutl."],
      code: [`etcdctl ${TLS} snapshot save /tmp/control-plane.db`, "etcdutl snapshot status /tmp/control-plane.db -w table"],
      hints: ["Salvar o snapshot e verificar sua integridade são etapas distintas. Teste também a restauração em um ambiente separado em produção.", `etcdctl ${TLS} snapshot save /tmp/control-plane.db && etcdutl snapshot status /tmp/control-plane.db -w table`],
      explain: ["O snapshot protege o estado persistido no etcd. Ele não substitui backups dos volumes das aplicações nem dos certificados e configurações dos nós."],
      check: (sh) => Boolean(etcdState(sh).snapshots["/tmp/control-plane.db"]) && sh.entries.some((e) => e.ok && /^etcdutl snapshot status \/tmp\/control-plane.db/.test(e.cmd)),
    },
  ],
  outro: "Você identificou os componentes do control plane, validou o etcd e gerou um snapshot verificável.",
};
