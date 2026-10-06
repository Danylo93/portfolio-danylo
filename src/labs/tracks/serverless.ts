import type { Lab, Step, Track } from "../types";
import { API_HOST, FUNCTION_ARN, SOURCE_ARN, awsState } from "../tools/aws";

export const track: Track = {
  id: "serverless", title: "AWS Serverless", icon: "☁️", color: "#fb923c",
  desc: "Lambda e API Gateway: configuração, invocação e integração HTTP em ambiente simulado.",
};

const step = (title: string, body: string, code: string[], explain: string, check: Step["check"]): Step => ({
  title, body: [body], code, hints: [body, code.join(" && ")], explain: [explain], check,
});

export const labs: Lab[] = [
  {
    id: "serverless-lambda", track: track.id, kind: "lab", title: "AWS Lambda: configurar e invocar uma função",
    summary: "Inspecione uma função, ajuste memória e timeout e valide a resposta de uma invocação.",
    level: "Iniciante", minutes: 12, skills: ["AWS Lambda", "AWS CLI", "timeout", "memory sizing"],
    intro: "Este lab simula AWS CLI, sem conta AWS ou cobrança. A função hello e sua execution role já estão provisionadas. O handler recebe name e retorna statusCode e body. Vamos operar essa função e inspecionar sua resposta.",
    steps: [
      step("Inspecionar a função", "Consulte a configuração da função hello e observe memória e timeout.",
        ["aws lambda get-function-configuration --function-name hello"],
        "A execution role autoriza o código a acessar serviços AWS. Memória e timeout são configurações da função; aumentar memória também amplia a capacidade de CPU disponível.",
        (sh) => sh.ran(/^aws lambda get-function-configuration --function-name hello$/)),
      step("Ajustar recursos", "Configure 256 MB de memória e timeout de 10 segundos.",
        ["aws lambda update-function-configuration --function-name hello --memory-size 256 --timeout 10"],
        "A função agora tem 256 MB e até 10 segundos por execução. Em produção, meça duração e consumo antes de definir os valores.",
        (sh) => awsState(sh).memory === 256 && awsState(sh).timeout === 10),
      step("Invocar e ler a resposta", "Envie um evento JSON e leia response.json. A CLI grava a resposta no arquivo indicado.",
        ["aws lambda invoke --function-name hello --cli-binary-format raw-in-base64-out --payload '{\"name\":\"Danylo\"}' response.json", "cat response.json"],
        "StatusCode 200 da CLI indica que a invocação foi aceita. Inspecione também o payload e FunctionError ao diagnosticar falhas em uma função real.",
        (sh) => awsState(sh).invoked && (sh.readFile("response.json") ?? "").includes("Olá, Danylo!") && sh.ran(/^cat response.json$/)),
    ],
    outro: "Você configurou e invocou uma Lambda. O próximo lab publica uma integração HTTP com API Gateway.",
  },
  {
    id: "serverless-api-gateway", track: track.id, kind: "lab", title: "API Gateway: publicar uma HTTP API com Lambda",
    summary: "Crie a API, autorize a invocação da Lambda e teste o endpoint HTTP.",
    level: "Intermediário", minutes: 15, skills: ["API Gateway", "HTTP API", "Lambda permissions", "curl"],
    intro: "Ambiente simulado: a Lambda hello já existe. Use quick create para criar uma HTTP API com integração Lambda, rota $default e stage $default com implantação automática. O identificador didático será lab123. Na AWS, copie o identificador retornado pela CLI. Este exercício usa uma API pública; avalie autorização antes de expor dados reais.",
    steps: [
      step("Criar a HTTP API", "Crie a API hello-api usando o ARN da Lambda como target.",
        [`aws apigatewayv2 create-api --name hello-api --protocol-type HTTP --target ${FUNCTION_ARN}`],
        "Quick create configura integração, rota padrão e stage automaticamente. Isso difere de criar uma REST API com recursos e métodos separados.",
        (sh) => awsState(sh).api),
      step("Autorizar a integração", "Adicione uma resource policy à função: API Gateway poderá invocar hello somente a partir da API deste lab.",
        [`aws lambda add-permission --function-name hello --statement-id api-gateway --action lambda:InvokeFunction --principal apigateway.amazonaws.com --source-arn ${SOURCE_ARN}`],
        "A permissão de entrada pertence à resource policy da Lambda. Ela tem uma função diferente da execution role, usada pelo código para acessar outros serviços.",
        (sh) => awsState(sh).permission),
      step("Consultar e testar o endpoint", "Consulte o endpoint da API e faça uma requisição HTTP.",
        ["aws apigatewayv2 get-api --api-id lab123", `curl https://${API_HOST}`],
        "O caminho é cliente → API Gateway → Lambda → resposta HTTP. Se a permissão estiver ausente, a integração retorna erro. Fora do simulador, exclua os recursos após praticar para evitar cobranças.",
        (sh) => awsState(sh).api && awsState(sh).permission && awsState(sh).tested && sh.ran(/^aws apigatewayv2 get-api --api-id lab123$/)),
    ],
    outro: "Você conectou uma HTTP API à Lambda e validou a permissão de invocação e o retorno HTTP.",
  },
];
