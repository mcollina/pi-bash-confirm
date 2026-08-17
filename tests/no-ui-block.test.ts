import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import bashConfirm from "../extensions/bash-confirm.ts";

function isolateAgentDir(t: { after: (fn: () => void) => void }, tempDir: string) {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(tempDir, "agent");
  t.after(() => {
    if (previousAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  });
}

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

function noUiCtx(tempDir: string, extra: Record<string, unknown> = {}) {
  let abortCount = 0;
  return {
    abortCount: () => abortCount,
    ctx: {
      cwd: tempDir,
      sessionId: "no-ui",
      mode: "print",
      hasUI: false,
      ui: { notify() {} },
      abort() {
        abortCount++;
      },
      ...extra,
    },
  };
}

test("no-UI neverAllow block returns a specific reason and does not abort", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "bash-confirm-noui-neverallow-"));
  isolateAgentDir(t, tempDir);
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
    const { ctx, abortCount } = noUiCtx(tempDir);
    const result = await toolCallHandler(
      { toolName: "bash", input: { command: "printf risky" } },
      ctx,
    );

    assert.deepEqual(result, {
      block: true,
      reason: "Command matched autoAccept.neverAllowPatterns",
    });
    assert.equal(abortCount(), 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("no-UI auto-accept review returns the model reason and does not abort", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "bash-confirm-noui-review-"));
  isolateAgentDir(t, tempDir);
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
    const { ctx, abortCount } = noUiCtx(tempDir, {
      sessionId: "no-ui-review",
      model: faux.getModel(),
      modelRegistry: {
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "", headers: {}, env: {} }),
        find: () => faux.getModel(),
      },
    });
    const result = await toolCallHandler(
      { toolName: "bash", input: { command: "gh repo fork owner/repo" } },
      ctx,
    );

    assert.deepEqual(result, {
      block: true,
      reason: "auto-accept requested review: remote API call",
    });
    assert.equal(abortCount(), 0);
  } finally {
    faux.unregister();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("no-UI waits for a late auto-accept allow", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "bash-confirm-noui-late-"));
  isolateAgentDir(t, tempDir);
  const faux = registerFauxProvider();
  mkdirSync(join(tempDir, ".pi"));
  writeFileSync(
    join(tempDir, ".pi", "settings.json"),
    JSON.stringify({
      bashConfirm: {
        autoAccept: {
          enabled: true,
          timeoutMs: 1000,
        },
      },
    }),
  );

  try {
    faux.setResponses([
      async () => {
        await new Promise(resolve => setTimeout(resolve, 1200));
        return fauxAssistantMessage('{"decision":"allow","reason":"safe local command"}');
      },
    ]);
    const toolCallHandler = createPi();
    const { ctx, abortCount } = noUiCtx(tempDir, {
      sessionId: "no-ui-late",
      model: faux.getModel(),
      modelRegistry: {
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "", headers: {}, env: {} }),
        find: () => faux.getModel(),
      },
    });
    const result = await toolCallHandler(
      { toolName: "bash", input: { command: "printf ok" } },
      ctx,
    );

    assert.equal(result, undefined);
    assert.equal(abortCount(), 0);
  } finally {
    faux.unregister();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("no-UI uses auto-accept when it is off in settings but a model is available", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "bash-confirm-noui-implicit-"));
  isolateAgentDir(t, tempDir);
  const faux = registerFauxProvider();
  mkdirSync(join(tempDir, ".pi"));
  writeFileSync(
    join(tempDir, ".pi", "settings.json"),
    JSON.stringify({
      bashConfirm: {
        autoAccept: {
          enabled: false,
        },
      },
    }),
  );

  try {
    faux.setResponses([
      () => fauxAssistantMessage('{"decision":"allow","reason":"safe local command"}'),
    ]);
    const toolCallHandler = createPi();
    const { ctx, abortCount } = noUiCtx(tempDir, {
      sessionId: "no-ui-implicit",
      model: faux.getModel(),
      modelRegistry: {
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "", headers: {}, env: {} }),
        find: () => faux.getModel(),
      },
    });
    const result = await toolCallHandler(
      { toolName: "bash", input: { command: "printf ok" } },
      ctx,
    );

    assert.equal(result, undefined);
    assert.equal(abortCount(), 0);
  } finally {
    faux.unregister();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
