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

test("no-UI blocks when auto-accept exceeds the hard deadline", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "bash-confirm-noui-timeout-"));
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
      sessionId: "no-ui-timeout",
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

    assert.deepEqual(result, {
      block: true,
      reason: "auto-accept timed out after 1000ms",
    });
    assert.equal(abortCount(), 0);
  } finally {
    faux.unregister();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("no-UI respects disabled auto-accept when a model is available", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "bash-confirm-noui-disabled-"));
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
    let evaluationCount = 0;
    faux.setResponses([
      () => {
        evaluationCount++;
        return fauxAssistantMessage('{"decision":"allow","reason":"safe local command"}');
      },
    ]);
    const toolCallHandler = createPi();
    const { ctx, abortCount } = noUiCtx(tempDir, {
      sessionId: "no-ui-disabled",
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

    assert.deepEqual(result, {
      block: true,
      reason: "Confirmation required",
    });
    assert.equal(evaluationCount, 0);
    assert.equal(abortCount(), 0);
  } finally {
    faux.unregister();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("RPC uses standard selection UI instead of custom TUI UI", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "bash-confirm-rpc-allow-"));
  isolateAgentDir(t, tempDir);

  try {
    const toolCallHandler = createPi();
    let abortCount = 0;
    let selectCount = 0;
    const ctx = {
      cwd: tempDir,
      sessionId: "rpc-allow",
      mode: "rpc",
      hasUI: true,
      ui: {
        notify() {},
        async select(_title: string, options: string[]) {
          selectCount++;
          return options.find(option => option.startsWith("Allow —"));
        },
        async custom() {
          throw new Error("RPC must not use custom TUI UI");
        },
      },
      abort() {
        abortCount++;
      },
    };

    const result = await toolCallHandler(
      { toolName: "bash", input: { command: "printf risky" } },
      ctx,
    );

    assert.equal(result, undefined);
    assert.equal(selectCount, 1);
    assert.equal(abortCount, 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("RPC explicit block aborts the turn", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "bash-confirm-rpc-block-"));
  isolateAgentDir(t, tempDir);

  try {
    const toolCallHandler = createPi();
    let abortCount = 0;
    const ctx = {
      cwd: tempDir,
      sessionId: "rpc-block",
      mode: "rpc",
      hasUI: true,
      ui: {
        notify() {},
        async select(_title: string, options: string[]) {
          return options.find(option => option.startsWith("Block —"));
        },
        async custom() {
          throw new Error("RPC must not use custom TUI UI");
        },
      },
      abort() {
        abortCount++;
      },
    };

    const result = await toolCallHandler(
      { toolName: "bash", input: { command: "printf risky" } },
      ctx,
    );

    assert.deepEqual(result, { block: true, reason: "Blocked by user" });
    assert.equal(abortCount, 1);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
