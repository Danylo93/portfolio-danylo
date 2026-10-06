import { registerTool } from "../registry";
import type { Shell } from "../shell";

export const FUNCTION_ARN = "arn:aws:lambda:us-east-1:123456789012:function:hello";
export const API_HOST = "lab123.execute-api.us-east-1.amazonaws.com";
export const SOURCE_ARN = "arn:aws:execute-api:us-east-1:123456789012:lab123/*/*";
export const awsState = (sh: Shell) => sh.ext("aws-serverless", () => ({
  memory: 128, timeout: 3, invoked: false, api: false, permission: false, tested: false,
}));

registerTool({
  name: "aws",
  summary: "AWS CLI simulada: Lambda e API Gateway HTTP",
  subcommands: { lambda: "configura e invoca funções", apigatewayv2: "cria e consulta HTTP APIs" },
  valueFlags: ["--function-name", "--memory-size", "--timeout", "--payload", "--cli-binary-format", "--name", "--protocol-type", "--target", "--api-id", "--statement-id", "--action", "--principal", "--source-arn", "--region"],
  run: ({ sh, pos, flags }) => {
    const [service, action, output] = pos;
    const st = awsState(sh);
    if (flags.region && flags.region !== "us-east-1") return "Error: this simulated lab uses us-east-1";
    if (service === "lambda") {
      if (!["hello", FUNCTION_ARN].includes(String(flags["function-name"]))) return "Error: ResourceNotFoundException: Function not found";
      if (action === "get-function-configuration") return JSON.stringify({ FunctionName: "hello", FunctionArn: FUNCTION_ARN, MemorySize: st.memory, Timeout: st.timeout, State: "Active" }, null, 2);
      if (action === "update-function-configuration") {
        const memory = flags["memory-size"] === undefined ? st.memory : Number(flags["memory-size"]);
        const timeout = flags.timeout === undefined ? st.timeout : Number(flags.timeout);
        if (!Number.isInteger(memory) || memory < 128 || memory > 10240 || !Number.isInteger(timeout) || timeout < 1 || timeout > 900) return "Error: InvalidParameterValueException: invalid memory or timeout";
        st.memory = memory; st.timeout = timeout;
        return JSON.stringify({ FunctionName: "hello", MemorySize: memory, Timeout: timeout, LastUpdateStatus: "Successful" }, null, 2);
      }
      if (action === "invoke") {
        if (!output) return "Error: outfile is required";
        if (flags["cli-binary-format"] !== "raw-in-base64-out") return "Error: use --cli-binary-format raw-in-base64-out in this lab";
        let event: { name?: string };
        try { event = JSON.parse(String(flags.payload ?? "{}")); } catch { return "Error: InvalidRequestContentException: invalid JSON payload"; }
        if (!event || typeof event !== "object") return "Error: payload must be a JSON object";
        sh.writeFile(output, JSON.stringify({ statusCode: 200, body: JSON.stringify({ message: `Olá, ${event.name ?? "mundo"}!` }) }));
        st.invoked = true;
        return '{"StatusCode":200,"ExecutedVersion":"$LATEST"}';
      }
      if (action === "add-permission") {
        if (flags.principal !== "apigateway.amazonaws.com" || flags.action !== "lambda:InvokeFunction" || flags["source-arn"] !== SOURCE_ARN || !flags["statement-id"]) return "Error: grant lambda:InvokeFunction to apigateway.amazonaws.com scoped to the lab API source ARN";
        st.permission = true;
        return JSON.stringify({ Statement: JSON.stringify({ Effect: "Allow", Principal: { Service: flags.principal }, Action: flags.action, Resource: FUNCTION_ARN, Condition: { ArnLike: { "AWS:SourceArn": SOURCE_ARN } } }) });
      }
    }
    if (service === "apigatewayv2") {
      if (action === "create-api") {
        if (!flags.name || flags["protocol-type"] !== "HTTP" || flags.target !== FUNCTION_ARN) return "Error: provide --name, --protocol-type HTTP and --target with the hello function ARN";
        if (st.api) return "Error: the simulated lab API already exists; use get-api";
        st.api = true;
        return JSON.stringify({ ApiId: "lab123", Name: flags.name, ProtocolType: "HTTP", ApiEndpoint: `https://${API_HOST}` }, null, 2);
      }
      if (action === "get-api") {
        if (!st.api || flags["api-id"] !== "lab123") return "Error: NotFoundException: API not found";
        return JSON.stringify({ ApiId: "lab123", ProtocolType: "HTTP", ApiEndpoint: `https://${API_HOST}` }, null, 2);
      }
    }
    return `Error: unsupported simulated AWS command: ${service} ${action}`;
  },
  http: ({ host }, sh) => {
    if (host !== API_HOST) return null;
    const st = awsState(sh);
    if (!st.api) return "curl: (6) Could not resolve host";
    if (!st.permission) return '{"message":"Internal Server Error"}';
    st.tested = true;
    return '{"message":"Olá, mundo!"}';
  },
});
