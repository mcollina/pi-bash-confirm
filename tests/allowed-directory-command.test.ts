import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import bashConfirm from "../extensions/bash-confirm.ts";

test("/bash-confirm-allow-directory keeps the requested spelling and pins the resolved directory", async () => {
  const tempDir = realpathSync(mkdtempSync(join(tmpdir(), "bash-confirm-allowed-directory-")));
  const privateDirectory = join(tempDir, "private", "shared-output");
  const additionalDirectory = join(tempDir, "shared-output");
  const unrelatedDirectory = join(tempDir, "unrelated");
  const faux = registerFauxProvider();
  mkdirSync(join(tempDir, ".pi"));
  mkdirSync(privateDirectory, { recursive: true });
  mkdirSync(unrelatedDirectory);
  symlinkSync(privateDirectory, additionalDirectory, "junction");
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
    const capturePrompt = (context: any) => {
      const userMessage = context.messages.find((message: any) => message.role === "user");
      prompt = typeof userMessage?.content === "string" ? userMessage.content : "";
      return fauxAssistantMessage('{"decision":"allow","reason":"safe local command"}');
    };
    faux.setResponses([capturePrompt, capturePrompt]);
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

    await allowDirectoryHandler("shared-output", ctx);
    assert.equal(await toolCallHandler({ toolName: "bash", input: { command: "printf ok" } }, ctx), undefined);
    const allowed = (paths: string[]) => `Allowed directories (JSON): ${JSON.stringify(paths)}`;
    assert.ok(prompt.includes(allowed([tempDir, tmpdir(), privateDirectory, additionalDirectory])), prompt);
    assert.ok(notifications.includes(`Allowed directory for this session: ${additionalDirectory}`));

    await allowDirectoryHandler(additionalDirectory, ctx);
    assert.ok(notifications.includes(`Directory is already allowed for this session: ${additionalDirectory}`));

    rmSync(additionalDirectory);
    symlinkSync(unrelatedDirectory, additionalDirectory, "junction");
    prompt = "";
    assert.equal(await toolCallHandler({ toolName: "bash", input: { command: "printf ok" } }, ctx), undefined);
    assert.ok(prompt.includes(allowed([tempDir, tmpdir(), privateDirectory])), prompt);
  } finally {
    faux.unregister();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
