import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import bashConfirm from "../extensions/bash-confirm.ts";

function userMessageText(message: any): string {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  return message.content
    .filter((block: any) => block?.type === "text" && typeof block.text === "string")
    .map((block: any) => block.text)
    .join("");
}

test("/bash-confirm-allow-directory adds a directory to auto-accept prompts for the session", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "bash-confirm-allowed-directory-"));
  const additionalDirectory = join(tempDir, "shared-output");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(tempDir, "agent");
  const faux = registerFauxProvider();
  mkdirSync(join(tempDir, ".pi"));
  mkdirSync(additionalDirectory);
  writeFileSync(
    join(tempDir, ".pi", "settings.json"),
    JSON.stringify({ bashConfirm: { autoAccept: { enabled: true } } }),
  );

  t.after(() => {
    if (previousAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  });

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
        prompt = userMessageText(userMessage);
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
    const resolvedDirectory = realpathSync(additionalDirectory);
    assert.ok(prompt.includes(JSON.stringify(resolvedDirectory)));
    assert.ok(notifications.some(message => message.includes(`Allowed directory for this session: ${resolvedDirectory}`)));
  } finally {
    faux.unregister();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
