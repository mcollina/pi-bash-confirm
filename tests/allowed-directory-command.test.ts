import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import bashConfirm from "../extensions/bash-confirm.ts";

test("/bash-confirm-allow-directory adds a directory to auto-accept prompts for the session", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "bash-confirm-allowed-directory-"));
  const additionalDirectory = join(tempDir, "shared-output");
  const faux = registerFauxProvider();
  mkdirSync(join(tempDir, ".pi"));
  mkdirSync(additionalDirectory);
  writeFileSync(
    join(tempDir, ".pi", "settings.json"),
    JSON.stringify({ bashConfirm: { autoAccept: { enabled: true } } }),
  );

  let prompt = "";
  let toolCallHandler: ((event: any, ctx: any) => Promise<unknown>) | undefined;
  let allowDirectoryHandler: ((args: string, ctx: any) => Promise<void>) | undefined;
  const pi = {
    on(eventName: string, handler: (event: any, ctx: any) => Promise<unknown>) {
      if (eventName === "tool_call") toolCallHandler = handler;
    },
    registerCommand(name: string, options: { handler: (args: string, ctx: any) => Promise<void> }) {
      if (name === "bash-confirm-allow-directory") allowDirectoryHandler = options.handler;
    },
  } as unknown as ExtensionAPI;

  try {
    faux.setResponses([
      (context: any) => {
        const userMessage = context.messages.find((message: any) => message.role === "user");
        prompt = typeof userMessage?.content === "string" ? userMessage.content : "";
        return fauxAssistantMessage('{"decision":"allow","reason":"safe local command"}');
      },
    ]);
    bashConfirm(pi);
    assert.ok(toolCallHandler);
    assert.ok(allowDirectoryHandler);

    const notifications: string[] = [];
    const ctx = {
      cwd: tempDir,
      sessionId: "allowed-directory-test",
      mode: "print",
      hasUI: false,
      model: faux.getModel(),
      modelRegistry: {
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "", headers: {}, env: {} }),
        find: () => faux.getModel(),
      },
      ui: {
        notify(message: string) {
          notifications.push(message);
        },
      },
      abort() {},
    };

    await allowDirectoryHandler(additionalDirectory, ctx);
    const result = await toolCallHandler({ toolName: "bash", input: { command: "printf ok" } }, ctx);

    assert.equal(result, undefined);
    assert.ok(prompt.includes(JSON.stringify(additionalDirectory)));
    assert.ok(notifications.some(message => message.includes(`Allowed directory for this session: ${additionalDirectory}`)));
  } finally {
    faux.unregister();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
