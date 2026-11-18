import { atom, read, update } from 'claude-code'
import type { Caught, CommandRunResult, EngineInterface, HookFailure, Register, Timer } from 'claude-code'

import type { AgentJob, Job, JobsState, ShellJob, Wakeup, WakeupState } from '../types'
import { bandTree, failedPaneTree, paneTree } from './drawing'
import { durationsOf, historyKeyOf, recorded, usualOf } from './history'
import type { Durations } from './history'
import {
  activityClosed,
  activityEnded,
  activityOf,
  activityStarted,
  agentJob,
  agentsSynced,
  closedRuns,
  finalIdsOf,
  finishedCleared,
  finishedRuns,
  historyAdded,
  isLive,
  isRunning,
  launched,
  monitorJob,
  noticed,
  noticeProblemOf,
  observedJobs,
  readFailed,
  readsDue,
  reconciled,
  reloaded,
  shellJob,
  ownerAnswered,
  shellLaunchNote,
  stoppedJob,
  tailRead,
  viewedJobs,
  wakeupAfterSnapshot,
  wakeupAfterTick,
  wakeupAfterTrigger,
  wakeupOf,
  workflowJob,
} from './jobs'
import type { HistoryRun, JobObservation, SnapshotTask, TailRead } from './jobs'
import {
  BARE_RESULT_MS,
  DELIVERED_MAX,
  EARLY_AGENTS_MAX,
  EARLY_ROWS_MAX,
  EARLY_ROWS_MS,
  FIRST_HOLD_MS,
  FIRST_WAIT_MS,
  FLUSH_WAIT_MS,
  FS_READ_MAX,
  INPUTS_MAX,
  LOOKUP_DELAYS_MS,
  LOOKUP_LAST,
  MAX_SESSIONS,
  MIRROR_WAIT_MS,
  MONITOR_TIMEOUT_MAX_MS,
  OPEN_CALL_MS,
  OPEN_CALLS_MAX,
  REPEAT_WINDOW_MS,
  TAIL_TIMEOUT_MS,
  TICK_MS,
  TICKER_STALE_MS,
  WAITING_MAX,
} from './limits'
import { noticesOf } from './notices'
import { closingCodeOf, displayLinesOf, isOutputFileOf, jobBytesOf, jobLinesOf, oneLine, outputEndOf, outputFileOf } from './output'
import { jobsStateOf, wakeupStateOf } from './state'
import { isStatusPrompt, normalizePrompt } from './prompt'
import { redirectFileOf, redirectTargetOf } from './redirect'
import { backgroundIdOf, callInputOf, earlyKept, isBackgroundText, isFields, isResultListed, monitorIdOf, numberOf, resultsOf, stringOf, teammateIdOf, toolResultsOf, toolUsesOf, waitingTextOf } from './rows'
import type { Fields, RowCall } from './rows'
import { bandHintOf, bandOf, isBandHidden, paneModelOf, tableOf } from './view'

/** The slash command, without its slash; declared here so that `claude plugin validate` resolves the matcher. */
const COMMAND = 'downrange'
/** The pane's id, and the requestId its render hook matches. */
const PANE_ID = 'downrange'
/** The pane's tab title. */
const PANE_TITLE = 'Jobs'

const JOBS = atom({ plugin: 'downrange', key: 'jobs' } as const, { items: [], observed: [], removed: [], snapshotAt: null }, { shape: 'v8' })
const WAKEUP = atom({ plugin: 'downrange', key: 'wakeup' } as const, { pending: null, updatedAt: null }, { shape: 'v4' })
const BAND_HIDDEN_AT = atom({ plugin: 'downrange', key: 'bandHiddenAt' } as const, null)
const LAST_ANSWERED = atom({ plugin: 'downrange', key: 'lastAnswered' } as const, null)

/** The buttons of the band and the pane. */
type Control = 'Open' | 'Hide' | 'Clear finished' | 'Close'
/** A hook that waits for a mirror write: told when the write lands, or why it failed. */
type Waiter = { landed: () => void; failed: (error: unknown) => void }
/** A mirror write, under way or next in line, and the hooks that wait for it. */
type Write = { waiters: Set<Waiter> }
/** One hook's bound on its waits for the mirror: its timer, whether it passed, and how each wait leaves at it. */
type Deadline = { timer: Timer | null; isPassed: boolean; leaves: Set<() => void> }

const NO_JOBS: JobsState = { items: [], observed: [], removed: [], snapshotAt: null }
const NO_WAKEUP: WakeupState = { pending: null, updatedAt: null }

/** Keys of diagnostics already shown; a reload re-arms them on purpose. */
const reported = new Set<string>()

/** The ticker's timer; a reload drops it, and session.start starts a new one. */
let ticker: Timer | null = null
/** Guards against overlapping refreshes inside one module instance. */
let isTicking = false
/** When the ticker last ran a period, or started; an old time means a refused period ended it. */
let lastTickAt = 0
/**
 * The process's jobs and wakeup, the source of truth. Background work belongs to the process, so every session of the
 * process shows it, and /clear, /resume, and /branch do not touch it. Each hook changes it at once; `$.state` holds a
 * mirror of the current session's view of it, for drawing (see mirrored).
 */
const memory: { jobs: JobsState; wakeup: WakeupState } = { jobs: NO_JOBS, wakeup: NO_WAKEUP }
/** The current session's `since`: its Finished shows the jobs that ended from then on (see viewNow). */
let since = -Infinity
/** The `since` of each session that this process showed, by session id: the MAX_SESSIONS most recent, oldest first. */
const sessions = new Map<string, number>()
/** When the last /clear, /resume, or /branch ended a session. */
let switchedAt: number | null = null
/**
 * The /clear, /resume, or /branch that session.end began, until the mod knows the new session: the end's reason and the
 * session that ended. classic.SessionStart settles it; where no classic.* event reaches the mod, switched does.
 */
let pending: { reason: 'clear' | 'resume'; ended: string } | null = null
/**
 * The mirror: the read of it into memory at a load of the module (see loaded), the write under way, the one after it,
 * which holds every change made meanwhile, whether the last write failed, and the write that carries the latest settle
 * of a switch, until that write lands or fails (see settleLanded).
 */
const mirror: { load: Promise<void> | null; isLoaded: boolean; writing: Write | null; next: Write | null; isBehind: boolean; settle: Write | null } =
  { load: null, isLoaded: false, writing: null, next: null, isBehind: false, settle: null }
/**
 * The last history record; each record waits for it, so two in one session never overwrite each other. Two sessions
 * can still race, because the store has no versioned write; a lost record costs every run it held, a new key's first too.
 */
let historyWrites: Promise<void> = Promise.resolve()
/** The `genericRatios` option, which register sets: any ratio in output counts as progress, not only a known format. */
let isAnyRatio = false

/** The tools whose finished calls start, stop, or set work: their result rows reach applyCall. */
const CALL_TOOLS: ReadonlySet<string> = new Set(['Bash', 'Monitor', 'Agent', 'Workflow', 'ScheduleWakeup', 'TaskStop'])
/** The tool that runs a Code Mode script: a subagent's script is in flight, but counts no tool. */
const SCRIPT_TOOL = 'REPL'
/** A result row that waits for its stored result: the response row to read on from, the reads made, and when the next one is due. */
type Waiting = { call: RowCall; after?: string; tries: number; due: number }
/** One step of a subagent's tool activity, from its rows: a call starts, or its result row comes. */
type Activity = { kind: 'start'; id: string; summary: string; isCounted: boolean; at: number } | { kind: 'end'; id: string; isFailure: boolean; at: number }
/** One read of `$.session.messages()`: whose conversation, and which part of it. */
type TranscriptArgs = { agentId?: string; after?: string; last?: number }
/**
 * The tool calls that reach the mod as transcript rows (see resultApplied), in module memory only: a reload empties it.
 * `inputs` holds the tool, input, and response row of each call of a tracked tool until its result row comes, `waiting`
 * the result rows that wait for their stored result, `timer` the next due read, `ranged` whether `$.session.messages()`
 * took `after` and `last` (undefined until a read answers), `delivered` the tool use ids that applied, `open` each
 * tracked agent's calls in flight, `early` the activity rows of agents whose launch has not landed yet, EARLY_ROWS_MS at
 * most, and `earlyTimer` the timer that drops them.
 */
const rows = {
  inputs: new Map<string, { tool: string; input: Fields; uuid: string }>(),
  waiting: new Map<string, Waiting>(),
  timer: null as Timer | null,
  timerAt: 0,
  ranged: undefined as boolean | undefined,
  delivered: new Set<string>(),
  open: new Map<string, Map<string, { at: number; isCounted: boolean }>>(),
  early: new Map<string, Activity[]>(),
  earlyTimer: null as Timer | null,
}

/** A `tail` that could not start, timed out, or exited non-zero. */
class TailFailure extends Error {
  constructor(message: string, readonly bytes: number) {
    super(message)
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A stat, read, or tail of a job's redirect file that failed, with that failure, and the code on the closing line of the output file read before it. */
class RedirectFailure extends Error {
  constructor(readonly failure: unknown, readonly exitCode: number | undefined) {
    super(messageOf(failure))
  }
}

/** A hook failure as one phrase: `hook throw: <message>`. */
function failureText(failure: HookFailure): string {
  return `hook ${failure.kind}: ${failure.message ?? 'no message'}`
}

/** A failed hook, named by its label, goes to the transcript the first time, then to the debug log. */
function reportHook($: EngineInterface, hook: string, failure: HookFailure): void {
  const key = `hook|${hook}`
  const isFirst = !reported.has(key)
  reported.add(key)
  $.ui.log(`${isFirst ? 'downrange: ' : ''}${hook}: ${failureText(failure)}`, { to: isFirst ? 'transcript' : 'debug' })
}

/** Whether a hook failed by re-entry. Claude Code 2.1.309 and earlier report this kind; the 2.1.310 types no longer name it. */
function isReentry(failure: HookFailure): boolean {
  return (failure.kind as string) === 're-entry'
}

/** What the `.catch` of a hook that only watches does: it reports the failure under the hook's label and passes the event on unchanged. */
function passOn<I, R>($: EngineInterface, label: string, e: I, next: ((e: I) => R) & Caught): R {
  if (!isReentry(next.error)) reportHook($, label, next.error)
  return next(e)
}

/** Logs the event and cause once per key; the debug sink supplies the plugin name. */
function report($: EngineInterface, event: string, cause: string, once: string): void {
  const key = `${event}|${once}`
  if (reported.has(key)) return
  reported.add(key)
  $.ui.log(`${event}: ${cause}`, { to: 'debug' })
}

/** Starts the ticker, or starts it again (and logs once) when no period ran for TICKER_STALE_MS; a tick stops it when nothing is live. */
async function ensureTicker($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  if (ticker !== null && now - lastTickAt < TICKER_STALE_MS) return
  if (ticker !== null) {
    ticker.cancel()
    report($, 'clock.every', 'the ticker stopped (a period was refused); started it again', 'restart')
  }
  lastTickAt = now
  ticker = $.clock.every(TICK_MS, () => {
    void tick($)
  })
}

/**
 * The current session's view of the process's data: every running job, the ended jobs from its `since` on with a
 * removal for each other one (see viewedJobs), and the wakeup.
 */
function viewNow(): { jobs: JobsState; wakeup: WakeupState } {
  return { jobs: viewedJobs(memory.jobs, since), wakeup: memory.wakeup }
}

/** One write of the mirror: the view as it stands when the write begins, the jobs, then the wakeup. */
async function writeMirror($: EngineInterface): Promise<void> {
  const shown = viewNow()
  await $.state.set({ plugin: 'downrange', key: 'jobs' }, { shape: 'v8', value: shown.jobs })
  await $.state.set({ plugin: 'downrange', key: 'wakeup' }, { shape: 'v4', value: shown.wakeup })
}

/**
 * Begins a mirror write, for the hooks that wait for it. When it ends, one listener tells each of them, and the write
 * after it, which holds every change made meanwhile, begins with its own waiters. A failed write leaves the mirror
 * behind until a later write lands (see refresh).
 */
function begun($: EngineInterface, write: Write = { waiters: new Set() }): Write {
  mirror.writing = write
  const ended = (failure: { error: unknown } | null): void => {
    mirror.writing = null
    if (mirror.settle === write) mirror.settle = null
    mirror.isBehind = failure !== null
    for (const waiter of write.waiters) {
      if (failure === null) waiter.landed()
      else waiter.failed(failure.error)
    }
    write.waiters.clear()
    const next = mirror.next
    if (next !== null) {
      mirror.next = null
      begun($, next)
    }
  }
  writeMirror($).then(() => ended(null), (error: unknown) => ended({ error }))
  return write
}

/** The write that holds the data as it stands now: a new write when none runs, else the one after the write under way. */
function carrying($: EngineInterface): Write {
  if (mirror.next !== null) return mirror.next
  if (mirror.writing === null) return begun($)
  mirror.next = { waiters: new Set() }
  return mirror.next
}

/** A new bound for one hook's waits for the mirror (see waited). */
function deadlineOf(): Deadline {
  return { timer: null, isPassed: false, leaves: new Set() }
}

/**
 * Waits until `write` lands, until the hook's deadline at most. The deadline starts at the hook's first wait and holds
 * for every wait of that hook, so one hook waits MIRROR_WAIT_MS at most in all. At the deadline the hook leaves the
 * write's waiters, so a write that does not answer keeps nothing of it; the deadline's timer ends by itself then.
 */
function waited($: EngineInterface, write: Write, deadline: Deadline): Promise<void> {
  if (deadline.isPassed) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const leave = (): void => {
      write.waiters.delete(waiter)
      resolve()
    }
    const waiter: Waiter = {
      landed: () => {
        deadline.leaves.delete(leave)
        resolve()
      },
      failed: error => {
        deadline.leaves.delete(leave)
        reject(error)
      },
    }
    write.waiters.add(waiter)
    deadline.leaves.add(leave)
    deadline.timer ??= $.clock.after(MIRROR_WAIT_MS, () => {
      deadline.isPassed = true
      for (const left of deadline.leaves) left()
      deadline.leaves.clear()
    })
  })
}

/**
 * Writes the current session's view to the mirror after a change, and waits until a write that holds the change has
 * landed: a reload right after the hook keeps the change. One write runs at a time, so the writes land in the order they
 * began: a write that began before a switch lands before the write that classic.SessionStart asks for. A change while a
 * write runs asks for one more write after it, which holds every change made meanwhile: a burst costs at most two
 * writes, and the last write holds the current data. The hook's deadline bounds the wait (see waited): past it, the
 * change stays in memory, and a later write or tick writes it. The write of a settle of a switch stays in
 * `mirror.settle` until it lands or fails, past the deadline too (see settleLanded).
 */
async function mirrored($: EngineInterface, deadline: Deadline, isSettle = false): Promise<void> {
  if (!mirror.isLoaded) await loaded($)
  const write = carrying($)
  if (isSettle) mirror.settle = write
  await waited($, write, deadline)
}

/**
 * Mirrors a change that memory took (see mirrored); `isSettle` marks the view that a settle of a switch gave. A failed
 * write is no failure of the hook: memory holds the change, so what follows it in the hook still runs, the ticker
 * writes the mirror again, and the failure reports to the transcript the first time, then to the debug log.
 */
async function persisted($: EngineInterface, deadline: Deadline, isSettle = false): Promise<void> {
  try {
    await mirrored($, deadline, isSettle)
  } catch (error) {
    const isFirst = !reported.has('mirror')
    reported.add('mirror')
    $.ui.log(`${isFirst ? 'downrange: ' : ''}state.set: cannot write the copy of the session's view: ${messageOf(error)}; the next tick writes it again`, { to: isFirst ? 'transcript' : 'debug' })
  }
}

/**
 * Applies an observation to the process's jobs by the ordering rule, then mirrors them; the result tells whether they
 * changed. In a module that has not read the mirror yet, the observation waits for that read (see loaded).
 */
async function writeJobs($: EngineInterface, deadline: Deadline, input: JobObservation, change: (jobs: Job[]) => Job[] = jobs => jobs): Promise<boolean> {
  if (!mirror.isLoaded) await loaded($)
  const before = memory.jobs
  memory.jobs = observedJobs(before, input, change)
  const isChanged = memory.jobs !== before
  // What follows the change runs whether or not the mirror write lands: the ticker, which reads outputs and writes a
  // mirror that fell behind, and the rest of the hook.
  if (isChanged) await persisted($, deadline)
  await ensureTicker($)
  return isChanged
}

/** The wakeup state after a write at `now`: an older write never replaces a newer one. */
function wakeupWritten(state: WakeupState, now: number, change: (wakeup: Wakeup | null) => Wakeup | null, isReplacement: boolean): WakeupState {
  if (state.updatedAt !== null && now < state.updatedAt) return state
  const pending = change(state.pending)
  return isReplacement || pending !== state.pending ? { pending, updatedAt: now } : state
}

/** Sets the process's wakeup, and preserves the latest wakeup cancellation, then mirrors it; it waits, reports, and starts the ticker as writeJobs does. */
async function writeWakeup($: EngineInterface, deadline: Deadline, now: number, change: (wakeup: Wakeup | null) => Wakeup | null, isReplacement = false): Promise<void> {
  if (!mirror.isLoaded) await loaded($)
  const before = memory.wakeup
  memory.wakeup = wakeupWritten(before, now, change, isReplacement)
  if (memory.wakeup !== before) await persisted($, deadline)
  await ensureTicker($)
}

/**
 * Memory after a load of the module. A reload of the mod starts module variables empty, keeps `$.state`, and fires
 * session.start again. So the first session.start, the first change of memory, or the first mirror write, whichever
 * comes first, reads the mirror into memory, once. Each change waits for that read and applies on top of it, and no
 * mirror write goes out before it: the mirror is never written from empty memory over its own data. A failed read is
 * tried again at the next change. A later session.start of the same module keeps memory.
 */
function loaded($: EngineInterface): Promise<void> {
  mirror.load ??= seeded($).catch((error: unknown) => {
    mirror.load = null
    throw error
  })
  return mirror.load
}

/**
 * Starts memory from the mirror, which holds the current session's view: its running jobs, its ended jobs, the removals,
 * and the wakeup (Hide stays in its own atom). No change of memory runs before it ends (see loaded). A stored shape to
 * update, an invalid value, and rows that the current options change go back to the mirror at once; with none of
 * them, nothing is written.
 */
async function seeded($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  const [storedJobs, storedWakeup] = await Promise.all([$.state.get({ plugin: 'downrange', key: 'jobs' }), $.state.get({ plugin: 'downrange', key: 'wakeup' })])
  const jobs = jobsStateOf(storedJobs.value)
  if (storedJobs.value !== undefined && jobs === undefined) report($, 'state.get', 'unsupported or invalid jobs state; reset safely', 'jobs-shape')
  const wakeup = wakeupStateOf(storedWakeup.value)
  if (storedWakeup.value !== undefined && wakeup === undefined) report($, 'state.get', 'unsupported or invalid wakeup state; reset safely', 'wakeup-shape')
  memory.jobs = jobs ?? NO_JOBS
  memory.wakeup = wakeup ?? NO_WAKEUP
  // After a reload, as a change of genericRatios or an update causes, rows follow the current option. They keep their
  // observation times: an input that came after the reload, before this read ended, is judged by them, not by the read.
  const items = reloaded(memory.jobs.items, isAnyRatio, now)
  const isReloaded = items.some((job, index) => job !== memory.jobs.items[index])
  if (isReloaded) memory.jobs = { ...memory.jobs, items }
  const isJobsOld = storedJobs.value !== undefined && (jobs === undefined || storedJobs.value.shape !== 'v8')
  const isWakeupOld = storedWakeup.value !== undefined && (wakeup === undefined || storedWakeup.value.shape !== 'v4')
  mirror.isLoaded = true
  // The new shape goes to the mirror; the hook that waits for the read waits for its own change, not for this write.
  if (isReloaded || isJobsOld || isWakeupOld) carrying($)
}

/**
 * Settles a /clear, /resume, or /branch that no classic.SessionStart settled yet. Under managed settings or a Team or
 * Enterprise login, Claude Code's built-in guard keeps every classic.* event from the mod, and session.start does not
 * fire again. So each hook other than session.start, session.end, classic.SessionStart, and the render hooks calls this
 * first, and so does each tick. A zero-delay timer that session.end starts calls it once at once, before the first tick
 * (see settledAtOnce). A command.run hook for every command calls it before the command runs, and a config.set hook for
 * every key before the row changes, so that a reload of the mod that a command, such as /reload-plugins, or a change of
 * an option causes finds the view in `$.state`. Both then wait for the write of a settle that is under way, and write
 * the view once more when the last write failed (see settleLanded). Once `$.session.id()` answers an id other than the
 * ended session's, that id is the new session, once. After a /clear it starts at the switch. After a /resume or a /branch, which the mod cannot tell apart here, a session
 * that this process showed keeps its start, and any other starts at the switch, as classic.SessionStart starts it.
 * Until then the view is the safe one that session.end set: every running job, the wakeup, and no job that ended before
 * the switch. Each call writes the view, because a write that landed before the engine reset `$.state` is gone. With a
 * personal login, `$.session.id()` still answers the parent during and before classic.SessionStart on /branch, so no
 * call settles a branch before that event does.
 */
async function switched($: EngineInterface, deadline: Deadline): Promise<void> {
  const switching = pending
  if (switching === null) return
  const id = await $.session.id().catch(() => undefined)
  // classic.SessionStart, another hook, or a newer switch came meanwhile.
  if (pending !== switching) return
  const isSettled = id !== undefined && id !== switching.ended
  if (isSettled) {
    pending = null
    entered(id, (switching.reason === 'resume' ? sessions.get(id) : undefined) ?? switchedAt ?? since)
  }
  await persisted($, deadline, isSettled)
  await ensureTicker($)
}

/**
 * Waits until the write that carries the latest settle of a switch lands, until the hook's deadline at most (see
 * waited). A settle clears `pending` before its write lands, so a call of switched that comes meanwhile, or whose read
 * of the session id was under way, returns before that write lands. The command.run hook for every command and the
 * config.set hook call this after switched, because a command or a change of an option can reload the mod, and the
 * reload must find the new session's view in `$.state`. With no settle in progress, it waits for nothing and asks
 * nothing. A failed write is no failure of the hook here. When the last mirror write failed, a settle's write or any
 * other, both hooks then write the view once more, within the same deadline (see persisted): a reload that comes
 * before the next tick still finds the view. With no write behind, they write nothing.
 */
async function settleLanded($: EngineInterface, deadline: Deadline): Promise<void> {
  const write = mirror.settle
  if (write === null) return
  await waited($, write, deadline).catch(() => undefined)
}

/**
 * The settle that session.end asks for at once, on a zero-delay timer, because the first tick can be a second away
 * (see switched). When the engine reset `$.state` before the timer fires, a reload that no event comes before, such as
 * one after an edit of a settings file, finds the view there. When it resets `$.state` after that, and the switch still
 * waits, the next tick at the latest writes the view again. A failure logs once per message, as a tick's does.
 */
async function settledAtOnce($: EngineInterface): Promise<void> {
  try {
    await switched($, deadlineOf())
  } catch (error) {
    report($, 'clock.after', messageOf(error), `after|${messageOf(error)}`)
  }
}

/** Makes session `id` the current one from `at` on, and keeps the MAX_SESSIONS most recent sessions. */
function entered(id: string | undefined, at: number): void {
  since = at
  if (id === undefined) return
  sessions.delete(id)
  sessions.set(id, at)
  for (const oldest of sessions.keys()) {
    if (sessions.size <= MAX_SESSIONS) break
    sessions.delete(oldest)
  }
}

/** The stored durations; a value of the wrong shape counts as empty and logs once. */
async function storedDurations($: EngineInterface, event: string): Promise<Durations> {
  const durations = durationsOf(await $.store.get('durations'))
  if (durations !== undefined) return durations
  report($, event, 'duration history had the wrong shape; the next record replaces it', 'history-shape')
  return {}
}

/** The history key and usual duration for a launch; a failure gives neither, logs once, and never stops the launch. */
async function historyFor($: EngineInterface, command: string): Promise<{ historyKey: string; usualMs?: number } | undefined> {
  try {
    const historyKey = await historyKeyOf(await $.session.cwd(), command)
    return { historyKey, usualMs: usualOf(await storedDurations($, rowLabel('Bash')), historyKey) }
  } catch (error) {
    report($, rowLabel('Bash'), `duration history unavailable: ${messageOf(error)}`, 'history-get')
    return undefined
  }
}

/**
 * The redirect file of a launch, absolute in the session's folder, or undefined. A subagent's command follows only an
 * absolute path: a subagent can run in a folder of its own. A failure gives none, logs once, and never stops the launch.
 */
async function redirectFor($: EngineInterface, id: string, command: string, agentId: string | undefined): Promise<string | undefined> {
  try {
    const target = redirectTargetOf(command)
    if (target === undefined || (agentId !== undefined && !target.startsWith('/'))) return undefined
    return redirectFileOf(target, await $.session.cwd())
  } catch (error) {
    report($, rowLabel('Bash'), `cannot place the redirect file of task ${id}: ${messageOf(error)}`, `redirect|${id}`)
    return undefined
  }
}

/** The diagnostic label of a tool's rows. */
const rowLabel = (tool: string): string => `session.append (${tool})`

/** Drops the oldest entries of a map or a set while it holds more than `max`. */
function capped(entries: { readonly size: number; keys(): IterableIterator<string>; delete(key: string): boolean }, max: number): void {
  for (const oldest of entries.keys()) {
    if (entries.size <= max) break
    entries.delete(oldest)
  }
}

/** Waits for `work`, `ms` at most; a failure of the work logs once per message under `event`. */
function within($: EngineInterface, event: string, ms: number, work: Promise<void>): Promise<void> {
  return new Promise<void>(resolve => {
    const timer = $.clock.after(ms, () => resolve())
    work.then(
      () => {
        timer.cancel()
        resolve()
      },
      (error: unknown) => {
        timer.cancel()
        report($, event, `a read of stored tool results failed: ${messageOf(error)}`, `rows|${messageOf(error)}`)
        resolve()
      },
    )
  })
}

/**
 * Whether a call needs its stored result: not a failed call, which changes nothing; not a call with no text, such as a
 * successful call inside a Code Mode script, whose result the transcript does not store; and not a Bash call whose text
 * does not say that it runs in the background.
 */
function needsResult(call: RowCall): boolean {
  if (call.isError || call.text === '') return false
  return call.tool !== 'Bash' || isBackgroundText(call.text)
}

/** A response row or a result row of a loop, as the session.append hook passes it on. */
type Row = { uuid: string; agentId?: string; tool?: string; content: unknown }

/**
 * Applies a response row: it keeps the fields of the input of each call of a tracked tool (CALL_TOOLS) that its change
 * reads (see callInputOf) until the call's result row comes. A subagent's response row also starts its calls (see
 * activityRow); `at`, the row's time, is set for it.
 */
async function responseApplied($: EngineInterface, deadline: Deadline, row: Row, at: number | null): Promise<void> {
  for (const use of toolUsesOf(row.content)) {
    if (CALL_TOOLS.has(use.name)) {
      rows.inputs.set(use.id, { tool: use.name, input: callInputOf(use.name, use.input), uuid: row.uuid })
      capped(rows.inputs, INPUTS_MAX)
    }
    if (row.agentId !== undefined && at !== null) await activityRow($, deadline, row.agentId, { kind: 'start', id: use.id, summary: activityOf(use.name, use.input), isCounted: use.name !== SCRIPT_TOOL, at })
  }
}

/**
 * Applies a result row that came at `now`: it hands each call of a tracked tool to applyCall, at once when its text is
 * enough, else after reads of its stored result, the first one now and the others on a timer (see lookedUp). A call
 * that waits keeps only the parts of its text that applyCall reads (see waitingTextOf). A subagent's result row also ends
 * its calls (see activityRow).
 */
async function resultApplied($: EngineInterface, deadline: Deadline, row: Row, now: number): Promise<void> {
  const ready: RowCall[] = []
  for (const block of toolResultsOf(row.content)) {
    if (row.agentId !== undefined) await activityRow($, deadline, row.agentId, { kind: 'end', id: block.id, isFailure: block.isError, at: now })
    const kept = rows.inputs.get(block.id)
    rows.inputs.delete(block.id)
    const tool = row.tool !== undefined && row.tool !== 'unknown' ? row.tool : kept?.tool
    if (tool === undefined || !CALL_TOOLS.has(tool) || rows.delivered.has(block.id) || rows.waiting.has(block.id)) continue
    const call: RowCall = { id: block.id, tool, input: kept?.input ?? {}, text: block.text, isError: block.isError, at: now, ...(row.agentId === undefined ? {} : { agentId: row.agentId }) }
    if (!needsResult(call)) {
      ready.push(call)
      continue
    }
    rows.waiting.set(call.id, { call: { ...call, text: waitingTextOf(tool, call.text) }, ...(kept === undefined ? {} : { after: kept.uuid }), tries: 0, due: now })
    // Past the cap, the oldest row goes on with its text only.
    for (const [id, oldest] of rows.waiting) {
      if (rows.waiting.size <= WAITING_MAX) break
      rows.waiting.delete(id)
      ready.push(oldest.call)
    }
  }
  await delivered($, deadline, ready)
  if (rows.waiting.size > 0) await lookedUp($, deadline, 'due', 'session.append')
}

/** One read of `$.session.messages()`: the rows, or the cause when it failed or answered a deny. */
async function messagesOf($: EngineInterface, args: TranscriptArgs): Promise<{ rows: unknown[] } | { cause: string }> {
  try {
    const answer: unknown = await $.session.messages(args)
    if (Array.isArray(answer)) return { rows: answer }
    return { cause: isFields(answer) && typeof answer.deny === 'string' ? answer.deny : 'the answer held no rows' }
  } catch (error) {
    return { cause: messageOf(error) }
  }
}

/** Logs once per event that no form of a read of stored results answered rows, with the cause of the last form. */
function unread($: EngineInterface, event: string, answer: { rows: unknown[] } | { cause: string }): void {
  if ('cause' in answer) report($, event, `could not read stored tool results: ${answer.cause}`, 'messages')
}

/**
 * The stored rows of an agent's conversation, or of the main one: the rows after the response row `after`, else the
 * newest LOOKUP_LAST, else the whole conversation on a build that takes neither. The first answer tells which the build
 * takes. A form that the build refuses logs nothing; a read that no form answered logs once per event (see unread).
 */
async function transcriptOf($: EngineInterface, event: string, agentId: string | undefined, after: string | undefined): Promise<unknown[] | undefined> {
  const scope: TranscriptArgs = agentId === undefined ? {} : { agentId }
  let answer: { rows: unknown[] } | { cause: string } | undefined
  if (rows.ranged !== false) {
    if (after !== undefined) answer = await messagesOf($, { ...scope, after })
    if (answer === undefined || 'cause' in answer) answer = await messagesOf($, { ...scope, last: LOOKUP_LAST })
    if ('rows' in answer) rows.ranged = true
  }
  if ((answer === undefined || 'cause' in answer) && rows.ranged !== true) {
    answer = await messagesOf($, scope)
    if ('rows' in answer) rows.ranged = false
  }
  if (answer === undefined) return undefined
  unread($, event, answer)
  return 'rows' in answer ? answer.rows : undefined
}

/**
 * Reads of stored results for the result rows that wait, one per agent and response row: in `due` mode only where a
 * row's read is due (LOOKUP_DELAYS_MS after its result row), else for every row. A call whose result the transcript
 * holds goes to applyCall with it. One with none waits for its next due read; after its last one, or at once in `final`
 * mode, it goes on with its text only. A read before a row's read is due counts no read for it. `event` names the hook
 * or the timer in a diagnostic of a read.
 */
async function lookedUp($: EngineInterface, deadline: Deadline, mode: 'due' | 'first' | 'final', event: string): Promise<void> {
  const now = await $.clock.now()
  const groups = new Map<string, { agentId?: string; after?: string; waits: Waiting[] }>()
  for (const wait of rows.waiting.values()) {
    const key = JSON.stringify([wait.call.agentId ?? null, wait.after ?? null])
    const group = groups.get(key) ?? { agentId: wait.call.agentId, after: wait.after, waits: [] }
    group.waits.push(wait)
    groups.set(key, group)
  }
  const ready: RowCall[] = []
  for (const { agentId, after, waits } of groups.values()) {
    if (mode === 'due' && waits.every(wait => wait.due > now)) continue
    const ids = new Set(waits.map(wait => wait.call.id))
    const answer = await transcriptOf($, event, agentId, after)
    let found = resultsOf(answer, ids)
    // A result row that the read still lists with no stored result BARE_RESULT_MS after it came: the response row, which a
    // read of the newest rows holds, can carry the result that the result row does not. A build that refuses ranged
    // reads gets no such read: its read of the whole conversation already holds the response rows.
    if (rows.ranged !== false && after !== undefined && waits.some(wait => !found.has(wait.call.id) && now - wait.call.at >= BARE_RESULT_MS && isResultListed(answer, wait.call.id))) {
      const newest = await messagesOf($, { ...(agentId === undefined ? {} : { agentId }), last: LOOKUP_LAST })
      unread($, event, newest)
      found = new Map([...resultsOf('rows' in newest ? newest.rows : undefined, ids), ...found])
    }
    for (const wait of waits) {
      // Another read took this row meanwhile.
      if (rows.waiting.get(wait.call.id) !== wait) continue
      const answer = found.get(wait.call.id)
      if (answer === undefined && mode !== 'final') {
        if (wait.due > now) continue
        wait.tries += 1
        const delay = LOOKUP_DELAYS_MS[wait.tries]
        if (delay !== undefined) {
          wait.due = wait.call.at + delay
          continue
        }
      }
      rows.waiting.delete(wait.call.id)
      const input = Object.keys(wait.call.input).length > 0 ? wait.call.input : answer?.input ?? {}
      ready.push(answer !== undefined && isFields(answer.result) ? { ...wait.call, input, result: answer.result } : { ...wait.call, input })
    }
  }
  await delivered($, deadline, ready)
  lookupScheduled($, now)
}

/** Sets the one timer of reads of stored results to the earliest due row, or ends it when no row waits. */
function lookupScheduled($: EngineInterface, now: number): void {
  const due = Math.min(...[...rows.waiting.values()].map(wait => wait.due))
  if (!Number.isFinite(due)) {
    rows.timer?.cancel()
    rows.timer = null
    return
  }
  if (rows.timer !== null && rows.timerAt <= due) return
  rows.timer?.cancel()
  rows.timerAt = due
  rows.timer = $.clock.after(Math.max(0, due - now), () => {
    rows.timer = null
    void lookupTick($)
  })
}

/** A due read of stored results, on its timer: it settles a switch first, as a tick does; a failure logs once per message. */
async function lookupTick($: EngineInterface): Promise<void> {
  try {
    const deadline = deadlineOf()
    await switched($, deadline)
    await lookedUp($, deadline, 'due', 'clock.after')
  } catch (error) {
    report($, 'clock.after', `a read of stored tool results failed: ${messageOf(error)}`, `lookup|${messageOf(error)}`)
  }
}

/**
 * Before an input that a launch must come before: one read for the rows that wait, FIRST_WAIT_MS at most. `isHeld`, for
 * an input that a launch must not lose its details to, such as a notification or a snapshot: a row younger than
 * FIRST_HOLD_MS that still waits gets one more read at that age. A drawing, such as `/downrange`, holds nothing.
 */
async function rowsFirst($: EngineInterface, deadline: Deadline, event: string, isHeld: boolean): Promise<void> {
  if (rows.waiting.size > 0) await within($, event, FIRST_WAIT_MS, firstRead($, deadline, event, isHeld))
}

/** The reads of rowsFirst: Claude Code stores a main-loop result about 55 ms after its result row, so a young row can wait that long. */
async function firstRead($: EngineInterface, deadline: Deadline, event: string, isHeld: boolean): Promise<void> {
  await lookedUp($, deadline, 'first', event)
  if (!isHeld) return
  const now = await $.clock.now()
  const holds = [...rows.waiting.values()].map(wait => wait.call.at + FIRST_HOLD_MS).filter(at => at > now)
  if (holds.length === 0) return
  await $.clock.sleep(Math.max(...holds) - now)
  await lookedUp($, deadline, 'first', event)
}

/**
 * Before a slash command or a /config change, which can reload the mod and empty its memory: one read, then every row
 * that waits goes on, with its text only when the transcript holds no result yet; FLUSH_WAIT_MS at most.
 */
async function rowsFlushed($: EngineInterface, deadline: Deadline, event: string): Promise<void> {
  if (rows.waiting.size > 0) await within($, event, FLUSH_WAIT_MS, lookedUp($, deadline, 'final', event))
}

/** Hands calls to applyCall, each tool use id once; a call that fails logs once per tool and message, and the others still apply. */
async function delivered($: EngineInterface, deadline: Deadline, calls: readonly RowCall[]): Promise<void> {
  for (const call of calls) {
    if (rows.delivered.has(call.id)) continue
    rows.delivered.add(call.id)
    capped(rows.delivered, DELIVERED_MAX)
    try {
      await applyCall($, deadline, call)
    } catch (error) {
      report($, rowLabel(call.tool), `could not apply a call: ${messageOf(error)}`, `apply|${call.tool}|${messageOf(error)}`)
    }
  }
}

/**
 * What a finished call of a tracked tool changes, from its input, its text, and its stored result when the transcript
 * holds one. A failed call changes nothing. With no stored result, as for a call inside a Code Mode script, only the
 * input and the engine's words at the start of the text count, and a launch that they do not describe changes nothing.
 * A ScheduleWakeup with no stored result changes nothing, also when a flush applies it: its outcome is unknown, so
 * the wakeup stays as it was until a scheduled prompt, a snapshot, or its expiry clears it.
 * Each change carries the time of the call's result row: a launch or a wakeup that applies after a newer input of its
 * task does not undo that input.
 */
async function applyCall($: EngineInterface, deadline: Deadline, call: RowCall): Promise<void> {
  if (call.isError) return
  const { input, result, at } = call
  if (call.tool === 'Bash') {
    await shellLaunched($, deadline, call)
  } else if (call.tool === 'Monitor') {
    const id = result === undefined ? monitorIdOf(call.text) : stringOf(result.taskId)
    if (id === undefined || id === '') return
    // The Monitor tool caps a larger timeout of its input; a stored result holds the capped one.
    const timeoutMs = result === undefined ? Math.min(numberOf(input.timeout_ms) ?? 0, MONITOR_TIMEOUT_MAX_MS) : numberOf(result.timeoutMs) ?? 0
    const isPersistent = (result === undefined ? input.persistent : result.persistent) === true
    const job = monitorJob({ id, description: stringOf(input.description) ?? '', timeoutMs, isPersistent }, at)
    await writeJobs($, deadline, { at, ids: [id] }, jobs => launched(jobs, job))
  } else if (call.tool === 'Agent') {
    await agentLaunched($, deadline, call)
  } else if (call.tool === 'Workflow') {
    const id = stringOf(result?.taskId)
    if (result === undefined || result.error !== undefined || id === undefined || id === '') return
    const job = workflowJob({ id, name: stringOf(result.workflowName) }, at)
    await writeJobs($, deadline, { at, ids: [id] }, jobs => launched(jobs, job))
  } else if (call.tool === 'ScheduleWakeup') {
    if (result === undefined) return
    const dueAt = numberOf(result.scheduledFor)
    if (result.stopped !== true && dueAt === undefined) return
    const wakeup = result.stopped === true || dueAt === undefined ? null : wakeupOf(dueAt, stringOf(input.reason), at)
    await writeWakeup($, deadline, at, () => wakeup, true)
  } else if (call.tool === 'TaskStop') {
    // The job ends at the time of the call's result row. The observation is stamped when it applies, so the output
    // reads of the job since that row, which do not say that it still runs, do not hold the stop back.
    const id = stringOf(result?.task_id) ?? stringOf(input.task_id) ?? stringOf(input.shell_id)
    if (id === undefined || id === '') return
    await writeJobs($, deadline, { at: await $.clock.now(), ids: [id] }, jobs => stoppedJob(jobs, id, at))
  }
}

/**
 * A Bash call that runs in the background: its task id and launch notes from the stored result, else, for a call that
 * asked for `run_in_background`, from the engine's words at the start of its text, with no launch note. The output file
 * comes from the text.
 */
async function shellLaunched($: EngineInterface, deadline: Deadline, call: RowCall): Promise<void> {
  const { input, result, at } = call
  const id = result === undefined ? backgroundIdOf(input, call.text) : stringOf(result.backgroundTaskId)
  if (id === undefined || id === '') return
  const outputFile = outputFileOf(call.text, id)
  if (outputFile === undefined) {
    report($, rowLabel('Bash'), `no output file in the result of task ${id}; its last line is unavailable`, `path|${id}`)
  }
  const launch: { timedOutAfterMs?: number; backgroundedByUser?: boolean; backgroundEndsWithFinalResponse?: boolean } =
    result === undefined ? {} : { timedOutAfterMs: numberOf(result.timedOutAfterMs), backgroundedByUser: result.backgroundedByUser === true, backgroundEndsWithFinalResponse: result.backgroundEndsWithFinalResponse === true }
  const note = shellLaunchNote(launch, outputFile !== undefined)
  const command = stringOf(input.command) ?? ''
  const redirectFile = await redirectFor($, id, command, call.agentId)
  await writeJobs($, deadline, { at, ids: [id] }, jobs => launched(jobs, shellJob({ id, command, description: stringOf(input.description), outputFile, redirectFile, note, ownerAgentId: call.agentId, endsWithAgent: launch.backgroundEndsWithFinalResponse === true }, at)))
  // The history read comes after the launch, so an end or a clear that comes meanwhile is never undone.
  const history = await historyFor($, command)
  if (history !== undefined) await writeJobs($, deadline, { at, ids: [id] }, jobs => historyAdded(jobs, id, history))
}

/**
 * An Agent call that runs in the background, remotely, or as a teammate, from its stored result; with none, only a
 * teammate, from the agent id that its text names. Then the agent's rows that came before the launch apply.
 */
async function agentLaunched($: EngineInterface, deadline: Deadline, call: RowCall): Promise<void> {
  const { input, result, at } = call
  const description = stringOf(input.description) ?? ''
  const status = stringOf(result?.status)
  let job: AgentJob | undefined
  if (result === undefined) {
    const id = teammateIdOf(call.text)
    if (id !== undefined) job = agentJob({ id, description }, at)
  } else if (status === 'teammate_spawned') {
    // A teammate in a terminal pane of its own runs no loop here: its id is its address in its team.
    const id = stringOf(result.agentId) ?? stringOf(result.agent_id)
    const isOwnPane = id !== undefined && id === stringOf(result.teammate_id)
    if (id !== undefined && id !== '') job = agentJob({ id, description, ...(isOwnPane ? { note: 'own pane', runsElsewhere: true } : {}) }, at)
  } else if (status === 'async_launched' || status === 'remote_launched') {
    // A foreground call answers `completed`, and a plugin's own call an AgentCallRecord (no status) once the agent settled: nothing runs.
    const id = stringOf(status === 'async_launched' ? result.agentId : result.taskId)
    const title = stringOf(result.description) ?? description
    if (id !== undefined && id !== '') job = agentJob({ id, description: title, ...(status === 'remote_launched' ? { note: 'remote', runsElsewhere: true } : {}) }, at)
  }
  if (job === undefined) return
  const launch = job
  await writeJobs($, deadline, { at, ids: [launch.id] }, jobs => launched(jobs, launch))
  const early = rows.early.get(launch.id)
  if (early === undefined) return
  rows.early.delete(launch.id)
  const now = await $.clock.now()
  for (const activity of early) {
    if (now - activity.at <= EARLY_ROWS_MS) await activityApplied($, deadline, launch.id, activity)
  }
}

/**
 * A subagent's tool activity, from its rows: a call starts at its tool_use block and ends at its tool_result block. A
 * Code Mode script is in flight from its start to its own result, and counts no tool; the calls inside it come as rows
 * when it settles, each a start and an end at once. The rows of an agent with no row in memory wait EARLY_ROWS_MS for
 * its launch (see agentLaunched).
 */
async function activityRow($: EngineInterface, deadline: Deadline, agentId: string, activity: Activity): Promise<void> {
  if (!mirror.isLoaded) await loaded($)
  if (memory.jobs.items.some(job => job.kind === 'agent' && job.id === agentId)) {
    await activityApplied($, deadline, agentId, activity)
    return
  }
  const early = (rows.early.get(agentId) ?? []).filter(one => activity.at - one.at <= EARLY_ROWS_MS)
  if (early.length < EARLY_ROWS_MAX) early.push(activity)
  rows.early.delete(agentId)
  rows.early.set(agentId, early)
  capped(rows.early, EARLY_AGENTS_MAX)
  earlyScheduled($, activity.at)
}

/**
 * Drops the rows that waited EARLY_ROWS_MS for their agent's launch: past that age they count nothing (see
 * agentLaunched). One timer runs at a time, due when the oldest row left passes that age, until no row waits.
 */
function earlyScheduled($: EngineInterface, now: number): void {
  rows.early = earlyKept(rows.early, now, EARLY_ROWS_MS)
  if (rows.earlyTimer !== null || rows.early.size === 0) return
  const due = Math.min(...[...rows.early.values()].flatMap(early => early.map(one => one.at))) + EARLY_ROWS_MS + 1
  rows.earlyTimer = $.clock.after(Math.max(0, due - now), () => {
    rows.earlyTimer = null
    earlyScheduled($, due)
  })
}

/** Applies one step of a tracked agent's activity; each call id counts once, and OPEN_CALLS_MAX calls are in flight at most. */
async function activityApplied($: EngineInterface, deadline: Deadline, agentId: string, activity: Activity): Promise<void> {
  const open = rows.open.get(agentId) ?? new Map<string, { at: number; isCounted: boolean }>()
  rows.open.set(agentId, open)
  const observation = { at: activity.at, ids: [agentId], kind: 'activity' } as const
  if (activity.kind === 'start') {
    if (open.has(activity.id)) return
    open.set(activity.id, { at: activity.at, isCounted: activity.isCounted })
    const size = open.size
    capped(open, OPEN_CALLS_MAX)
    const dropped = size - open.size
    await writeJobs($, deadline, observation, jobs => {
      const started = activityStarted(jobs, agentId, activity.summary, activity.at, activity.isCounted)
      return dropped > 0 ? activityClosed(started, agentId, dropped) : started
    })
    return
  }
  const started = open.get(activity.id)
  if (started === undefined) return
  open.delete(activity.id)
  await writeJobs($, deadline, observation, jobs =>
    started.isCounted ? activityEnded(jobs, agentId, activity.isFailure, activity.at) : activityClosed(jobs, agentId, 1, activity.at))
}

/** Closes the calls in flight of an agent that `isDue` picks, with no outcome: at its turn end, and after OPEN_CALL_MS. */
async function callsClosed($: EngineInterface, deadline: Deadline, agentId: string, now: number, isDue: (call: { at: number }) => boolean): Promise<void> {
  const open = rows.open.get(agentId)
  if (open === undefined) return
  const due = [...open].filter(([, call]) => isDue(call)).map(([id]) => id)
  if (due.length === 0) return
  for (const id of due) open.delete(id)
  await writeJobs($, deadline, { at: now, ids: [agentId], kind: 'activity' }, jobs => activityClosed(jobs, agentId, due.length))
}

/** Appends clean runs to the duration history, one record at a time; a failure costs the record only and logs once. */
async function recordRuns($: EngineInterface, runs: readonly HistoryRun[], now: number, event: 'prompt.submit' | 'session.append' | 'clock.every'): Promise<void> {
  if (runs.length === 0) return
  const record = historyWrites.then(async () => {
    try {
      const durations = await storedDurations($, event)
      await $.store.set('durations', runs.reduce((all, run) => recorded(all, run.key, run.durationMs, now), durations))
    } catch (error) {
      report($, event, `duration history unavailable: ${messageOf(error)}`, 'history-set')
    }
  })
  historyWrites = record
  await record
}

/** Applies every notification block in a delivered prompt, in order; history judges each block on the list the blocks before it left. */
async function applyNotices($: EngineInterface, deadline: Deadline, text: string, noticeRow?: string, observedAt?: number): Promise<void> {
  const event = noticeRow === undefined ? 'prompt.submit' : 'session.append'
  const notices = noticesOf(text)
  if (notices.length === 0) {
    if (text.includes('<task-notification>')) report($, event, 'a task notification held no complete <task-notification> block; jobs end at the next turn end', 'no-block')
    return
  }
  for (const problem of notices.map(noticeProblemOf)) {
    if (problem !== undefined) report($, event, problem.cause, problem.once)
  }
  const now = observedAt ?? await $.clock.now()
  let runs: HistoryRun[] = []
  const changed = await writeJobs($, deadline, { at: now, ids: notices.flatMap(notice => notice.ids), kind: 'notice', finalIds: finalIdsOf(notices), noticeRow }, jobs => {
    runs = finishedRuns(jobs, notices, now)
    return notices.reduce((list, notice) => noticed(list, notice, now, isAnyRatio), jobs)
  })
  if (changed) await recordRuns($, runs, now, event)
}

/** Reconciles with a Stop or SubagentStop snapshot: the wakeup with `session_crons`, the jobs with `background_tasks`; an absent field logs once. */
async function reconcile(
  $: EngineInterface,
  deadline: Deadline,
  event: string,
  input: { background_tasks?: readonly SnapshotTask[]; session_crons?: readonly { recurring: boolean }[] },
): Promise<void> {
  const now = await $.clock.now()
  const crons = input.session_crons
  if (crons === undefined) {
    report($, event, 'no session_crons in the hook input; a cancelled wakeup waits for its expiry', 'no-crons')
  } else {
    await writeWakeup($, deadline, now, current => wakeupAfterSnapshot(current, crons, now))
  }
  const tasks = input.background_tasks
  if (tasks === undefined) {
    report($, event, 'no background_tasks in the hook input; reconciliation skipped', 'no-snapshot')
    return
  }
  await writeJobs($, deadline, { at: now, kind: 'snapshot', members: tasks.map(task => task.id) }, jobs => reconciled(jobs, tasks, now))
}

/** Runs `tail -c 16384 <path>`: the last TAIL_BYTES bytes, written as text so the command reads in full; only the output file path varies. */
async function tailOf($: EngineInterface, path: string, bytes: number): Promise<string> {
  const ran = await $.process.run(['tail', '-c', '16384', path], { timeoutMs: TAIL_TIMEOUT_MS }).catch((error: unknown) => {
    throw new TailFailure(messageOf(error), bytes)
  })
  if (ran.exitCode !== 0) throw new TailFailure(`exit ${ran.exitCode}: ${oneLine(ran.stderr)}`, bytes)
  return ran.stdout
}

/** A file's end, by `$.fs.read` up to FS_READ_MAX and by `tail` above. */
async function endOf($: EngineInterface, path: string, size: number): Promise<string> {
  const isTail = size > FS_READ_MAX
  return outputEndOf(isTail ? await tailOf($, path, size) : await $.fs.read(path), isTail)
}

/**
 * What a job's output holds now: no new lines while its size stays, else its end, and the exit code when that end is
 * Claude Code's closing line. A job with a redirect file also looks at that file (see redirectRead).
 */
async function readOutput($: EngineInterface, job: ShellJob & { outputFile: string }): Promise<TailRead> {
  const stat = await $.fs.stat(job.outputFile)
  const isAsked = job.failedReadBytes !== undefined || job.finalReadAskedAt !== undefined
  const text = stat.size === job.outputBytes && !isAsked ? undefined : await endOf($, job.outputFile, stat.size)
  const lines = text === undefined ? [] : displayLinesOf(text)
  const output: TailRead = { bytes: stat.size, mtimeMs: stat.mtimeMs, lines, exitCode: closingCodeOf(lines) }
  return job.redirectFile === undefined ? output : await redirectRead($, job, job.redirectFile, output, text, isAsked)
}

/**
 * The read of a job with a redirect file, after the read of its output (`text` when that read took its end). The row
 * takes its lines from the file that changed last, by modification time, and from the output file when the two times
 * are equal. The output file counts only while it holds a job line. Its time is its modification time once the job wrote
 * to it since the last read, which the engine's closing line alone is not. Until then it keeps the time of the lines that
 * the row shows from it, and it does not count while the row shows the redirect file. When the redirect file is missing
 * or not a regular file, the output file shows if it holds a job line. The redirect file is read again when its size or
 * its modification time changes. A read of it carries its size and time, which tailRead keeps as redirectBytes and
 * lastOutputAt. Every result, and a failure, carries the exit code on the closing line of the output file.
 */
async function redirectRead($: EngineInterface, job: ShellJob & { outputFile: string }, redirectFile: string, output: TailRead, text: string | undefined, isAsked: boolean): Promise<TailRead> {
  const isRedirectShown = job.redirectBytes !== undefined
  const isWritten = text !== undefined && output.bytes !== job.outputBytes && (job.outputBytes === undefined || jobBytesOf(text, output.bytes) > job.outputBytes)
  const outputAt = isWritten ? output.mtimeMs : isRedirectShown ? undefined : job.lastOutputAt
  /** Whether the output file holds a job line: in the lines read now, else in the line that the row shows from it. */
  const hasJobLine = (lines: readonly string[]): boolean => (text === undefined && !isRedirectShown ? job.lastLine !== undefined : jobLinesOf(lines).length > 0)
  let redirect: { size: number; mtimeMs: number }
  try {
    const stat = await $.fs.stat(redirectFile)
    if (stat.kind !== 'file') throw new Error('not a regular file')
    redirect = stat
  } catch (error) {
    // A row that shows the redirect file needs the output file's end to show it instead.
    const lines = text === undefined && isRedirectShown ? displayLinesOf(await endOf($, job.outputFile, output.bytes)) : output.lines
    if (hasJobLine(lines)) return { ...output, lines, exitCode: closingCodeOf(lines) }
    throw new RedirectFailure(error, closingCodeOf(lines))
  }
  if (outputAt !== undefined && outputAt >= redirect.mtimeMs && hasJobLine(output.lines)) return output
  try {
    const isSame = isRedirectShown && redirect.size === job.redirectBytes && redirect.mtimeMs === job.lastOutputAt
    const lines = isSame && !isAsked ? [] : displayLinesOf(await endOf($, redirectFile, redirect.size))
    return { bytes: output.bytes, mtimeMs: redirect.mtimeMs, lines, redirectBytes: redirect.size, exitCode: output.exitCode }
  } catch (error) {
    throw new RedirectFailure(error, output.exitCode)
  }
}

/** Applies a read of a job's output, or a failed read, and records the clean run that the read's closing line ends (see closedRuns). */
async function readApplied($: EngineInterface, deadline: Deadline, id: string, now: number, exitCode: number | undefined, change: (jobs: Job[]) => Job[]): Promise<void> {
  let runs: HistoryRun[] = []
  const changed = await writeJobs($, deadline, { at: now, ids: [id] }, jobs => {
    runs = closedRuns(jobs, id, exitCode, now)
    return change(jobs)
  })
  if (changed) await recordRuns($, runs, now, 'clock.every')
}

/**
 * Reads one shell job's output and applies it; only a failed stat, read, or tail sets the job's note and logs once per
 * job and file. An output file that ends with Claude Code's closing line ends a running row with its exit code.
 */
async function readTail($: EngineInterface, deadline: Deadline, job: ShellJob & { outputFile: string }, now: number): Promise<void> {
  const path = job.outputFile
  if (!isOutputFileOf(path, job.id)) {
    report($, 'clock.every', `refused to read ${path}: it is not the output file of task ${job.id}`, `path|${job.id}`)
    await writeJobs($, deadline, { at: now, ids: [job.id] }, jobs => readFailed(jobs, job.id, 'output unavailable', now))
    return
  }
  let found: TailRead
  try {
    found = await readOutput($, job)
  } catch (error) {
    const isRedirect = error instanceof RedirectFailure
    const failure = isRedirect ? error.failure : error
    const bytes = failure instanceof TailFailure ? failure.bytes : undefined
    const verb = bytes === undefined ? 'read' : 'tail'
    report($, 'clock.every', `cannot ${verb} ${isRedirect ? 'the redirect file' : 'the output'} of task ${job.id}: ${messageOf(failure)}`, `${isRedirect ? 'redirect ' : ''}${verb}|${job.id}`)
    const exitCode = isRedirect ? error.exitCode : undefined
    await readApplied($, deadline, job.id, now, exitCode, jobs => readFailed(jobs, job.id, bytes === undefined ? 'output unavailable' : 'tail failed', now, bytes, exitCode))
    return
  }
  await readApplied($, deadline, job.id, now, found.exitCode, jobs => tailRead(jobs, job.id, found, now, isAnyRatio))
}

/**
 * Applies `$.agent.list()` to agent jobs; a failed list logs once. Only the listed agents with a row count: a stamp for
 * an agent with no row would drop its launch, whose stored result can come a moment after the list.
 */
async function syncAgents($: EngineInterface, deadline: Deadline, now: number, event = 'clock.every'): Promise<void> {
  const agents = await $.agent.list().catch((error: unknown) => {
    report($, event, `cannot list agents: ${messageOf(error)}`, 'agents')
    return undefined
  })
  if (agents === undefined) return
  if (!mirror.isLoaded) await loaded($)
  const ids = agents.filter(agent => memory.jobs.items.some(job => job.kind === 'agent' && job.id === agent.id)).map(agent => agent.id)
  await writeJobs($, deadline, { at: now, ids }, jobs => agentsSynced(jobs, agents, now))
}

/** One ticker period: it marks the ticker alive, then refreshes unless a refresh still runs; a failure logs once per message. */
async function tick($: EngineInterface): Promise<void> {
  try {
    const now = await $.clock.now()
    lastTickAt = now
    if (isTicking) return
    isTicking = true
    try {
      await refresh($, now)
    } finally {
      isTicking = false
    }
  } catch (error) {
    report($, 'clock.every', messageOf(error), `tick|${messageOf(error)}`)
  }
}

/**
 * The work of one tick: settle a switch (see switched), expire the wakeup, sync agents, close subagent calls open too
 * long, read outputs (a pending final read too), write a mirror that fell behind, redraw, and stop when nothing is live
 * and no switch waits.
 */
async function refresh($: EngineInterface, now: number): Promise<void> {
  const deadline = deadlineOf()
  await switched($, deadline)
  const seen = { ...memory }
  const { jobs: { items: shown }, wakeup: { pending: wakeup } } = viewNow()
  if (wakeupAfterTick(wakeup, now) !== wakeup) await writeWakeup($, deadline, now, current => wakeupAfterTick(current, now))
  if (seen.jobs.items.some(job => job.kind === 'agent' && isRunning(job))) await syncAgents($, deadline, now)
  for (const agentId of [...rows.open.keys()]) {
    if (!memory.jobs.items.some(job => job.kind === 'agent' && job.id === agentId)) rows.open.delete(agentId)
    else await callsClosed($, deadline, agentId, now, call => now - call.at >= OPEN_CALL_MS)
  }
  for (const job of readsDue(seen.jobs.items, now)) await readTail($, deadline, job, now)
  if (mirror.isBehind) await mirrored($, deadline)
  // Every change replaces the jobs or the wakeup: after a change during this tick, the next tick judges liveness on fresh data.
  if (!isLive(shown, wakeup, now) && memory.jobs === seen.jobs && memory.wakeup === seen.wakeup && mirror.writing === null && !mirror.isBehind && pending === null) {
    ticker?.cancel()
    ticker = null
  }
  $.ui.invalidate('ui.render')
}

/** Runs a button of the band or the pane; a failure, and an Open whose pane waits unplaced, log to the transcript. */
async function pressed($: EngineInterface, control: Control): Promise<void> {
  try {
    if (control === 'Open') {
      const opened = await $.ui.open({ id: PANE_ID, title: PANE_TITLE })
      if (!opened.isPlaced) $.ui.log(`downrange: ui.press: the Jobs pane waits: ${opened.reason}`)
    } else if (control === 'Hide') {
      const now = await $.clock.now()
      await update($, BAND_HIDDEN_AT, () => now)
    } else if (control === 'Clear finished') {
      const deadline = deadlineOf()
      await rowsFirst($, deadline, 'ui.press', false)
      await writeJobs($, deadline, { at: await $.clock.now() }, finishedCleared)
    } else {
      await $.ui.close({ id: PANE_ID })
    }
  } catch (error) {
    $.ui.log(`downrange: ui.press: ${control} failed: ${messageOf(error)}`)
  }
}

/** The time, and the jobs and the wakeup in state; in a render hook, the reads subscribe the drawing. */
async function stateNow($: EngineInterface): Promise<{ now: number; jobs: Job[]; wakeup: WakeupState }> {
  const [now, { items: jobs }, wakeup] = await Promise.all([$.clock.now(), read($, JOBS), read($, WAKEUP)])
  return { now, jobs, wakeup }
}

/** The /downrange table at the command's width. */
async function tableNow($: EngineInterface, columns: number): Promise<string> {
  const { now, jobs, wakeup: { pending: wakeup } } = await stateNow($)
  return tableOf(jobs, wakeup, now, columns, false)
}

/** `/downrange pane`: close an open pane, else open it; where nothing draws, the pane is not placed, or a pane call fails, the reason and the table print. */
async function togglePane($: EngineInterface, columns: number): Promise<CommandRunResult> {
  try {
    if ((await $.ui.panes()).some(pane => pane.id === PANE_ID)) {
      await $.ui.close({ id: PANE_ID })
      return {}
    }
    const hasSurface = (await $.session.surfaces()).length > 0
    const opened = hasSurface ? await $.ui.open({ id: PANE_ID, title: PANE_TITLE }) : { isPlaced: false as const, reason: 'no surface draws in this session' }
    if (opened.isPlaced) return {}
    if (hasSurface) await $.ui.close({ id: PANE_ID })
    $.ui.log(`command.run: the Jobs pane was not placed: ${opened.reason}`, { to: 'debug' })
    return { text: `The Jobs pane is not shown here: ${opened.reason}.\n\n${await tableNow($, columns)}` }
  } catch (error) {
    $.ui.log(`command.run: the Jobs pane could not be toggled: ${messageOf(error)}`, { to: 'debug' })
    return { text: `The Jobs pane could not be toggled: ${messageOf(error)}.\n\n${await tableNow($, columns)}` }
  }
}

/** The local answer: the drop reason for an exact status prompt while a job runs, or undefined to pass it on. */
async function statusAnswer($: EngineInterface, text: string): Promise<string | undefined> {
  const normalized = normalizePrompt(text)
  if (!isStatusPrompt(normalized)) return undefined
  const [{ now, jobs, wakeup: { pending: wakeup } }, answered] = await Promise.all([stateNow($), read($, LAST_ANSWERED)])
  if (!jobs.some(isRunning)) return undefined
  if (answered !== null && answered.text === normalized && now - answered.at <= REPEAT_WINDOW_MS) {
    await update($, LAST_ANSWERED, () => null)
    return undefined
  }
  await update($, LAST_ANSWERED, () => ({ text: normalized, at: now }))
  const seconds = REPEAT_WINDOW_MS / 1_000
  return `Downrange answered this (not sent to Claude). Send it again within ${seconds} s to ask Claude.\n\n${tableOf(jobs, wakeup, now)}`
}

export const register: Register = (on, options) => {
  isAnyRatio = options.genericRatios === true
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: COMMAND,
        description: 'Background tasks of this session (not background sessions): progress, ETA, last output. "/downrange pane" toggles the live pane.',
        argumentHint: '[pane]',
        immediate: true,
      })
    } catch (error) {
      $.ui.log(`downrange: session.start: /downrange was not registered: ${messageOf(error)}`)
    }
    await loaded($)
    // The session that this module first serves shows every ended job that memory holds; a later session.start of the
    // module keeps the current session as it is. A session id that cannot be read keeps the session out of `sessions`.
    const id = await $.session.id().catch(() => undefined)
    if (id !== undefined && !sessions.has(id)) entered(id, since)
    await ensureTicker($)
    return next(e)
  }).catch(($, e, next) => passOn($, 'session.start', e, next))

  on('session.end', async ($, e, next) => {
    // /clear, /resume, and /branch go on in this process: the next session that this process has not shown starts its
    // Finished here. Memory stays as it is. Until the mod knows the new session (see switched), the view is a new
    // session's, which shows no job that ended before the switch, and the ticker runs, so that a tick settles the
    // switch when no other event comes. A zero-delay timer settles once at once, before the first tick.
    if (e.reason === 'clear' || e.reason === 'resume') {
      switchedAt = await $.clock.now()
      pending = { reason: e.reason, ended: e.sessionId }
      since = switchedAt
      await ensureTicker($)
      $.clock.after(0, () => {
        void settledAtOnce($)
      })
    }
    return next(e)
  }).catch(($, e, next) => passOn($, 'session.end', e, next))

  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    // e.session_id names the session that starts; this hook asks no session id. The engine reset $.state, and the
    // mirror write here puts the new session's view in it. One mirror write runs at a time, so a write that began
    // before the switch lands first, and the write after it holds the new session's view (see mirrored). This event
    // settles the switch, so a command or a /config change waits for its write (see settleLanded). A switch that a hook
    // settled before it gets the same start here, and memory keeps every change made since (see switched).
    pending = null
    entered(e.session_id, sessions.get(e.session_id) ?? switchedAt ?? await $.clock.now())
    await persisted($, deadlineOf(), true)
    await ensureTicker($)
    return next(e)
  }).catch(($, e, next) => passOn($, 'classic.SessionStart{source=clear|resume|fork}', e, next))

  on('command.run', { command: COMMAND }, async ($, e) => {
    const deadline = deadlineOf()
    await switched($, deadline)
    await rowsFirst($, deadline, 'command.run', false)
    const argument = e.args.trim()
    if (argument === '') return { text: await tableNow($, e.presentation.columns) }
    if (argument === 'pane') return togglePane($, e.presentation.columns)
    return { text: 'Usage: /downrange [pane]' }
  }).catch(($, e, next) => {
    if (isReentry(next.error)) return { text: '/downrange is unavailable during a nested call.' }
    reportHook($, 'command.run{command=downrange}', next.error)
    return { text: `/downrange could not run: ${failureText(next.error)}.` }
  })

  on('command.run', async ($, e, next) => {
    // Every slash command settles a pending switch before it runs, waits for the write of a settle that is under way,
    // and writes the view once more when the last mirror write failed, then runs as typed. A command can reload the mod,
    // such as /reload-plugins: the reload empties memory, and the engine reset $.state at the switch, so the view must be
    // in $.state first (see switched and settleLanded). Calls whose stored result is still being read go on first, so
    // the reload does not lose them (see rowsFlushed). With no switch pending, no settle in progress, no write behind,
    // and no call waiting, this hook asks nothing and waits for nothing.
    const deadline = deadlineOf()
    await switched($, deadline)
    await rowsFlushed($, deadline, 'command.run')
    await settleLanded($, deadline)
    if (mirror.isBehind) await persisted($, deadline)
    return next(e)
  }).catch(($, e, next) => passOn($, 'command.run', e, next))

  on('config.set', async ($, e, next) => {
    // Every /config change settles a pending switch before the row changes, waits for the write of a settle that is
    // under way, and writes the view once more when the last mirror write failed, then changes the row as asked. A change
    // of a Downrange option reloads the mod, and no slash command runs then, so the view must be in $.state first (see
    // switched and settleLanded). Calls whose stored result is still being read go on first (see rowsFlushed). This hook
    // never refuses a change and never changes a value. With no switch pending, no settle in progress, no write behind,
    // and no call waiting, it asks nothing and waits for nothing.
    const deadline = deadlineOf()
    await switched($, deadline)
    await rowsFlushed($, deadline, 'config.set')
    await settleLanded($, deadline)
    if (mirror.isBehind) await persisted($, deadline)
    return next(e)
  }).catch(($, e, next) => passOn($, 'config.set', e, next))

  on('session.append', async ($, e, next) => {
    // A tool call reaches the mod as two rows: the response row that holds its tool_use block, and the result row that
    // holds its tool_result block once it ended (see responseApplied and resultApplied). Inside a Code Mode script, both rows come when the
    // script settles. A subagent's stored task notification is a row too. Every other row passes on at once.
    const deadline = deadlineOf()
    await switched($, deadline)
    const isNotice = e.agentId !== undefined && e.origin.kind === 'task-notification'
    if (!isNotice && e.door !== 'response' && e.door !== 'tool-result') return next(e)
    // A main-loop response row needs no time: it only keeps the inputs of its calls.
    const now = isNotice || e.door === 'tool-result' || e.agentId !== undefined ? await $.clock.now() : null
    const stored = await next(e)
    if (stored.deny !== undefined || stored.uuid !== e.uuid) return stored
    const row: Row = { uuid: stored.uuid, agentId: e.agentId, tool: e.origin.kind === 'tool' ? e.origin.tool : undefined, content: stored.message.content }
    if (isNotice) {
      await rowsFirst($, deadline, 'session.append', true)
      const text = stored.message.content.flatMap(block => block.type === 'text' && 'text' in block && typeof block.text === 'string' ? [block.text] : []).join('\n')
      await applyNotices($, deadline, text, JSON.stringify([e.agentId, stored.uuid]), now ?? undefined)
    } else if (e.door === 'response') {
      await responseApplied($, deadline, row, now)
    } else if (now !== null) {
      await resultApplied($, deadline, row, now)
    }
    return stored
  }).catch(($, e, next) => passOn($, 'session.append', e, next))

  on('turn.complete', async ($, e, next) => {
    const deadline = deadlineOf()
    await switched($, deadline)
    await rowsFirst($, deadline, 'turn.complete', true)
    const now = await $.clock.now()
    const result = await next(e)
    const agentId = e.agentId
    // A turn end leaves no call of its loop in flight.
    if (agentId !== undefined) await callsClosed($, deadline, agentId, now, () => true)
    if (agentId !== undefined && e.reason === 'answer' && !e.isAborted) await writeJobs($, deadline, { at: now }, jobs => ownerAnswered(jobs, agentId, now))
    // A subagent's turn end reads the agent list. A main-loop turn end runs the agent sync of classic.Stop and
    // classic.SubagentStop too: under managed settings or a Team or Enterprise login, those events do not reach the
    // mod. Where they do, both syncs read the same list, and the ordering rule keeps the newer reading.
    if (agentId !== undefined || memory.jobs.items.some(job => job.kind === 'agent')) await syncAgents($, deadline, await $.clock.now(), 'turn.complete')
    return result
  }).catch(($, e, next) => passOn($, 'turn.complete', e, next))

  on('prompt.submit', async ($, e, next) => {
    // The status answer reads the view, so a switch settles before it, and a launch whose stored result is still being
    // read applies before it, as before a notification.
    const deadline = deadlineOf()
    await switched($, deadline)
    await rowsFirst($, deadline, 'prompt.submit', e.origin.kind === 'task-notification')
    if (e.origin.kind === 'task-notification') {
      await applyNotices($, deadline, e.text)
    } else if (e.origin.kind === 'scheduled-trigger') {
      const now = await $.clock.now()
      await writeWakeup($, deadline, now, wakeup => wakeupAfterTrigger(wakeup, now))
    } else if (options.answerStatusPrompts === true && e.origin.kind === 'composer' && e.turnId === undefined && e.attachments === undefined) {
      const answer = await statusAnswer($, e.text)
      if (answer !== undefined) return { drop: answer }
    }
    return next(e)
  }).catch(($, e, next) => passOn($, 'prompt.submit', e, next))

  on('classic.Stop', async ($, e, next) => {
    const deadline = deadlineOf()
    await switched($, deadline)
    await rowsFirst($, deadline, 'classic.Stop', true)
    await reconcile($, deadline, 'classic.Stop', e)
    if (memory.jobs.items.some(job => job.kind === 'agent')) await syncAgents($, deadline, await $.clock.now(), 'classic.Stop')
    return next(e)
  }).catch(($, e, next) => passOn($, 'classic.Stop', e, next))

  on('classic.SubagentStop', async ($, e, next) => {
    const deadline = deadlineOf()
    await switched($, deadline)
    await rowsFirst($, deadline, 'classic.SubagentStop', true)
    await reconcile($, deadline, 'classic.SubagentStop', e)
    if (memory.jobs.items.some(job => job.kind === 'agent')) await syncAgents($, deadline, await $.clock.now(), 'classic.SubagentStop')
    return next(e)
  }).catch(($, e, next) => passOn($, 'classic.SubagentStop', e, next))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (options.band === false || e.props.hasSurvey) return next(e)
    const [{ now, jobs, wakeup: { pending: wakeup } }, hiddenAt] = await Promise.all([stateNow($), read($, BAND_HIDDEN_AT)])
    if (!isLive(jobs, wakeup, now) || isBandHidden(jobs, hiddenAt)) return next(e)
    const actions = {
      open: () => {
        void pressed($, 'Open')
      },
      hide: () => {
        void pressed($, 'Hide')
      },
    }
    const parts = bandOf(jobs, wakeup, now, e.props.bodyColumns)
    return bandTree($.ui.resolve(e), parts, bandHintOf(parts, e.props.bodyColumns), actions, await next(e))
  }).catch(($, e, next) => passOn($, 'ui.render{component=AbovePrompt}', e, next))

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const { now, jobs, wakeup: { pending: wakeup } } = await stateNow($)
    const actions = {
      clear: () => {
        void pressed($, 'Clear finished')
      },
      close: () => {
        void pressed($, 'Close')
      },
    }
    return paneTree($.ui.resolve(e), paneModelOf(jobs, wakeup, now, e.props.bodyColumns), actions)
  }).catch(($, e, next) => {
    if (isReentry(next.error)) return { type: 'Text', props: {}, children: ['The Jobs pane is unavailable during a nested render.'] }
    reportHook($, 'ui.render{component=Pane, requestId=downrange}', next.error)
    return failedPaneTree($.ui.resolve(e), `The Jobs pane could not draw: ${failureText(next.error)}`)
  })
}
