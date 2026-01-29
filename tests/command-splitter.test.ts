import test from "node:test";
import assert from "node:assert/strict";
import { splitCommand } from "../extensions/command-splitter.ts";

function assertSplit(command, { segments, operators, requiresConfirmation }) {
  const result = splitCommand(command);
  assert.deepEqual(result.segments, segments, "segments mismatch");
  assert.deepEqual(result.operators, operators, "operators mismatch");
  assert.equal(result.requiresConfirmation, requiresConfirmation, "requiresConfirmation mismatch");
}

test("splits basic separators", () => {
  assertSplit("ls && pwd", {
    segments: ["ls", "pwd"],
    operators: ["&&"],
    requiresConfirmation: false,
  });
});

test("splits mixed separators", () => {
  assertSplit("ls; pwd | wc", {
    segments: ["ls", "pwd", "wc"],
    operators: [";", "|"],
    requiresConfirmation: false,
  });
});

test("ignores separators in quotes", () => {
  assertSplit("echo 'a && b' && pwd", {
    segments: ["echo 'a && b'", "pwd"],
    operators: ["&&"],
    requiresConfirmation: false,
  });

  assertSplit("echo \"a || b\" || whoami", {
    segments: ["echo \"a || b\"", "whoami"],
    operators: ["||"],
    requiresConfirmation: false,
  });
});

test("ignores escaped separators", () => {
  assertSplit("echo a\\&\\&b", {
    segments: ["echo a\\&\\&b"],
    operators: [],
    requiresConfirmation: false,
  });
});

test("splits pipes", () => {
  assertSplit("cat file | grep foo | wc", {
    segments: ["cat file", "grep foo", "wc"],
    operators: ["|", "|"],
    requiresConfirmation: false,
  });
});

test("parses backticks and command substitutions", () => {
  assertSplit("echo `whoami && id`", {
    segments: ["echo `whoami && id`", "whoami", "id"],
    operators: ["&&"],
    requiresConfirmation: false,
  });

  assertSplit("echo $(whoami && id)", {
    segments: ["echo $(whoami && id)", "whoami", "id"],
    operators: ["&&"],
    requiresConfirmation: false,
  });
});

test("flags empty segments", () => {
  const result = splitCommand("ls &&  && pwd");
  assert.deepEqual(result.segments, ["ls", "pwd"]);
  assert.deepEqual(result.operators, ["&&", "&&"]);
  assert.equal(result.requiresConfirmation, true);
});

test("splits newlines", () => {
  assertSplit("ls\npwd", {
    segments: ["ls", "pwd"],
    operators: ["\n"],
    requiresConfirmation: false,
  });
});

test("depth limit requires confirmation", () => {
  const deep = "echo $(echo $(echo $(echo $(echo $(echo $(echo hi))))))";
  const result = splitCommand(deep);
  assert.equal(result.requiresConfirmation, true);
});
