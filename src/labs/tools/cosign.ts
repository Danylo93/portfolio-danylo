// cosign: signs and verifies container images (Sigstore) with a local key pair.
import { registerTool } from "../registry";
import type { Shell } from "../shell";
import { digestOf, hashHex, imageInfo, parseRef } from "./sec-common";

type Sig = { keyId: string; ref: string };
type Att = { keyId: string; type: string; predicate: string };
export type CosignState = {
  /** keyId → password used to encrypt the private key */
  keys: Record<string, string>;
  /** image digest → signatures */
  sigs: Record<string, Sig[]>;
  atts: Record<string, Att[]>;
  verifies: { ref: string; ok: boolean; reason?: string }[];
};
export const cosignState = (sh: Shell) => sh.ext<CosignState>("sec:cosign", () => ({ keys: {}, sigs: {}, atts: {}, verifies: [] }));

const PRIV = "ENCRYPTED SIGSTORE PRIVATE KEY";
const keyIdOf = (content: string | undefined, kind: "priv" | "pub") => {
  if (!content) return null;
  const head = kind === "priv" ? `-----BEGIN ${PRIV}-----` : "-----BEGIN PUBLIC KEY-----";
  if (!content.includes(head)) return null;
  const m = /kid([0-9a-f]{24})/.exec(content);
  return m?.[1] ?? null;
};

/** True when `ref` has a signature made by the key in `pubPath`. */
export const isSignedBy = (sh: Shell, ref: string, pubPath: string) => {
  const kid = keyIdOf(sh.readFile(pubPath), "pub");
  return !!kid && (cosignState(sh).sigs[digestOf(ref)] ?? []).some((s) => s.keyId === kid);
};

const TERMS = `\n\tThe sigstore service, hosted by sigstore a Series of LF Projects, LLC, is provided pursuant to the Hosted Project Tools Terms of Use, available at https://lfprojects.org/policies/hosted-project-tools-terms-of-use/.\n\tNote that if your submission includes personal data associated with this signed artifact, it will be part of an immutable record.\n\tThis may include the email address associated with the account with which you authenticate your contractual Agreement.\n\tThis information will be used for signing this artifact and will be stored in public transparency logs and cannot be removed later, and is subject to the Transparency Log Terms of Use, available at https://lfprojects.org/policies/hosted-project-tools-terms-of-use/.\n\nBy typing 'y', you attest that (1) you are not submitting the personal data of any other person; and (2) you understand and agree to the statement and the Agreement terms at the URLs listed above.`;

const tagWarning = (ref: string) =>
  `WARNING: Image reference ${ref} uses a tag, not a digest, to identify the image to sign.\n    This can lead you to sign a different image than the intended one. Please use a\n    digest (example.com/ubuntu@sha256:abc123...) rather than tag\n    (example.com/ubuntu:latest) for the input to cosign. The ability to refer to\n    images by tag will be removed in a future release.\n`;

const fail = (msg: string) => ({ output: `Error: ${msg}\nmain.go:74: error during command execution: ${msg}`, ok: false });

registerTool({
  name: "cosign",
  summary: "assina e verifica imagens de container (Sigstore) — garante que o que roda é o que o CI construiu",
  subcommands: {
    "generate-key-pair": "gera cosign.key (privada, criptografada) e cosign.pub",
    sign: "assina uma imagem no registry",
    verify: "verifica a assinatura de uma imagem com a chave pública",
    attest: "anexa uma atestação assinada (ex.: SBOM) à imagem",
    "verify-attestation": "verifica uma atestação da imagem",
    triangulate: "mostra onde a assinatura fica guardada no registry",
    tree: "mostra assinaturas e atestações ligadas à imagem",
    version: "mostra a versão",
  },
  flags: {
    "--key": "caminho da chave (privada para sign/attest, pública para verify)",
    "--yes": "não pergunta confirmação (uso em CI)",
    "-y": "o mesmo que --yes",
    "--tlog-upload": "envia (ou não) a assinatura ao log de transparência Rekor",
    "--predicate": "arquivo com o conteúdo da atestação (ex.: sbom.json)",
    "--type": "tipo da atestação: spdxjson, cyclonedx, slsaprovenance, custom",
    "--output-key-prefix": "prefixo dos arquivos de chave gerados",
  },
  valueFlags: ["--key", "--predicate", "--type", "--output-key-prefix", "--tlog-upload", "-o", "--output"],
  run: ({ sh, flags, pos, env }) => {
    const [sub, image] = pos;
    const st = cosignState(sh);
    if (!sub || flags.h || flags.help)
      return "A tool for Container Signing, Verification and Storage in an OCI registry.\n\nUsage:\n  cosign [command]\n\nAvailable Commands:\n  attest              Attest the supplied container image.\n  generate-key-pair   Generates a key-pair.\n  sign                Sign the supplied container image.\n  tree                Display supply chain security related artifacts for an image\n  triangulate         Outputs the located cosign image reference.\n  verify              Verify a signature on the supplied container image\n  verify-attestation  Verify an attestation on the supplied container image\n  version             Prints the version";
    if (sub === "version") return "  ______   ______        _______. __    _______ .__   __.\n /      | /  __  \\      /       ||  |  /  _____||  \\ |  |\n|  ,----'|  |  |  |    |   (----`|  | |  |  __  |   \\|  |\n|  |     |  |  |  |     \\   \\    |  | |  | |_ | |  . `  |\n|  `----.|  `--'  | .----)   |   |  | |  |__| | |  |\\   |\n \\______| \\______/  |_______/    |__|  \\______| |__| \\__|\ncosign: A tool for Container Signing, Verification and Storage in an OCI registry.\n\nGitVersion:    v2.4.1";
    const password = env.COSIGN_PASSWORD ?? "";
    const prompt = env.COSIGN_PASSWORD === undefined ? "Enter password for private key: \n" : "";

    if (sub === "generate-key-pair") {
      const prefix = typeof flags["output-key-prefix"] === "string" ? String(flags["output-key-prefix"]) : "cosign";
      if (sh.readFile(`${prefix}.key`) !== undefined) return fail(`${prefix}.key already exists: remove it or choose another --output-key-prefix`);
      const kid = hashHex(`${Date.now()}-${Math.random()}`, 24);
      st.keys[kid] = password;
      const body = btoa(`scrypt:${kid}:${hashHex(kid + "priv", 48)}`);
      sh.writeFile(`${prefix}.key`, `-----BEGIN ${PRIV}-----\neyJrZGYiOnsibmFtZSI6InNjcnlwdCJ9LCJjaXBoZXIiOnsibmFtZSI6Im5hY2wvc2VjcmV0Ym94In19\n${body}\nkid${kid}\n-----END ${PRIV}-----\n`);
      sh.writeFile(`${prefix}.pub`, `-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE${btoa(hashHex(kid + "pub", 36))}\nkid${kid}\n-----END PUBLIC KEY-----\n`);
      return `${prompt ? prompt + "Enter password for private key again: \n" : ""}Private key written to ${prefix}.key\nPublic key written to ${prefix}.pub`;
    }

    if (sub === "triangulate" || sub === "tree") {
      if (!image) return fail("accepts 1 arg(s), received 0");
      if (!imageInfo(image)) return fail(`GET https://${parseRef(image).repo.split("/")[0]}/v2/: MANIFEST_UNKNOWN: manifest unknown`);
      const r = parseRef(image);
      const d = digestOf(image);
      if (sub === "triangulate") return `${r.repo}:${d.replace(":", "-")}.sig`;
      const sigs = st.sigs[d] ?? [];
      const atts = st.atts[d] ?? [];
      if (!sigs.length && !atts.length) return `📦 Supply Chain Security Related artifacts for an image: ${r.full}\nNo Supply Chain Security Related Artifacts artifacts found for image ${r.full}\n, start creating one with simply running$ cosign sign <img>`;
      return [
        `📦 Supply Chain Security Related artifacts for an image: ${r.full}`,
        ...(atts.length ? [`└── 💾 Attestations for an image tag: ${r.repo}:${d.replace(":", "-")}.att`, ...atts.map((a) => `   └── 🍒 sha256:${hashHex(a.keyId + a.type)}`)] : []),
        ...(sigs.length ? [`└── 🔐 Signatures for an image tag: ${r.repo}:${d.replace(":", "-")}.sig`, ...sigs.map((s) => `   └── 🍒 sha256:${hashHex(s.keyId + d)}`)] : []),
      ].join("\n");
    }

    if (sub === "sign" || sub === "attest") {
      if (!image) return fail("accepts 1 arg(s), received 0");
      const keyPath = typeof flags.key === "string" ? String(flags.key) : undefined;
      if (!keyPath) return fail("signing with keyless (OIDC) requires a browser; use --key cosign.key in this lab");
      const keyContent = sh.readFile(keyPath);
      if (keyContent === undefined) return fail(`signing ${image}: getting signer: reading key: open ${keyPath}: no such file or directory`);
      const kid = keyIdOf(keyContent, "priv");
      if (!kid) return fail(`signing ${image}: getting signer: reading key: ${keyContent.includes("PUBLIC KEY") ? "invalid pem block (did you pass the .pub instead of the .key?)" : "invalid pem block"}`);
      if ((st.keys[kid] ?? "") !== password) return fail(`signing ${image}: getting signer: reading key: decrypt: encrypted: decryption failed`);
      if (!imageInfo(image)) return fail(`signing [${image}]: accessing entity: GET https://${parseRef(image).repo.split("/")[0]}/v2/${parseRef(image).repo}/manifests/${parseRef(image).tag}: MANIFEST_UNKNOWN: manifest unknown`);
      const r = parseRef(image);
      const d = digestOf(image);
      const warn = r.digest ? "" : tagWarning(image);
      const tlog = flags["tlog-upload"] === "false" ? "" : `tlog entry created with index: ${parseInt(hashHex(d + kid, 7), 16) % 90000000 + 10000000}\n`;
      const terms = flags.yes || flags.y || flags["tlog-upload"] === "false" ? "" : `${TERMS}\nAre you sure you would like to continue? [y/N] y\n`;
      if (sub === "sign") {
        (st.sigs[d] ??= []).push({ keyId: kid, ref: r.full });
        sh.flags.add(`cosign:signed:${r.full}`);
        return `${prompt}${warn}${terms}${tlog}Pushing signature to: ${r.repo}`;
      }
      const predPath = typeof flags.predicate === "string" ? String(flags.predicate) : undefined;
      if (!predPath) return fail("required flag(s) \"predicate\" not set");
      const pred = sh.readFile(predPath);
      if (pred === undefined) return fail(`open ${predPath}: no such file or directory`);
      const type = String(flags.type ?? "custom");
      (st.atts[d] ??= []).push({ keyId: kid, type, predicate: pred });
      sh.flags.add(`cosign:attested:${r.full}`);
      return `${prompt}${warn}Using payload from: ${predPath}\n${terms}${tlog}`.trimEnd();
    }

    if (sub === "verify" || sub === "verify-attestation") {
      if (!image) return fail("accepts 1 arg(s), received 0");
      const keyPath = typeof flags.key === "string" ? String(flags.key) : undefined;
      if (!keyPath) return fail("--certificate-identity or --certificate-identity-regexp is required for verification in keyless mode (or pass --key cosign.pub)");
      const pubContent = sh.readFile(keyPath);
      if (pubContent === undefined) return fail(`loading public key: open ${keyPath}: no such file or directory`);
      const kid = keyIdOf(pubContent, "pub");
      if (!kid) return fail(`loading public key: ${pubContent.includes(PRIV) ? "PEM type is \"ENCRYPTED SIGSTORE PRIVATE KEY\", not a public key (use the .pub file)" : "invalid public key"}`);
      if (!imageInfo(image)) return fail(`GET https://${parseRef(image).repo.split("/")[0]}/v2/${parseRef(image).repo}/manifests/${parseRef(image).tag}: MANIFEST_UNKNOWN: manifest unknown`);
      const r = parseRef(image);
      const d = digestOf(image);
      const record = (ok: boolean, reason?: string) => st.verifies.push({ ref: r.full, ok, reason });
      if (sub === "verify-attestation") {
        const atts = st.atts[d] ?? [];
        const type = typeof flags.type === "string" ? String(flags.type) : undefined;
        if (!atts.length) return record(false, "none"), fail("no matching attestations: none found");
        const good = atts.filter((a) => a.keyId === kid && (!type || a.type === type));
        if (!good.length) return record(false, "key"), fail("no matching attestations:\ninvalid signature when validating ASN.1 encoded signature");
        record(true);
        return `\nVerification for ${r.full} --\nThe following checks were performed on each of these signatures:\n  - The cosign claims were validated\n  - Existence of the claims in the transparency log was verified offline\n  - The signatures were verified against the specified public key\n{"payloadType":"application/vnd.in-toto+json","payload":"${btoa(JSON.stringify({ _type: "https://in-toto.io/Statement/v0.1", predicateType: good[0].type === "spdxjson" ? "https://spdx.dev/Document" : good[0].type, subject: [{ name: r.repo, digest: { sha256: d.slice(7) } }] })).slice(0, 120)}...","signatures":[{"keyid":"","sig":"MEUCIQ${hashHex(kid + d, 40)}"}]}`;
      }
      const sigs = st.sigs[d] ?? [];
      if (!sigs.length) return record(false, "none"), fail("no signatures found");
      if (!sigs.some((s) => s.keyId === kid)) return record(false, "key"), fail("no matching signatures: error verifying bundle: comparing public key PEMs, expected " + keyPath + " to match signing key\ninvalid signature when validating ASN.1 encoded signature");
      record(true);
      sh.flags.add(`cosign:verified:${r.full}`);
      return `\nVerification for ${r.full} --\nThe following checks were performed on each of these signatures:\n  - The cosign claims were validated\n  - Existence of the claims in the transparency log was verified offline\n  - The signatures were verified against the specified public key\n\n[{"critical":{"identity":{"docker-reference":"${r.repo}"},"image":{"docker-manifest-digest":"${d}"},"type":"cosign container image signature"},"optional":{"Bundle":{"SignedEntryTimestamp":"MEUCIF${hashHex(d, 30)}","Payload":{"logIndex":${parseInt(hashHex(d + kid, 7), 16) % 90000000 + 10000000}}}}}]`;
    }
    return { output: `Error: unknown command "${sub}" for "cosign"\nRun 'cosign --help' for usage.`, ok: false };
  },
  explainError: (cmd, output) => {
    if (/no signatures found/.test(output)) return "Essa imagem (esse digest) não tem nenhuma assinatura. Numa política de admission (Kyverno/Sigstore policy-controller) ela seria bloqueada — é exatamente o objetivo: só roda o que o seu CI assinou.";
    if (/no matching signatures/.test(output)) return "A imagem tem assinatura, mas não da chave que você passou. Ou a chave pública está errada, ou alguém assinou com outra chave — trate como suspeito.";
    if (/decryption failed/.test(output)) return "A senha da chave privada não confere. Exporte a mesma senha usada no generate-key-pair: export COSIGN_PASSWORD=... (em CI ela vem de um secret).";
    if (/did you pass the \.pub|not a public key/.test(output)) return "Chaves trocadas: sign/attest usam a privada (--key cosign.key); verify usa a pública (--key cosign.pub).";
    if (/already exists/.test(output)) return "Já existe um cosign.key aqui. Use o par existente ou gere outro com --output-key-prefix outro-nome.";
    if (/MANIFEST_UNKNOWN/.test(output)) return "Essa imagem/tag não existe no registry. Confira o nome exato (ex.: ghcr.io/danylo/api:1.4.0).";
    return null;
  },
});
