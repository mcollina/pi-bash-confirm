import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import bashConfirm from "../extensions/bash-confirm.ts";

function createPi() {
  let toolCallHandler: ((event: any, ctx: any) => Promise<unknown>) | undefined;
  const pi = {
    on(eventName: string, handler: (event: any, ctx: any) => Promise<unknown>) {
      if (eventName === "tool_call") toolCallHandler = handler;
    },
    registerCommand() {},
  } as unknown as ExtensionAPI;
  bashConfirm(pi);
  assert.ok(toolCallHandler);
  return toolCallHandler;
}

test("no-UI neverAllow block returns a specific reason and does not abort", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "bash-confirm-noui-neverallow-"));
  mkdirSync(join(tempDir, ".pi"));
  writeFileSync(
    join(tempDir, ".pi", "settings.json"),
    JSON.stringify({
      bashConfirm: {
        autoAccept: {
          enabled: true,
          neverAllowPatterns: ["printf"],
        },
      },
    }),
  );

  try {
    const toolCallHandler = createPi();
    let abortCount = 0;
    const result = await toolCallHandler(
      { toolName: "bash", input: { command: "printf risky" } },
      {
        cwd: tempDir,
        sessionId: "no-ui-neverallow",
        mode: "print",
        hasUI: false,
        ui: { notify() {} },
        abort() {
          abortCount++;
        },
      },
    );

    assert.deepEqual(result, {
      block: true,
      reason: "Command matched autoAccept.neverAllowPatterns; confirmation required (no UI available)",
    });
    assert.equal(abortCount, 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("no-UI auto-accept review returns the model reason and does not abort", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "bash-confirm-noui-review-"));
  const faux = registerFauxProvider();
  mkdirSync(join(tempDir, ".pi"));
  writeFileSync(
    join(tempDir, ".pi", "settings.json"),
    JSON.stringify({
      bashConfirm: {
        autoAccept: {
          enabled: true,
        },
      },
    }),
  );

  try {
    faux.setResponses([
      () => fauxAssistantMessage('{"decision":"review","reason":"remote API call"}'),
    ]);
    const toolCallHandler = createPi();
    let abortCount = 0;
    const result = await toolCallHandler(
      { toolName: "bash", input: { command: "gh repo fork owner/repo" } },
      {
        cwd: tempDir,
        sessionId: "no-ui-review",
        mode: "print",
        hasUI: false,
        model: faux.getModel(),
        modelRegistry: {
          getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "", headers: {}, env: {} }),
          find: () => faux.getModel(),
        },
        ui: { notify() {} },
        abort() {
          abortCount++;
        },
      },
    );

    assert.deepEqual(result, {
      block: true,
      reason: "auto-accept requested review: remote API call; confirmation required (no UI available)",
    });
    assert.equal(abortCount, 0);
  } finally {
    faux.unregister();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
