---
name: dash
description: Usage dashboard and task planner for Claude Code accounts. Use when the user says "dash", "open dash", "usage", "how much usage left", or BEFORE starting any large task (multi-file refactor, big research, workflow/multi-agent run, anything likely >5% of the 5h session) to project its usage cost, pick model/effort, and size agent counts.
---

# Dash

CLI: `dash <cmd>` (or `node <path-to-claude-dash>/dash.mjs <cmd>` if you did not `npm link` it). The account defaults to this session's CLAUDE_CONFIG_DIR; override with `--account <key|plan>`; `dash accounts` lists them. Data comes from the same usage endpoint as Claude Code's /usage, so percentages and reset times are exact; task cost estimates are calibrated heuristics.

## Commands
- `status` - session + weekly % used, burn rate, projected %-at-reset, projected limit-hit time, reset times.
- `open [--app]` - opens the browser dashboard (charts for session and weekly: consumed, projected, limit, reset; account switcher; task planner).
- `plan --size XS|S|M|L|XL [--agents N] [--desc "..."] [--open]` - text chart + model/effort options table + fit verdicts + recommendation + agent count that fits.
- `done [--model m --effort e]` - after the task, measures actual cost and recalibrates estimates. Always run it after a planned task.
- `snapshot` - record a data point (improves burn-rate projection).

## When the user says "dash" / "open dash"
Run `open`, then `status` and give a 2-line summary.

## Before a large task (automatic)
1. Classify size: XS tiny edit, S single-file change, M few files/some research, L multi-file feature or deep research, XL repo-wide refactor or many-agent workflow. Count planned agents if using Workflow/Agent fan-out.
2. Run `plan --size <S> --agents <N> --desc "<task>"` and paste the chart + options table into chat.
3. Present the user a choice of model + effort (recommended first). If the task would exceed the session, offer: downshift, split across the reset, or wait. If a Workflow is planned, state the agent count the budget supports and cap the workflow to it.
4. Do not start until the user picks, unless they have said to proceed automatically. Skip the check for XS/S tasks.
5. After finishing, run `done`.
