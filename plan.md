# Plan: Split Command Whitelist Evaluation with TDD Parser Utility

## Goals
- Treat `&&`, `||`, `|`, and `;` as separators for whitelist/safe/blocked evaluation so that a chain of individually safe commands can pass without confirmation.
- Implement a tiny command-splitting utility with tests using `node:test`.
- Keep behavior unchanged for commands without separators.

## Assumptions (limited `sh`-like subset)
- Ignore separators inside single quotes, double quotes, and when escaped with `\`.
- Parse backticks (`` `cmd` ``) and `$()` command substitutions and split their inner commands too.
- Support simple nesting for `$()` and backticks (depth-limited to 5).
- If nesting exceeds depth 5, abort parsing and require confirmation.
- No support for here-docs, process substitution, multiline `if`/`for` blocks, or compound commands.
- Split on top-level `&&`, `||`, `|`, and `;` outside quotes/escapes, while also extracting segments inside command substitutions.

## TDD Steps (node:test)
1. **Create test skeleton**
   - Add `tests/command-splitter.test.ts` using `node:test` + `node:assert`.
   - Use table-driven tests for readability.

2. **Define expected split behavior**
   - Basic separators: `"ls && pwd"` → `["ls", "pwd"]`.
   - Mixed separators: `"ls; pwd | wc"` → `["ls", "pwd", "wc"]` (keep original operator list in utility if needed).
   - Whitespace trimming around segments.
   - Escaped separators: `"echo a\&\&b"` should **not** split.
   - Quotes: `"echo 'a && b' && pwd"` splits into `["echo 'a && b'", "pwd"]`.
   - Double quotes: `"echo \"a || b\" || whoami"` splits into `["echo \"a || b\"", "whoami"]`.
   - Pipes: `"cat file | grep foo | wc"` → `["cat file", "grep foo", "wc"]`.
   - Command substitution parsing:
     - ``"echo `whoami && id`"`` → `["echo `whoami && id`", "whoami", "id"]` (inner segments also extracted).
     - `"echo $(whoami && id)"` → `["echo $(whoami && id)", "whoami", "id"]`.
   - Empty segments: `"ls &&  && pwd"` should trigger confirmation (treat as invalid/unsafe).

3. **Implement parser utility**
   - New file: `extensions/command-splitter.ts` (or `src/command-splitter.ts` if preferred) exporting:
     - `splitCommand(command: string): { segments: string[]; operators: string[]; requiresConfirmation: boolean }`.
   - Implement a small state machine with recursion for command substitution:
     - Track quote mode (`'` or `"`), escape state, and build current segment.
     - When not in quotes and not escaped, detect `&&`, `||`, `|`, `;`.
     - When encountering backticks or `$(`, parse the inner region and also split its contents; merge inner segments into output.
     - Push trimmed segment to `segments`, track operator in `operators`.
     - If nesting exceeds depth 5, set `requiresConfirmation`.
     - If empty segments are found, set `requiresConfirmation`.

4. **Add unit tests for edge cases**
   - Leading/trailing separators.
   - Multiple whitespace/newlines.
   - Escaped quotes inside quotes.
   - Depth limit exceeded triggers `requiresConfirmation`.

5. **Integrate into whitelist/safe/blocked checks**
   - In `extensions/bash-confirm.ts`, replace single-command checks with per-segment evaluation.
   - Rule: allow without confirmation if **all** segments match whitelist or safe patterns (and none match blocked patterns), and `requiresConfirmation` is false.
   - If any segment matches blocked patterns → block (as today).
   - If some segments match safe/whitelist and some don’t → require confirmation.

6. **Update docs if needed**
   - Add a short note in `README.md` or `docs/example-settings.json` describing segment-based evaluation.

## Acceptance Criteria
- Tests pass with `node --test`.
- A command like `"ls && pwd"` is auto-allowed if both segments are whitelisted/safe.
- A command like `"ls && rm -rf /"` is blocked if any segment matches blocked patterns.
- Complex commands inside quotes are not split.

## Open Questions
None (decisions captured):
- Split on newlines for evaluation.
- Use trimmed segment matching for whitelist checks.
