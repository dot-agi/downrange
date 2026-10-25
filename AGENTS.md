# Agent instructions: Downrange

Downrange is a Claude Code mod, plugin `downrange`. It tracks the background tasks of a session and shows them in a band, a pane, and the `/downrange` table.

## Install and update

Install from a shell with Claude Code 2.1.292 or later. The second part turns on auto-update. It runs only when the install succeeds and the marketplace entry exists:

```sh
claude plugin install downrange --marketplace dot-agi/downrange --scope user --json \
  && f="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json" \
  && jq -e --arg name downrange '.extraKnownMarketplaces[$name].source' "$f" > /dev/null \
  && tmp=$(mktemp "$f.XXXXXX") \
  && { jq --arg name downrange '.extraKnownMarketplaces[$name].autoUpdate = true' "$f" > "$tmp" && mv "$tmp" "$f" || { rm -f "$tmp"; false; }; }
```

Claude Code 2.1.288 to 2.1.291 has no `--marketplace` option. Add the marketplace first, then run the auto-update part above:

```sh
claude plugin marketplace add dot-agi/downrange --scope user --json \
  && claude plugin install downrange@downrange --scope user --json
```

Auto-update runs only in interactive sessions. A headless job updates at its start, before the session that uses the mod:

```sh
claude plugin update downrange@downrange --json
```

Check the result. The first command prints the installed version. The second prints the latest release:

```sh
claude plugin list --json | jq -r '.[] | select(.id == "downrange@downrange") | "\(.version) enabled=\(.enabled)"' \
  && git ls-remote --tags --refs https://github.com/dot-agi/downrange 'downrange--v*' | sed 's/.*--v//' | sort -V | tail -n 1
```

Notes:

- On a host with no SSH key for GitHub, set `CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1` in the environment of every `claude` command and session.
- New code loads in the next session, or after `/reload-plugins`. An agent cannot type `/reload-plugins`, so it starts a new session.
- Running `install` again does not update. Use `update`.
- The `mv` replaces the settings file, with mode 600. If `settings.json` is a symbolic link, edit its target instead.

## Layout

| Path | Holds |
| --- | --- |
| `.claude-plugin/plugin.json` | The manifest, the options, and the state contract path |
| `.claude-plugin/marketplace.json` | The one-plugin marketplace |
| `hooks/hooks.json` | The name of the hooks module, `./register.tsx` |
| `hooks/register.tsx` | Every hook, every `$` call, the command name and the pane constants, the state atoms, the memory and its mirror, the writers, the ticker, and the diagnostics |
| `hooks/limits.ts` | Every named limit |
| `hooks/output.ts` | Clipping, display lines, progress, ETA math, durations, the output path rule, and the end of an output |
| `hooks/redirect.ts` | The redirect rule: the one file that a background command's text sends its output to |
| `hooks/notices.ts` | Task-notification parsing |
| `hooks/jobs.ts` | Job builders and pure reducers |
| `hooks/history.ts` | The usual-duration history |
| `hooks/prompt.ts` | Status prompt matching |
| `hooks/view.ts` | Rows, the table text, the band line, and the pane model |
| `hooks/drawing.tsx` | The band and pane element trees |
| `types/index.d.ts` | The job types and the `PluginState` contract |
| `tests/` | Local test files (`*.test.ts`) for the test kit, and the stub world in `tests/fixtures.ts`. Git does not track them |

## Commands

- Validate: `claude plugin validate .` (the marketplace) and `claude plugin validate .claude-plugin/plugin.json` (the plugin, its hooks, and its `$` calls)
- Test: `claude plugin test .` (it needs at least one `*.test.ts` file under `tests/`)
- Type check: `npx -p typescript tsc -p .`. It needs `.claude-plugin/types/` and `tsconfig.json`, and a build whose tool table has `Monitor`, `ScheduleWakeup`, `Workflow`, and `TaskStop` (see CONTRIBUTING.md).

Run all of them after each change. All must pass.

## Rules

- Write every `$` call in full in `hooks/register.tsx`, inside a hook or a top-level function of that file. Never pass `$` to an imported function, except `read` and `update` from `claude-code`. `claude plugin validate` reads `$` calls from source and fails otherwise.
- Write event names in `on(...)` as string literals. Write each matcher value as a literal or as a constant of `hooks/register.tsx`: `claude plugin validate` shows an imported constant as `?`. Use static imports only. Hooks run with no DOM and no Node.
- Export every type in `types/index.d.ts`. `claude plugin validate` refuses a contract type without `export`.
- Keep the other modules pure: no `$`, no I/O, and no clock reads. Pass `now` in.
- Keep the jobs and the wakeup in module memory, `memory`: it is the source of truth, and it survives `/clear`, `/resume`, and `/branch`. `$.state` holds a mirror of the current session's view for drawing, and **Hide** and the last answered status prompt as atoms. The only module variables are `ticker`, `isTicking`, `lastTickAt`, `memory`, `since`, `sessions`, `switchedAt`, `pending`, `mirror`, `historyWrites`, `reported`, and `isAnyRatio`, the `genericRatios` option that `register` sets.
- Change `memory.jobs` only through `writeJobs` and `memory.wakeup` only through `writeWakeup`: they change memory at once, then write the mirror through `mirrored`, wait until a write that holds the change has landed, and keep the ticker current. A failed write is no failure of the hook (see `persisted`): memory took the change, so the rest of the hook runs. Each hook passes one `deadlineOf()` to all its writes: it waits `MIRROR_WAIT_MS` at most in all, and a wait that passes its deadline leaves the write's waiters. A reload of the mod empties module variables and keeps `$.state`: only `loaded`, at the first `session.start`, change of memory, or mirror write, reads the jobs and the wakeup from `$.state` into memory. Each change of memory waits for that read and applies on top of it, and no mirror write goes out before it. The mirror keeps a removal for each ended job that the session does not show (see `viewedJobs`). Read the mirror only to draw: in a render hook, `/downrange`, and the status answer.
- Settle each `/clear`, `/resume`, and `/branch` in two ways. `classic.SessionStart` is the main way. Under managed settings or a Team or Enterprise login, Claude Code's built-in guard keeps every `classic.*` event from the mod, so `switched` is the second way. `session.end` sets `pending`. Every hook other than `session.start`, `session.end`, `classic.SessionStart`, and the render hooks calls `switched` first, and so does each tick. A `command.run` hook for every command calls `switched`, then passes the command on unchanged, so that a command that reloads the mod, such as `/reload-plugins`, finds the view in `$.state`. A `config.set` hook for every key calls `switched` before a `/config` row changes, because a change of an option reloads the mod. It returns `next(e)` unchanged: it never refuses a change and never changes a value. A settle clears `pending` before its write lands, so `mirror.settle` holds the write of each settle, by `switched` or by `classic.SessionStart`, until it lands or fails. Both hooks call `settleLanded` after `switched`: it waits for that write within the hook's deadline, and with no settle in progress it waits for nothing. Then, when the last mirror write failed (`mirror.isBehind`), both write the view once more through `persisted`, within the same deadline. A failed write there is no failure of the hook, and with no write behind they write nothing. `session.end` also runs `switched` once at once, with `$.clock.after(0)` (see `settledAtOnce`), because the first tick can be a second away. Both ways must give a session the same start, and `classic.SessionStart` must keep every change that came after `switched`. Never settle a `/branch` before `classic.SessionStart`: during that event, `$.session.id()` still answers the parent's id.
- Render hooks never write state. Buttons write from their press handlers.
- Give every `on(...)` registration a `.catch` that logs the failure under the hook's label, such as `tool.call{tool=Bash}`, and passes the event on with `next(e)`: write it as a function literal that calls `passOn`. `claude plugin validate` refuses a `.catch` that is not a function literal or the name of one. The `/downrange` command and the pane answer with the cause instead.
- Start every diagnostic with `downrange: <event>: `, then the cause. Never log output text, prompt text, or a command line.
- Add no network call, no file write, and no host command other than `tail -c` for outputs over 4 MiB.
- Read only two files of a job: its output file, whose path matches the output path rule for the job's own id, and its redirect file, the one regular file that `hooks/redirect.ts` finds in the job's command.
- Look up words that come from the engine (statuses, task types, tool names) in a `Map`, never in a plain object.
- In tests, stub every tool result, file, and process. A test never runs a real command.
- Name each new limit in `hooks/limits.ts`.
- Add no export, branch, or option that nothing uses.
