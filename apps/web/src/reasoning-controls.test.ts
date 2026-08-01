import { describe, expect, it } from "vitest";
import {
  availableReasoningEfforts,
  reconcileReasoningConfig,
  type ReasoningSupport
} from "./reasoning-controls.js";

describe("reasoning controls", () => {
  it("offers only efforts advertised by the selected OpenRouter model", () => {
    const support: ReasoningSupport = {
      supportedEfforts: ["low", "high"],
      supportsMaxTokens: false
    };

    expect(availableReasoningEfforts(support).map(option => option.value))
      .toEqual(["low", "high"]);
    expect(reconcileReasoningConfig({
      enabled: true,
      effort: "max",
      maxTokens: 4_000,
      displayMode: "summary"
    }, support)).toEqual({
      enabled: true,
      effort: "low",
      displayMode: "summary"
    });
  });

  it("enables mandatory reasoning with the provider default effort", () => {
    expect(reconcileReasoningConfig({
      enabled: false,
      displayMode: "hidden"
    }, {
      supportedEfforts: ["none", "medium", "high"],
      defaultEffort: "high",
      mandatory: true
    })).toMatchObject({ enabled: true, effort: "high" });
  });
});
