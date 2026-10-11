# Downrange usage guide

Downrange follows the background tasks of a Claude Code session. It shows the state and age of each job, and its progress, ETA, and last output line when they are known. This guide covers every view, command, key, and option, and what each diagnostic means.

A job here is one background task of this session. Claude Code's agent view calls whole background sessions "background jobs"; Downrange does not track those.

## What it tracks

| Work | Starts when | Ends when |
| --- | --- | --- |
| Shell command | A Bash call runs in the background: `run_in_background`, ctrl+b, or a command moved to the background at its timeout | Its notification arrives, `TaskStop` stops it, or the session's task list no longer holds it |
| Monitor | A Monitor call starts a watch | Its end notification arrives, or the task list no longer holds it |
| Subagent | An Agent call runs in the background or remotely | Its notification arrives, the agent list reports its end, or the task list no longer holds it |
| Workflow | A Workflow call launches a run | Its notification arrives, or the task list no longer holds it |
| Wakeup | `ScheduleWakeup` sets the next dynamic `/loop` wakeup | A scheduled prompt fires from 5 seconds before its due time on, `ScheduleWakeup` stops it, a turn-end snapshot taken at least 10 seconds after scheduling holds no one-shot schedule, or it is 10 minutes past due. The prompt and the one-shot schedule can belong to another schedule |

Work that started before Downrange saw it joins when a notification or the session's task list names it. Its age then starts with `≥` (at least).

A wakeup has a 10-second grace period after scheduling because a turn-end snapshot can predate it. If cancellation falls within that period, it clears at a later eligible turn end or 10 minutes past due.

Wakeup changes retain their observation time, including cancellations. Delayed updates cannot undo a newer cancellation or schedule.

## The band

The band is one line above the prompt:

```
● 2 running  ✗ 1 failed  ◷ in 4m 10s │ ✗ lint exit 2 · build 12/40 (30%) ~6m · review PR 14 tools   [ Open ] [ Hide ]
```

- It shows while work is live: a job runs, a wakeup is pending, or a job ended in the last 60 seconds.
- Counts come first: running jobs, jobs that failed in the last 60 seconds, and the wakeup countdown.
- Job snippets follow: recent failures, running jobs with progress, other running jobs (oldest first), then other recent ends. Snippets that do not fit the width are left out. The counts always show.
- **Open** (`j`) opens the pane. **Hide** (`h`) hides the band until a new job starts.
- Focus the band with Ctrl+X, then Tab, or a click before you use its keys. That chord is Claude Code's own `abovePrompt:focus` binding. Release Ctrl before you press Tab, because many terminals read Ctrl+Tab as next tab. In Emacs vterm, eat, or ansi-term, click the band, use `/downrange pane`, or rebind `abovePrompt:focus` with [`/keybindings`](https://code.claude.com/docs/en/keybindings#above-prompt-actions).
- A survey takes the band's place while it shows.
- The option `band` turns the band off.

## The pane

Open the pane with `/downrange pane` or the band's **Open**. In a fullscreen terminal from 110 columns wide, it docks beside the transcript. Elsewhere it sits above the prompt.

- The header repeats the counts and the wakeup, with **Clear finished** (`c`) and **Close** (`x`).
- **Running** lists running jobs, oldest first, in two lines each: the job with its flag and note, then its last output line.
- **Finished** lists up to 20 ended jobs, newest first.
- A progress bar shows when the pane is 60 columns wide or more.
- **Clear finished** removes ended jobs from every view.

```
● build      shell  4m 12s  ▰▰▰▱▱▱▱▱▱▱ 12/40 (30%)  ~6m
  └ Compiling serde v1.0.210
✓ tests      shell  took 1m 12s  exit 0
  └ 120 passed in 71.3s
```

## The `/downrange` command

| Input | Result |
| --- | --- |
| `/downrange` | Prints the status table |
| `/downrange pane` | Opens the pane, or closes it when it is open |
| `/downrange` with anything else | Prints `Usage: /downrange [pane]` |

`/downrange` runs at once, even while Claude works, and costs no model request. It works wherever Claude Code runs commands: the terminal, the desktop app, the VS Code panel, and Agent SDK or stream-json sessions. `claude -p "/downrange"` starts a fresh session with no work, so it prints `No background work right now`. Other headless runs can keep background commands and wakeups alive until they finish.

Claude Code labels command output with `downrange:`. The table lists running jobs (oldest first), then up to 5 jobs that ended in the last 30 minutes (newest first). It holds at most 15 rows. A longer list ends with `+N more: /downrange pane shows all.`

```
2 running · 1 failed · wakeup in 4m 10s (check the deploy)

| | Job | Kind | Age | Progress | ETA | Last output |
| --- | --- | --- | --- | --- | --- | --- |
| ● | review PR | agent | 6m 40s | 14 tools | — | `Bash` · quiet 3m 00s |
| ● | build | shell | 4m 12s | 12/40 (30%) | ~6m | `Compiling serde v1.0.210` |
```

In a terminal narrower than 100 columns, the table has five columns: the kind joins the job, and the ETA joins the progress.

```
| | Job | Age | Progress | Last output |
| --- | --- | --- | --- | --- |
| ● | build (shell) | 4m 12s | 12/40 (30%) · ~6m | `Compiling serde v1.0.210` |
```

Claude reads the table on its next request, as it reads any command output. A subagent row shows only the tool that the subagent last used; the pane shows the tool's input too.

When nothing draws in the session, or the surface cannot show the pane, `/downrange pane` prints `The Jobs pane is not shown here: <reason>.` and the table.

## Reading a row

**Symbols:** `●` running, `✓` completed, `✗` failed, `■` stopped, `◌` ended without a report, `◷` the wakeup.

**Age:** `4m 12s` for a running job. `≥4m 12s` when Downrange first saw the job already running. `took 1m 12s` for an ended job seen from its start. `ended` for other ended jobs. A shell command's age starts when it went to the background, so it leaves out time in the foreground before ctrl+b or a timeout move.

**Progress** is a guess from the last 10 display lines, newest first: a percentage (`45%`), a fraction (`12/40`), or `3 of 7`. A shell's lines come from the end of its output: the last 16,384 characters (UTF-16 code units) of a file up to 4 MiB, or the last 16,384 bytes above that. Values over 100% do not count. A fraction joined to a letter, a dot, a slash, or a dash does not count, so full dates such as `2026/10/11` and most paths and version numbers do not count. These filters are heuristic: a short date such as `10/11` counts as a fraction, and `3 of 7` counts inside a path or a version text such as `version 1.2 of 7.0`. A subagent shows its tool count. A Monitor with no progress shows its event count. An ended job shows its exit code.

**ETA:**

| Text | Meaning |
| --- | --- |
| `~6m` | From the progress rate, after at least 10 seconds of rising progress |
| `finishing` | Progress reached 100% |
| `~2m usual` | No rate yet. Runs of the same command in the same folder usually need about 2 more minutes |
| `usual ~3m` | No rate yet, and the run is past its usual duration of about 3 minutes. In the pane, it turns yellow past 1.5 times that duration |
| `ends in ~18m`, `ending` | A Monitor watch's deadline, when no progress rate gives an ETA. A rate ETA hides the deadline and can run past it |
| `in 4m 10s`, `due now` | The wakeup |

An ETA reads `<1m` under one minute, `~Nm` rounded up under one hour, and `~Hh MMm` from one hour.

A drop from the previous progress sample starts a new phase. The rate estimate waits for ten seconds and one percentage point of gain in that phase. A usual-duration estimate or Monitor deadline can still appear while the new rate develops.

**Flags:**

- `quiet 3m 00s`: a running shell command wrote no output for 2 minutes or more, or a subagent with no tool call in flight was silent that long.
- `3 failed calls in a row`: a subagent's last tool calls failed.

**Notes:**

| Note | Meaning |
| --- | --- |
| `moved after timeout` | The command moved to the background at its timeout |
| `backgrounded by you` | You moved the command to the background |
| `ends with its agent` | The command belongs to a subagent that Claude waits for; it stops when that subagent answers |
| `remote` | A remote subagent |
| `no output file` | The tool result named no output file, so the last line is unavailable |
| `time limit`, `low memory`, `turn limit`, `previous session`, or a failure reason | Why the task ended, from its notification |
| `ended without a report` | The session's task list no longer held the job, and no notification came. When a later list holds the job again, it shows as running again, and a launch note such as `backgrounded by you` returns |
| `ended with its agent` | The same, for a command that stopped with its subagent |
| `output unavailable`, `tail failed` | The output file could not be read. A launch or end note that the job already shows stays in its place, and `claude --debug` shows the read error |

## Usual durations

A shell command that Downrange saw start adds its run time to the history of that command in that folder. This happens when its completion notice arrives while its row still runs and reports exit code 0 or no exit code. The run time starts when the command went to the background, so it leaves out time in the foreground before ctrl+b or a timeout move. Runs of every launch mode share one history. The ETA uses the median of the last 5 runs. The history keeps up to 200 commands under hashed keys and holds no command text, path, or output. It lasts across sessions.

## Answering status prompts locally

With the option `answerStatusPrompts` on, Downrange answers a status prompt itself when all of these hold:

1. You typed it in the terminal's prompt box.
2. Claude is idle.
3. The prompt has no attachments.
4. The whole prompt is a status question, such as `status?`, `what's the status?`, `eta?`, `give me a status update`, or `progress so far?`.
5. A job runs. A pending `/loop` wakeup alone does not count: between iterations, a status question asks about the loop's findings, which only Claude has.

The prompt does not go to Claude. Claude Code shows `Downrange answered this (not sent to Claude). Send it again within 60 s to ask Claude.` and the table. Send the same prompt again within 60 seconds, and it goes to Claude. A prompt typed while Claude works always goes to Claude.

## Options

Set options in `/config`, or under `pluginConfigs["downrange@downrange"].options` in `~/.claude/settings.json`. For a `--plugin-dir` load, the key is `downrange@inline`.

| Option | Default | Effect |
| --- | --- | --- |
| `band` | `true` | Shows the band while work is live |
| `answerStatusPrompts` | `false` | Answers exact status prompts locally, as described above |

A change takes effect at once: Claude Code reloads the mod with the new values.

## Where it runs

| Where | Band | Pane | `/downrange` | Local status answer |
| --- | --- | --- | --- | --- |
| Terminal, fullscreen | Yes | Docked from 110 columns, else above the prompt | Yes | When the option is on |
| Terminal, main screen | Yes | Above the prompt | Yes | When the option is on |
| Desktop app, Code tab | Yes | Yes | Yes | No |
| VS Code panel | No | Not verified; use `/downrange` | Yes | No |
| Agent SDK and stream-json sessions | No | No; `/downrange pane` prints the table | Yes | No |
| Mobile app through Remote Control | No | Not verified; the terminal on your machine shows it | Yes | No |

## `/clear`, `/resume`, and `/branch`

Background work keeps running after these commands. Downrange carries running jobs and the wakeup across them.

## Known limits

- **Only dynamic `/loop` wakeups.** Only wakeups that `ScheduleWakeup` creates appear. Fixed-interval loops such as `/loop 10m` and other cron schedules do not.
- **Other schedules and the wakeup.** Downrange cannot tell which schedule fired a scheduled prompt, or which one-shot schedule in a turn-end snapshot is the wakeup. A prompt of a scheduled task, a routine, or a fixed-interval loop that fires from 5 seconds before the wakeup's due time on clears the wakeup, even before the wakeup's own prompt fires. A cancelled wakeup that only a snapshot can clear stays while any other one-shot schedule remains. It then shows until a scheduled prompt fires near its due time, a new `ScheduleWakeup` result replaces it, or it is 10 minutes past due.
- **Progress read from output.** Progress is a guess from the text. A short date such as `10/11`, `3 of 7` inside a path or a version text such as `version 1.2 of 7.0`, or another ratio or percentage that is not progress, counts as progress and changes the bar and the rate ETA. Full dates such as `2026/10/11` and `10/11/2026` do not count.
- **Only the end of an output.** A direct read of a file up to 4 MiB keeps the last 16,384 characters (UTF-16 code units), which can be up to 48 KiB of non-ASCII text. A tail read above 4 MiB keeps the last 16,384 bytes. Progress and the last line come from that end. Long lines after a progress line can push it out.
- **ETAs during output silence.** When output stops, the bar keeps its last reading, and the rate ETA keeps counting down from the time of that reading. Once the estimate runs out, the ETA stays at `<1m` while the job runs. This holds after `quiet` shows too, so a row can show `20%`, `<1m`, and `quiet 2m 00s` together. A Monitor whose events stop behaves the same way.
- **Monitor deadlines and rate ETAs.** A Monitor watch shows its deadline only when it has no progress-based ETA. Once its progress gives a rate ETA, or reaches 100% and shows `finishing`, the deadline no longer shows. A rate ETA can run past the deadline: a 30-minute watch that goes from 1% to 2% in its first minute shows `~1h 38m`, although its deadline is 29 minutes away.
- **Time in the foreground before a move to the background.** A shell job's clock starts when the Bash call returns its background result. A command that first ran in the foreground, such as one moved at its timeout or with ctrl+b, loses that time. Its age, its `took` time, and the run it adds to the duration history count only the time after the move. For example, a command moved after 2 minutes that ends 1 minute later shows `took 1m 00s` and records 1 minute. Runs of one command in one folder share one history, whatever the launch mode. The next run of that command that starts in the background then shows `~1m usual`, even when it needs 3 minutes, and in the pane it can turn yellow early. A moved run can get a usual-duration ETA that is too long.
- **Duration history after a snapshot end.** A run adds to the duration history only when its completion notice arrives while its row still runs. When a turn-end snapshot already ended the row as `ended without a report`, the later notice marks it completed but adds no duration.
- **Simultaneous duration records.** Two sessions recording durations together can lose new runs, because the duration store has no versioned write. One lost write can hold several runs. When it held a command's first runs, that command keeps no history and shows no usual-duration estimate. Runs stored before both writes began remain, with their estimates.
- **Failed output reads.** While reads of a shell's output fail, its row shows no `quiet` flag and no rate ETA. When a shell job ends, Downrange reads its output one more time. If that read fails, Downrange does not try it again. The job can keep `output unavailable` or `tail failed` and the last line of an earlier read. Only a later ending, or a later notification that names the output file, asks for a new read.
- **Large outputs on Windows.** Outputs over 4 MiB need `tail` on PATH. Without it, such a job shows `tail failed`. A launch or end note that the job already shows, such as `backgrounded by you`, stays in its place; `claude --debug` still shows `cannot tail the output of task <id>`.
- **Tasks first seen in a snapshot.** Claude Code's turn-end snapshot can list a Monitor as a shell. A launch result is the result of the Bash or Monitor call that started a task. A Monitor first seen in a snapshot shows as a shell until its launch result, its first event, or its end notification arrives. Only its launch result gives it a deadline. A shell first seen in a snapshot shows no last line, progress, ETA, or `quiet` flag until its launch result or a notification names its output file. Only its launch result brings a usual-duration ETA. A task that started before Downrange loaded, such as one in a session moved to another process, gets no launch result. Claude Code's internal tasks also appear, under their engine labels, and a long-lived one can keep the band visible. Use **Hide** to dismiss the band.
- **`awaiting confirmation`.** A turn-end snapshot that leaves out a job younger than 10 seconds does not end it. The job keeps running with `awaiting confirmation` until newer input confirms or ends it, such as a later snapshot or a notification. The label does not expire on a timer.
- **Inputs that reach Downrange late.** Claude Code gives its events no shared sequence number. Downrange stamps each input with the time it receives it, and drops an input older than one it already applied to the same job. Hooks can overlap, so an end notification can land after a newer output read, agent list, or snapshot of its job. Downrange then drops the notification: the row keeps running until a later snapshot or agent list ends it. A shell row then shows `ended without a report` and no exit code. An input that Claude Code delivers late counts as new. For example, a Monitor event that arrives after you cleared its finished row brings the row back as running, with a `≥` age, until a later snapshot ends it.
- **Launch details that arrive late.** The same rule applies to launch results. A newer notification, Monitor event, snapshot, or output read of a task can land while Downrange still handles its launch result. Downrange then drops what the launch result adds. A Monitor then shows no deadline, and its age starts with `≥`. A shell can lose its usual-duration ETA, or its output file and launch note too, and that run adds nothing to the duration history. A notification that later names the shell's output file still brings back its last line.
- **Commands that subagents start.** A command with the note `ends with its agent` ends when its subagent answers. It then shows `ended with its agent` and no exit code, unless its own notification arrives later.
- **Agents that wait.** A subagent that the agent list reports as pending, waiting, or idle shows that word beside its tool count. It shows no `quiet` flag and no failed-calls flag, however long it stays in that state.
- **Agents that run elsewhere.** Downrange sees the tool calls only of agents that run in this Claude Code process. A remote subagent keeps `0 tools` and shows `quiet` from 2 minutes after launch, even while it works. A teammate in a terminal pane of its own can show the same. Its notification or a snapshot still ends it.
- **A teammate whose pane closed.** A teammate in a terminal pane of its own writes `running` or `idle` in its team's roster. When that pane closes or dies, the roster keeps the last word. Its notification or a snapshot ends its row, but a later agent list read shows it running again. That read comes at each turn end, and every second while another agent runs. The row can then switch between ended and running, keep the band visible, and show `idle` or `quiet` with no end note. Check the teammate's own pane before you act on the row. Use **Hide** to dismiss the band.
- **A session moved to another process.** `/background` and a hand-off to the desktop app start a fresh process that resumes the conversation. Downrange starts empty there. Running tasks return at the next turn end, with `≥` ages and no last line. A shell's notification can still name its output file, end it, and show its last line. The `/loop` wakeup returns only with the next `ScheduleWakeup` result.
- **Changes during `/clear`, `/resume`, or `/branch`.** Downrange carries the jobs and the wakeup as it last wrote them before the old session ended. An update that lands during the change, such as a launch or a notification, can be lost. A later turn-end snapshot then adds a lost running task, with a `≥` age, and ends a task that left its list, as `ended without a report`. Downrange remembers the last 2,000 tasks that left its list, and forgets the oldest first. A task does not count toward the 2,000 while it is back in the list. These commands carry that memory to the next session. A finished job leaves the list through **Clear finished**, through the 20-job limit of **Finished**, or when you leave its session with one of these commands, which carry only running jobs. After `/resume`, a job that the resumed session last showed running can return, if 2,000 other tasks left the list after it, counted across all later sessions. The job shows `ended without a report`, or shows as running until the next turn end.
- **Another identity for the mod.** Claude Code keeps the duration history per plugin identity, `<plugin>@<marketplace>`. Installed from the `downrange` marketplace, Downrange is `downrange@downrange`. Loaded with `--plugin-dir`, it is `downrange@inline`. A copy under another identity, such as one installed from another marketplace, keeps a separate history, which starts empty. It shows no usual-duration ETA until it records runs of its own. The jobs and the wakeup live in session state under the plugin name `downrange`. A build under another plugin name cannot read them, so it starts with no jobs and no wakeup. A later turn-end snapshot brings running tasks back, with `≥` ages. The `/loop` wakeup returns only with the next `ScheduleWakeup` result.
- **Quoted failure text in task descriptions.** A failed or stopped task's description can contain quoted text followed by `failed:` or `was stopped:`, such as `Investigate "build" failed: exit code 2`. If Downrange first sees the task at its end, it can mistake description text for the end details. This also happens when an already tracked task's title was shortened or cleaned. The band, pane, and `/downrange` can show an incorrect title or exit code; end notes can hide the actual cause. Check the full task notification in the transcript before acting on those details. Use short task descriptions without quoted failure phrases to avoid this ambiguity.

## Troubleshooting

Run `claude --debug`, or `claude --debug-file <file>`, and search for `downrange:`. Each line names the event and the cause. The table below leaves out the `downrange: ` prefix.

| Message | Meaning | What to do |
| --- | --- | --- |
| `<hook>: hook throw: …` or `<hook>: hook timeout: …` | A hook failed, such as `tool.call{tool=Bash}`. Handlers other than `/downrange` and the Jobs pane pass the event on unchanged | Report a bug with the line |
| `session.start: /downrange was not registered: …` | Claude Code rejected command registration; a built-in name conflict is one possible cause | Read the appended cause. Open the pane with the band's **Open** |
| `state.get: unsupported or invalid jobs state; reset safely` or `unsupported or invalid wakeup state; reset safely` | The stored format is unknown or invalid | Running tasks can return through snapshots; a new wakeup result restores its countdown |
| `tool.call: no output file in the result of task <id>; …` | The tool result named no output file | Nothing. The job shows without a last line |
| `clock.every: cannot read the output of task <id>: …` | The output file is gone or unreadable | Nothing. Reads try again while the job runs |
| `clock.every: cannot tail the output of task <id>: …` | `tail` failed on an output over 4 MiB | Check that `tail` is on PATH |
| `clock.every: cannot list agents: …` | The agent list failed | Nothing. Agent states update after the next good list |
| `tool.call: duration history unavailable: …` | The history lookup failed for this launch; its usual-duration estimate stays unavailable | Recovery benefits later launches |
| `prompt.submit: duration history unavailable: …` or `session.append: duration history unavailable: …` | Recording a completed run failed; that sample is lost, but existing estimates remain | Recovery benefits later recordings |
| `<event>: duration history had the wrong shape; …` | The stored history was damaged | Nothing. The next record replaces it |
| `command.run: the Jobs pane was not placed: …` | Nothing draws in this session, or the surface does not show this pane | Use `/downrange` |
| `command.run: the Jobs pane could not be toggled: …` | Opening or closing the pane failed | Use `/downrange` |
| `ui.press: <button> failed: …` | A band or pane button failed | Try again. Report a bug if it fails again |
| `ui.press: the Jobs pane waits: …` | The pane is open, but the attached app places no panes | Use `/downrange`, or attach a surface that places panes |
| `clock.every: <message>` | One update failed | Nothing. Report a bug if the line repeats |
| `clock.every: the ticker stopped (a period was refused); started it again` | Another mod refused a timer period | Nothing. Check your other mods if updates stall |
| `prompt.submit: a task notification held no complete <task-notification> block; …` | A notice contained an opening tag without a complete block | Report a bug with the line. Jobs still end at turn end |
| `prompt.submit: unknown notification status "<word>" for task <id>` | A notification used a status word Downrange does not know | Report a bug with the line. The job ends at turn end |
| `<event>: no background_tasks in the hook input; …` | This Claude Code build sends no task list | Nothing. Jobs still end through notifications |
| `<event>: no session_crons in the hook input; …` | This Claude Code build sends no scheduled-task list | Nothing. A cancelled wakeup clears 10 minutes past due |
| `clock.every: refused to read <path>: …` | A stored output path did not match its task | Report a bug |

Plain-text Claude Code notices have no structured task status. Downrange ignores them without a diagnostic; a later task snapshot supplies the end.

The command and pane answer failures directly:

| Response | Meaning | What to do |
| --- | --- | --- |
| `/downrange could not run: hook <throw\|timeout>: <message>.` | The command handler failed before it could answer | Retry `/downrange`. Report the response and matching `command.run{command=downrange}` diagnostic if it repeats |
| `The Jobs pane could not draw: hook <throw\|timeout>: <message>` | The pane render handler failed | Use `/downrange`. Report the response and matching `ui.render{component=Pane, requestId=downrange}` diagnostic if it repeats |

Here `<throw|timeout>` means either `throw` or `timeout`.

Hook failures, `/downrange` registration failures, and button problems also show in the transcript as dim lines. Claude does not read them.
