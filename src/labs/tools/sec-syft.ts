// syft: generates an SBOM (software bill of materials) for an image or a directory.
import { registerTool } from "../registry";
import type { Shell } from "../shell";
import { digestOf, hashHex, imageInfo, parseRef, walkFiles } from "./sec-common";

type Pkg = { name: string; version: string; type: string; purl: string };

const ALPINE_BASE: [string, string][] = [
  ["alpine-baselayout", "3.6.5-r0"], ["alpine-keys", "2.4-r1"], ["apk-tools", "2.14.4-r1"], ["busybox", "1.36.1-r29"], ["ca-certificates-bundle", "20240705-r0"],
  ["libcrypto3", "3.3.2-r0"], ["libssl3", "3.3.2-r0"], ["musl", "1.2.5-r0"], ["musl-utils", "1.2.5-r0"], ["zlib", "1.3.1-r1"], ["libgcc", "13.2.1_git20240309-r0"], ["libstdc++", "13.2.1_git20240309-r0"],
];
const DEBIAN_BASE: [string, string][] = [["base-files", "12.4+deb12u7"], ["bash", "5.2.15-2+b7"], ["coreutils", "9.1-1"], ["libc6", "2.36-9+deb12u4"], ["libssl3", "3.0.14-1~deb12u2"], ["zlib1g", "1:1.2.13.dfsg-1"], ["apt", "2.6.1"], ["tar", "1.34+dfsg-1.2+deb12u1"]];
const APP_NPM: [string, string][] = [["express", "4.21.0"], ["pino", "9.4.0"], ["pg", "8.13.0"], ["jsonwebtoken", "9.0.2"], ["zod", "3.23.8"]];

/** Packages of an image (OS + language), deterministic. */
export const imagePackages = (ref: string): Pkg[] | null => {
  const info = imageInfo(ref);
  if (!info) return null;
  const distro = info.os.replace(" ", "-");
  const osType = info.family === "alpine" ? "apk" : "deb";
  const os = new Map<string, string>(info.family === "alpine" ? ALPINE_BASE : DEBIAN_BASE);
  for (const v of info.vulns) os.set(v.pkg, v.installed);
  const pkgs: Pkg[] = [...os].map(([name, version]) => ({ name, version, type: osType, purl: `pkg:${osType}/${info.family}/${name}@${encodeURIComponent(version)}?distro=${distro}` }));
  const r = parseRef(ref);
  const npm: [string, string][] = [...(info.lang ?? []).flatMap((l) => l.vulns.map((v) => [v.pkg, v.installed] as [string, string])), ...(/danylo\/api/.test(r.repo) ? APP_NPM : [])];
  for (const [name, version] of npm) pkgs.push({ name, version, type: "npm", purl: `pkg:npm/${name}@${version}` });
  return pkgs.sort((a, b) => a.name.localeCompare(b.name));
};

const dirPackages = (sh: Shell, dir: string): Pkg[] => {
  const out: Pkg[] = [];
  for (const f of walkFiles(sh, dir)) {
    const c = sh.state.files[f] ?? "";
    if (f.endsWith("/package-lock.json"))
      try {
        const j = JSON.parse(c);
        for (const [k, v] of Object.entries<{ version?: string }>(j.packages ?? {})) if (k && v.version) out.push({ name: k.split("node_modules/").pop()!, version: v.version, type: "npm", purl: `pkg:npm/${k.split("node_modules/").pop()}@${v.version}` });
      } catch {
        /* ignore */
      }
    if (f.endsWith("/requirements.txt"))
      for (const m of c.matchAll(/^([A-Za-z0-9_.-]+)==([\w.]+)/gm)) out.push({ name: m[1].toLowerCase(), version: m[2], type: "python", purl: `pkg:pypi/${m[1].toLowerCase()}@${m[2]}` });
  }
  return out;
};

const render = (fmt: string, source: string, pkgs: Pkg[], isImage: boolean) => {
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  if (fmt === "spdx-json")
    return JSON.stringify(
      {
        spdxVersion: "SPDX-2.3",
        dataLicense: "CC0-1.0",
        SPDXID: "SPDXRef-DOCUMENT",
        name: source,
        documentNamespace: `https://anchore.com/syft/${isImage ? "image" : "dir"}/${source.replace(/[:/]/g, "-")}-${hashHex(source, 8)}`,
        creationInfo: { licenseListVersion: "3.25", creators: ["Organization: Anchore, Inc", "Tool: syft-1.14.0"], created: now },
        packages: pkgs.map((p) => ({ name: p.name, SPDXID: `SPDXRef-Package-${p.type}-${p.name}-${hashHex(p.purl, 16)}`, versionInfo: p.version, supplier: "NOASSERTION", downloadLocation: "NOASSERTION", filesAnalyzed: false, externalRefs: [{ referenceCategory: "PACKAGE-MANAGER", referenceType: "purl", referenceLocator: p.purl }] })),
        relationships: pkgs.map((p) => ({ spdxElementId: "SPDXRef-DOCUMENT", relatedSpdxElement: `SPDXRef-Package-${p.type}-${p.name}-${hashHex(p.purl, 16)}`, relationshipType: "DESCRIBES" })),
      },
      null,
      2,
    );
  if (fmt === "cyclonedx-json")
    return JSON.stringify(
      {
        bomFormat: "CycloneDX",
        specVersion: "1.6",
        serialNumber: `urn:uuid:${hashHex(source, 8)}-${hashHex(source, 4)}-4${hashHex(source, 3)}-8${hashHex(source, 3)}-${hashHex(source, 12)}`,
        version: 1,
        metadata: { timestamp: now, tools: { components: [{ type: "application", author: "anchore", name: "syft", version: "1.14.0" }] }, component: { type: isImage ? "container" : "file", name: source } },
        components: pkgs.map((p) => ({ type: "library", name: p.name, version: p.version, purl: p.purl })),
      },
      null,
      2,
    );
  if (fmt === "json") return JSON.stringify({ artifacts: pkgs.map((p) => ({ name: p.name, version: p.version, type: p.type, purl: p.purl })), source: { type: isImage ? "image" : "directory", target: source }, descriptor: { name: "syft", version: "1.14.0" } }, null, 2);
  const w = [Math.max(4, ...pkgs.map((p) => p.name.length)), Math.max(7, ...pkgs.map((p) => p.version.length))];
  return [`${"NAME".padEnd(w[0])}  ${"VERSION".padEnd(w[1])}  TYPE`, ...pkgs.map((p) => `${p.name.padEnd(w[0])}  ${p.version.padEnd(w[1])}  ${p.type}`)].join("\n");
};

registerTool({
  name: "syft",
  summary: "gera o SBOM (lista de todos os pacotes) de uma imagem ou diretório",
  subcommands: { scan: "gera o SBOM de uma fonte (imagem, dir:.)", packages: "o mesmo que scan (legado)", version: "mostra a versão" },
  flags: {
    "-o": "formato: table (padrão), json, spdx-json, cyclonedx-json. Aceita formato=arquivo",
    "--output": "o mesmo que -o",
    "-q": "silencioso (sem barra de progresso)",
  },
  valueFlags: ["-o", "--output", "--file", "--scope", "-s"],
  run: ({ sh, flags, pos }) => {
    let [first, second] = pos;
    if (!first || flags.h || flags.help) return "Generate a packaged-based Software Bill Of Materials (SBOM) from container images and filesystems\n\nUsage:\n  syft [SOURCE] [flags]\n  syft [command]\n\nExamples:\n  syft alpine:latest -o spdx-json\n  syft dir:path/to/yourproject";
    if (first === "version") return "Application:   syft\nVersion:       1.14.0\nBuildDate:     2024-10-03T15:44:10Z";
    if (first === "scan" || first === "packages") [first, second] = [second, undefined];
    void second;
    if (!first) return { output: "an image/directory argument is required", ok: false };
    const rawOut = String(flags.o ?? flags.output ?? "table");
    const [fmt, fileOut] = rawOut.split("=");
    if (!["table", "json", "spdx-json", "cyclonedx-json"].includes(fmt)) return { output: `1 error occurred:\n\t* bad --output value '${fmt}': unsupported output format "${fmt}", supported formats are: [cyclonedx-json cyclonedx-xml github-json json spdx-json spdx-tag-value syft-table table template]`, ok: false };
    const isDir = first.startsWith("dir:") || first === "." || (sh.isDir(first) && !imageInfo(first));
    let pkgs: Pkg[] | null;
    let source = first;
    if (isDir) {
      source = first.replace(/^dir:/, "");
      if (!sh.isDir(source)) return { output: `1 error occurred:\n\t* could not determine source: directory ${source} does not exist`, ok: false };
      pkgs = dirPackages(sh, source);
    } else {
      source = first.replace(/^(registry|docker):/, "");
      pkgs = imagePackages(source);
      if (!pkgs) return { output: `1 error occurred:\n\t* could not determine source: errors occurred attempting to resolve '${source}':\n  - docker: pull failed: Error response from daemon: manifest for ${source} not found: manifest unknown\n  - registry: unable to get image: GET https://index.docker.io/v2/: MANIFEST_UNKNOWN`, ok: false };
    }
    const report = render(fmt, source, pkgs, !isDir);
    sh.flags.add(`syft:${source}`);
    const quietProgress = fmt !== "table" || flags.q;
    const progress = quietProgress
      ? ""
      : isDir
        ? ` ✔ Indexed file system                                                          ${source}\n ✔ Cataloged contents                          ${hashHex(source, 40)}\n   ├── ✔ Packages                        [${pkgs.length} packages]\n   └── ✔ Executables                     [0 executables]\n`
        : ` ✔ Loaded image                                                   ${source}\n ✔ Parsed image                    ${digestOf(`${source}#config`)}\n ✔ Cataloged contents                          ${hashHex(source, 40)}\n   ├── ✔ Packages                        [${pkgs.length} packages]\n   ├── ✔ File digests                    [${pkgs.length * 11} files]\n   └── ✔ Executables                     [${pkgs.length * 3} executables]\n`;
    if (fileOut) {
      sh.writeFile(fileOut, report);
      return progress.trimEnd();
    }
    return progress + report;
  },
  explainError: (cmd, output) => {
    if (/unsupported output format/.test(output)) return "Formatos úteis: -o spdx-json ou -o cyclonedx-json (padrões de SBOM aceitos por trivy, Dependency-Track e cosign attest).";
    if (/could not determine source/.test(output)) return "O syft não achou essa imagem/diretório. Confira o nome exato da imagem (ex.: ghcr.io/danylo/api:1.4.0) ou use dir:. para o projeto local.";
    return null;
  },
});
