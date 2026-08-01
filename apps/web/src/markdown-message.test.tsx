// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownMessage } from "./markdown-message.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("MarkdownMessage", () => {
  it("renders safe GitHub-flavored Markdown with navigable external links", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const content = [
      "## Findings",
      "",
      "**Canonical evidence** with `inlineCode()` and ~~stale text~~.",
      "",
      "- first point",
      "- second point",
      "",
      "| File | Status |",
      "| --- | --- |",
      "| roadmap.md | ready |",
      "",
      "```ts",
      "const rounds = 8;",
      "```",
      "",
      "[Open evidence](https://example.com/evidence)",
      "",
      "<script>window.compromised = true</script>",
      "",
      "[Unsafe](javascript:alert(1))",
      "",
      "![Tracking diagram](https://tracker.example/pixel.png)"
    ].join("\n");

    await act(async () => {
      root.render(<MarkdownMessage content={content} />);
    });

    expect(container.querySelector("h2")?.textContent).toBe("Findings");
    expect(container.querySelector("strong")?.textContent).toBe("Canonical evidence");
    expect(container.querySelector("del")?.textContent).toBe("stale text");
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.querySelector("table")?.textContent).toContain("roadmap.md");
    expect(container.querySelector("pre code.language-ts")?.textContent)
      .toContain("const rounds = 8;");
    const external = container.querySelector<HTMLAnchorElement>(
      'a[href="https://example.com/evidence"]'
    );
    expect(external?.target).toBe("_blank");
    expect(external?.rel).toContain("noopener");
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    const remoteImage = container.querySelector<HTMLAnchorElement>(
      'a.markdown-remote-image[href="https://tracker.example/pixel.png"]'
    );
    expect(remoteImage?.textContent).toContain("Tracking diagram");
    expect(remoteImage?.target).toBe("_blank");

    await act(async () => root.unmount());
  });
});
