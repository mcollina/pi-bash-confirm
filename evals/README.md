# Auto-accept prompt evaluations

This directory contains a curated dataset and a model-backed harness for measuring the strict and permissive auto-accept prompts.

## Dataset

`commands.json` was derived from historical Pi session files under `~/.pi/agent/sessions`:

- 472 session JSONL files across 99 project directories were scanned.
- 14,520 bash invocations were found, representing 10,182 unique commands.
- Repeated and policy-relevant commands were selected across inspection, verification, navigation, local writes, inline scripts, remote actions, and destructive operations.
- Commands were sanitized or lightly adapted to remove home-directory paths, credentials, private session identifiers, and unnecessary project-specific details.
- No complete transcript, model response, command output, or credential is included.

Each case defines the expected `allow` or `review` decision for both modes. These labels are policy expectations, not historical model decisions. Update them deliberately when the prompt policy changes.

## Validate without model calls

```bash
npm run eval -- --dry-run
```

The dry run validates the dataset and prints category and expected-decision counts. It does not read model credentials or send commands to a provider.

## Run an evaluation

The harness uses Pi's configured models and credentials from `~/.pi/agent`, but it does not execute any dataset command. Command text is sent to the selected model for classification.

```bash
npm run eval -- \
  --model openrouter/google/gemini-2.0-flash-001 \
  --mode both \
  --runs 3 \
  --concurrency 4 \
  --output /tmp/bash-confirm-eval.json
```

Alternatively, set `BASH_CONFIRM_EVAL_MODEL` instead of passing `--model`.

Useful focused runs:

```bash
npm run eval -- --model "$BASH_CONFIRM_EVAL_MODEL" --filter 'inline|navigation'
npm run eval -- --model "$BASH_CONFIRM_EVAL_MODEL" --mode strict --limit 20
```

Run `npm run eval -- --help` for every option.

## Metrics

The harness reports:

- **Accuracy**: decisions matching the curated labels.
- **False negatives**: expected approval, but the model requested review. This is the missed-approval rate the prompt changes primarily target.
- **False positives**: expected review, but the model approved the command. These are potentially unsafe approvals.
- **Errors**: request failures or invalid model output. Invalid output is scored as `review`, matching the production fallback.
- **Cost**: provider-reported request cost when available.

Detailed JSON reports contain every raw model response, normalized decision, reason, latency, parse/request error, and expected label.

## Requirements

The eval script uses Node's native TypeScript stripping and therefore requires Node.js 22 or newer. The published extension itself continues to support the package's documented Node.js range.
