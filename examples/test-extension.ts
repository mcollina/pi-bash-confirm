/**
 * Test Extension for pi-bash-confirm
 *
 * This example demonstrates how to use the pi-bash-confirm extension
 * and provides utility commands for testing its functionality.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("test-bash-confirm", {
    description: "Test the bash confirmation extension",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Testing bash-confirm extension...", "info");

      // Test 1: Safe command (should not show confirmation if pattern matches)
      ctx.ui.notify("Test 1: Running 'ls' (safe command)", "info");
      await pi.runTool("bash", { command: "ls -la" });

      // Test 2: Potentially unsafe command (should show confirmation)
      ctx.ui.notify("Test 2: Try running 'rm -rf test-file' (will prompt)", "info");
      await pi.runTool("bash", { command: "echo 'rm -rf test-file' # test" });

      // Test 3: Complex command
      ctx.ui.notify("Test 3: Running a complex git command", "info");
      await pi.runTool("bash", { command: "git log --oneline -5" });

      ctx.ui.notify("Tests complete!", "success");
    },
  });

  pi.registerCommand("test-safe-patterns", {
    description: "Test various safe command patterns",
    handler: async (_args, ctx) => {
      const safeCommands = [
        "ls",
        "ls -la",
        "pwd",
        "git status",
        "git log",
        "git diff",
        "cat README.md",
        "echo 'hello'",
        "head -10 file.txt",
        "grep pattern file.txt",
      ];

      ctx.ui.notify(`Testing ${safeCommands.length} safe patterns...`, "info");

      for (const cmd of safeCommands) {
        ctx.ui.notify(`Running: ${cmd}`, "dim");
        await pi.runTool("bash", { command: cmd });
      }

      ctx.ui.notify("Safe pattern tests complete!", "success");
    },
  });

  pi.registerCommand("test-edit-mode", {
    description: "Test the edit mode for command modification",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Running a command that you can edit...", "info");
      ctx.ui.notify("Try editing: change 'echo' to 'echo -n' or add text", "dim");

      // This command will show confirmation - select "Edit" to test
      await pi.runTool("bash", { command: "echo 'Hello, World!'" });
    },
  });

  pi.registerCommand("test-unsafe-patterns", {
    description: "Test that blocked patterns are correctly rejected",
    handler: async (_args, ctx) => {
      const unsafeCommands = [
        "rm -rf /tmp/test",
        "sudo rm -rf /tmp/test",
        ":> /tmp/test",
        "dd if=/dev/zero of=/tmp/test bs=1M count=10",
      ];

      ctx.ui.notify("Testing blocked patterns (should all be rejected)...", "warning");

      for (const cmd of unsafeCommands) {
        ctx.ui.notify(`Attempting: ${cmd}`, "dim");
        try {
          await pi.runTool("bash", { command: cmd });
          ctx.ui.notify(`Unexpected success: ${cmd}`, "error");
        } catch (error) {
          ctx.ui.notify(`Blocked as expected: ${cmd}`, "success");
        }
      }

      ctx.ui.notify("Blocked pattern tests complete!", "success");
    },
  });

  pi.registerCommand("demo-bash-confirm", {
    description: "Interactive demonstration of bash-confirm features",
    handler: async (_args, ctx) => {
      ctx.ui.notify("=== Bash Confirm Demo ===", "info");
      ctx.ui.notify("", "info");

      ctx.ui.notify("This demo will show you the confirmation dialog.", "dim");
      ctx.ui.notify("You'll see options to Allow, Edit, or Block each command.", "dim");
      ctx.ui.notify("", "dim");

      ctx.ui.notify("1. Simple command (ls)", "info");
      await pi.runTool("bash", { command: "ls" });

      ctx.ui.notify("2. Safe command (git status)", "info");
      await pi.runTool("bash", { command: "git status" });

      ctx.ui.notify("3. Command with parameters (cat README.md)", "info");
      await pi.runTool("bash", { command: "cat README.md | head -20" });

      ctx.ui.notify("4. Try editing this command!", "info");
      ctx.ui.notify("   Add a pipe to 'head -5' or change the filename.", "dim");
      await pi.runTool("bash", { command: "ls -la" });

      ctx.ui.notify("5. Test notification (if configured)", "info");
      await pi.runTool("bash", { command: "echo 'Test command for notification'" });

      ctx.ui.notify("", "info");
      ctx.ui.notify("Demo complete!", "success");
      ctx.ui.notify("Run /bash-confirm test-notify to test notifications.", "dim");
      ctx.ui.notify("Run /bash-confirm debug to check configuration.", "dim");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify(
      "Test extension loaded. Commands: /test-bash-confirm, /test-safe-patterns, /test-edit-mode, /test-unsafe-patterns, /demo-bash-confirm",
      "info"
    );
  });
}
