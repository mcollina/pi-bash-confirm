import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import bashConfirm from "../extensions/bash-confirm.ts";

test("late auto-accept dismisses the confirmation dialog", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "bash-confirm-late-auto-accept-"));
  const faux = registerFauxProvider();
  mkdirSync(join(tempDir, ".pi"));
  writeFileSync(
    join(tempDir, ".pi", "settings.json"),
    JSON.stringify({ bashConfirm: { autoAccept: { enabled: true, timeoutMs: 1000 } } }),
  );

  const notifications: string[] = [];
  let toolCallHandler: ((event: any, ctx: any) => Promise<unknown>) | undefined;
  const pi = {
    on(eventName: string, handler: (event: any, ctx: any) => Promise<unknown>) {
      if (eventName === "tool_call") toolCallHandler = handler;
    },
    registerCommand() {},
  } as unknown as ExtensionAPI;

  try {
    faux.setResponses([
      async () => {
        await new Promise(resolve => setTimeout(resolve, 1200));
        return fauxAssistantMessage('{"decision":"allow","reason":"safe local command"}');
      },
    ]);
    bashConfirm(pi);
    assert.ok(toolCallHandler);

    const ctx = {
      cwd: tempDir,
      sessionId: "late-auto-accept-test",
      mode: "tui",
      hasUI: true,
      model: faux.getModel(),
      modelRegistry: {
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "", headers: {}, env: {} }),
        find: () => faux.getModel(),
      },
      ui: {
        notify(message: string) {
          notifications.push(message);
        },
        custom(factory: any) {
          return new Promise(resolve => {
            factory(
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
              resolve,
            );
          });
        },
      },
      abort() {},
    };

    const result = await toolCallHandler({ toolName: "bash", input: { command: "printf risky" } }, ctx);
    assert.equal(result, undefined);
    assert.ok(notifications.some(message => message.includes("safe local command")));
  } finally {
    faux.unregister();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
