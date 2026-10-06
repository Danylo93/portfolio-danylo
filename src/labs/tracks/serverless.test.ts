import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Shell } from "../shell";
import { expectSolvable, expectWellFormed } from "../test-utils";
import { labs } from "./serverless";
import { controlPlaneLab } from "./control-plane";
import { API_HOST, awsState } from "../tools/aws";

describe("novos labs", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it.each([...labs, controlPlaneLab].map((lab) => [lab.id, lab] as const))("%s pode ser concluído", (_, lab) => {
    expectWellFormed(lab);
    expectSolvable(lab, lab.steps.map((step) => step.code!.map((cmd) => () => cmd)));
  });
  it("não conclui a API sem permissão de invocação", () => {
    const lab = labs[1];
    const sh = new Shell();
    sh.exec(lab.steps[0].code![0]);
    sh.exec(`curl https://${API_HOST}`);
    expect(sh.entries.at(-1)!.output).toContain("Internal Server Error");
    expect(awsState(sh).tested).toBe(false);
    expect(lab.steps[2].check(sh)).toBe(false);
  });
  it("rejeita configuração inválida sem alterar a função", () => {
    const sh = new Shell();
    sh.exec("aws lambda update-function-configuration --function-name hello --memory-size 1 --timeout 10");
    expect(sh.entries.at(-1)!.ok).toBe(false);
    expect(awsState(sh).memory).toBe(128);
    expect(awsState(sh).timeout).toBe(3);
  });
  it("isola o estado entre sessões", () => {
    const first = new Shell();
    first.exec(labs[1].steps[0].code![0]);
    expect(awsState(first).api).toBe(true);
    expect(awsState(new Shell()).api).toBe(false);
  });
});
