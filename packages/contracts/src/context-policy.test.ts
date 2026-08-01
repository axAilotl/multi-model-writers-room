import { describe, expect, it } from "vitest";
import { deriveContextPolicy, type ContextBudget } from "./index.js";

const configured: ContextBudget = {
  automatic: true,
  softLimitTokens: 240_000,
  hardLimitTokens: 512_000,
  recentTranscriptTokens: 128_000,
  retrievedContextTokens: 85_333,
  notebookTokens: 0
};

describe("model-aware context policy", () => {
  it.each([
    [128_000, 128_000, 128_000],
    [256_000, 256_000, 256_000],
    [1_000_000, 256_000, 512_000]
  ])("maps %i advertised tokens to %i working and %i hard", (
    advertised,
    working,
    hard
  ) => {
    const policy = deriveContextPolicy({
      contextBudget: configured,
      modelContextLength: advertised
    });

    expect(policy).toMatchObject({
      advertisedContextTokens: advertised,
      workingLimitTokens: working,
      hardLimitTokens: hard,
      automatic: true
    });
    expect(
      policy.systemPersonaTokens +
      policy.retrievedContextTokens +
      policy.recentTranscriptTokens
    ).toBe(working);
    expect(policy.compactionTriggerTokens)
      .toBe(Math.floor(policy.recentTranscriptTokens * 0.7));
  });

  it("honors explicit manual budgets", () => {
    expect(deriveContextPolicy({
      contextBudget: {
        ...configured,
        automatic: false,
        softLimitTokens: 100_000,
        hardLimitTokens: 150_000,
        recentTranscriptTokens: 60_000,
        retrievedContextTokens: 30_000
      },
      modelContextLength: 1_000_000
    })).toMatchObject({
      workingLimitTokens: 100_000,
      hardLimitTokens: 150_000,
      recentTranscriptTokens: 60_000,
      retrievedContextTokens: 30_000,
      compactionTriggerTokens: 42_000,
      automatic: false
    });
  });
});
