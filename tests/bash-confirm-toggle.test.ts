import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import bashConfirm from "../extensions/bash-confirm.ts";

test("/bash-confirm toggles confirmation from one settings panel", async (t) => {
  initTheme("dark", false);

  const tempDir = mkdtempSync(join(tmpdir(), "bash-confirm-toggle-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(tempDir, "agent");

  t.after(() => {
    if (previousAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  let toolCallHandler: ((event: any, ctx: any) => Promise<unknown>) | undefined;
  let commandHandler: ((args: string, ctx: any) => Promise<void>) | undefined;

  const pi = {
    on(eventName: string, handler: (event: any, ctx: any) => Promise<unknown>) {
      if (eventName === "tool_call") toolCallHandler = handler;
    },
    registerCommand(name: string, options: { handler: (args: string, ctx: any) => Promise<void> }) {
      if (name === "bash-confirm") commandHandler = options.handler;
    },
  } as unknown as ExtensionAPI;

  bashConfirm(pi);
  assert.ok(toolCallHandler);
  assert.ok(commandHandler);

  let abortCount = 0;
  const commandCtx = {
    cwd: tempDir,
    sessionId: "toggle-test-session",
    mode: "tui",
    hasUI: true,
    ui: {
      notify() {},
      async custom(factory: any) {
        const component = factory(
          { requestRender() {} },
          {
            fg(_color: string, text: string) {
              return text;
            },
            bold(text: string) {
              return text;
            },
          },
          {},
          () => {},
        );
        component.handleInput(" ");
      },
    },
    abort() {
      abortCount++;
    },
  };
  const toolCtx = { ...commandCtx, hasUI: false };
  const event = { toolName: "bash", input: { command: "printf risky" } };

  await commandHandler("", commandCtx);
  assert.equal(await toolCallHandler(event, toolCtx), undefined);
  assert.equal(abortCount, 0);

  await commandHandler("", commandCtx);
  assert.deepEqual(await toolCallHandler(event, toolCtx), {
    block: true,
    reason: "Confirmation required (no UI available)",
  });
  assert.equal(abortCount, 1);
});
