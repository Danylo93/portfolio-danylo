// Docker CLI plugin (images, containers, port mapping).
import { registerTool } from "../registry";
import type { Shell } from "../shell";
import type { DockerContainer as Container } from "../types";
import { age, hexId, parseFlags, table } from "../util";
import { validImage } from "../k8s/cluster";

const NGINX_HTML = `<!DOCTYPE html>
<html>
<head>
<title>Welcome to nginx!</title>
</head>
<body>
<h1>Welcome to nginx!</h1>
<p>If you see this page, the nginx web server is successfully installed and
working. Further configuration is required.</p>
</body>
</html>`;

export const dockerRun = (sh: Shell, args: string[]): string => {
    const { flags, pos } = parseFlags(args, ["--name", "-p", "-e", "-v", "--network", "-t", "-w"]);
    const [sub, ...rest] = pos;
    const norm = (i: string) => (i.includes(":") ? i : `${i}:latest`);
    const pull = (img: string) => {
      if (!validImage(img)) throw new Error(`Error response from daemon: pull access denied for ${img.split(":")[0]}, repository does not exist or may require 'docker login'`);
      const tag = norm(img);
      if (!sh.state.images.includes(tag)) sh.state.images.push(tag);
      return tag;
    };
    switch (sub) {
      case "version":
      case "--version":
        return "Docker version 27.1.1, build 6312585";
      case "pull": {
        if (!rest[0]) return "\"docker pull\" requires exactly 1 argument.";
        const tag = pull(rest[0]);
        return `${tag.split(":")[1]}: Pulling from library/${tag.split(":")[0]}\nc6a83fedfae6: Pull complete\n2c3dc6e1b1c3: Pull complete\nDigest: sha256:${hexId()}${hexId()}\nStatus: Downloaded newer image for ${tag}\ndocker.io/library/${tag}`;
      }
      case "images":
        return table([["REPOSITORY", "TAG", "IMAGE ID", "CREATED", "SIZE"], ...sh.state.images.map((i) => {
          const [r, t] = i.split(":");
          return [r, t, hexId(), "2 weeks ago", r === "nginx" && t.includes("alpine") ? "47.9MB" : "188MB"];
        })]);
      case "run": {
        const image = rest[0];
        if (!image) return "\"docker run\" requires at least 1 argument.";
        const note = sh.state.images.includes(norm(image)) ? "" : `Unable to find image '${norm(image)}' locally\n`;
        pull(image);
        const name = typeof flags.name === "string" ? flags.name : `${["brave", "eager", "quirky"][Math.floor(Math.random() * 3)]}_${["turing", "hopper", "lovelace"][Math.floor(Math.random() * 3)]}`;
        if (sh.state.containers.some((c) => c.name === name)) return `docker: Error response from daemon: Conflict. The container name "/${name}" is already in use.`;
        let ports: Container["ports"];
        if (typeof flags.p === "string") {
          const [h, c] = flags.p.split(":").map(Number);
          if (sh.state.containers.some((x) => x.status === "running" && x.ports?.host === h)) return `docker: Error response from daemon: Bind for 0.0.0.0:${h} failed: port is already allocated.`;
          ports = { host: h, container: c };
        }
        const id = hexId() + hexId();
        sh.state.containers.push({ id, name, image: norm(image), ports, status: "running", createdAt: Date.now() });
        return note + id + hexId().slice(0, 4);
      }
      case "ps": {
        const list = sh.state.containers.filter((c) => flags.a || c.status === "running");
        return table([["CONTAINER ID", "IMAGE", "COMMAND", "CREATED", "STATUS", "PORTS", "NAMES"], ...list.map((c) => [
          c.id.slice(0, 12), c.image, "\"/docker-entrypoint.…\"", `${age(c.createdAt)} ago`,
          c.status === "running" ? `Up ${age(c.createdAt)}` : "Exited (0) 1s ago",
          c.ports && c.status === "running" ? `0.0.0.0:${c.ports.host}->${c.ports.container}/tcp` : "", c.name,
        ])]);
      }
      case "stop":
      case "rm": {
        const c = sh.state.containers.find((x) => x.name === rest[0] || x.id.startsWith(rest[0] ?? "-"));
        if (!c) return `Error response from daemon: No such container: ${rest[0]}`;
        if (sub === "stop") c.status = "exited";
        else {
          if (c.status === "running" && !flags.f) return `Error response from daemon: cannot remove container "/${c.name}": container is running: stop the container before removing or force remove`;
          sh.state.containers = sh.state.containers.filter((x) => x !== c);
        }
        return rest[0];
      }
      case "logs": {
        const c = sh.state.containers.find((x) => x.name === rest[0] || x.id.startsWith(rest[0] ?? "-"));
        if (!c) return `Error response from daemon: No such container: ${rest[0]}`;
        return "/docker-entrypoint.sh: Configuration complete; ready for start up\n172.17.0.1 - - \"GET / HTTP/1.1\" 200 615 \"-\" \"curl/8.5.0\"";
      }
      default:
        return `docker: '${sub ?? ""}' is not a docker command.\nSee 'docker --help'`;
    }
};

registerTool({
  name: "docker",
  summary: "gerencia imagens e containers",
  subcommands: { pull: "baixa uma imagem do registry", images: "lista imagens locais", run: "cria e inicia um container", ps: "lista containers em execução", stop: "para um container", rm: "remove um container", logs: "mostra os logs de um container", version: "versão do Docker" },
  flags: { "-d": "detached — roda em background", "-p": "mapeia porta host:container", "--name": "nome do container", "-a": "inclui containers parados", "-f": "força a remoção" },
  valueFlags: ["--name", "-p", "-e", "-v", "--network", "-t"],
  run: ({ sh, args }) => dockerRun(sh, args),
  http: ({ host, port }, sh) => {
    const c = sh.state.containers.find((x) => x.status === "running" && x.ports?.host === port);
    if (!["localhost", "127.0.0.1"].includes(host) || !c) return null;
    sh.flags.add("curl-docker");
    return NGINX_HTML;
  },
});
