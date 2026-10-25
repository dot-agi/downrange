import { atom, read, update } from 'claude-code'
import type { Caught, CommandRunResult, EngineInterface, HookFailure, Register, Timer } from 'claude-code'

import type { Job, JobsState, ShellJob, Wakeup, WakeupState } from '../types'
import { bandTree, failedPaneTree, paneTree } from './drawing'
import { durationsOf, historyKeyOf, recorded, usualOf } from './history'
import type { Durations } from './history'
import {
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
import { FS_READ_MAX, MAX_SESSIONS, MIRROR_WAIT_MS, REPEAT_WINDOW_MS, TAIL_TIMEOUT_MS, TICK_MS, TICKER_STALE_MS } from './limits'
import { noticesOf } from './notices'
import { closingCodeOf, displayLinesOf, isOutputFileOf, jobBytesOf, jobLinesOf, oneLine, outputEndOf, outputFileOf } from './output'
import { jobsStateOf, wakeupStateOf } from './state'
import { isStatusPrompt, normalizePrompt } from './prompt'
import { redirectFileOf, redirectTargetOf } from './redirect'
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
 * an option causes finds the view in `$.state`. Both then wait for the write of a settle that is under way (see
 * settleLanded). Once `$.session.id()` answers an id other than the ended session's, that id is the new session, once.
 * After a /clear it starts at the switch. After a /resume or a /branch, which the mod cannot tell apart here, a session
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
 * nothing. A failed write is no failure of the hook: the hook goes on, and the next tick writes the mirror again (see
 * refresh).
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
    return { historyKey, usualMs: usualOf(await storedDurations($, 'tool.call'), historyKey) }
  } catch (error) {
    report($, 'tool.call', `duration history unavailable: ${messageOf(error)}`, 'history-get')
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
    report($, 'tool.call', `cannot place the redirect file of task ${id}: ${messageOf(error)}`, `redirect|${id}`)
    return undefined
  }
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

/** Applies `$.agent.list()` to agent jobs; a failed list logs once. */
async function syncAgents($: EngineInterface, deadline: Deadline, now: number, event = 'clock.every'): Promise<void> {
  const agents = await $.agent.list().catch((error: unknown) => {
    report($, event, `cannot list agents: ${messageOf(error)}`, 'agents')
    return undefined
  })
  if (agents !== undefined) await writeJobs($, deadline, { at: now, ids: agents.map(agent => agent.id) }, jobs => agentsSynced(jobs, agents, now))
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
 * The work of one tick: settle a switch (see switched), expire the wakeup, sync agents, read outputs (a pending final
 * read too), write a mirror that fell behind, redraw, and stop when nothing is live and no switch waits.
 */
async function refresh($: EngineInterface, now: number): Promise<void> {
  const deadline = deadlineOf()
  await switched($, deadline)
  const seen = { ...memory }
  const { jobs: { items: shown }, wakeup: { pending: wakeup } } = viewNow()
  if (wakeupAfterTick(wakeup, now) !== wakeup) await writeWakeup($, deadline, now, current => wakeupAfterTick(current, now))
  if (seen.jobs.items.some(job => job.kind === 'agent' && isRunning(job))) await syncAgents($, deadline, now)
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
      await writeJobs($, deadlineOf(), { at: await $.clock.now() }, finishedCleared)
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
    await switched($, deadlineOf())
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
    // Every slash command settles a pending switch before it runs, and waits for the write of a settle that is under
    // way, then runs as typed. A command can reload the mod, such as /reload-plugins: the reload empties memory, and the
    // engine reset $.state at the switch, so the view must be in $.state first (see switched and settleLanded). With no
    // switch pending and no settle in progress, this hook asks nothing and waits for nothing.
    const deadline = deadlineOf()
    await switched($, deadline)
    await settleLanded($, deadline)
    return next(e)
  }).catch(($, e, next) => passOn($, 'command.run', e, next))

  on('config.set', async ($, e, next) => {
    // Every /config change settles a pending switch before the row changes, and waits for the write of a settle that
    // is under way, then changes the row as asked. A change of a Downrange option reloads the mod, and no slash command
    // runs then, so the view must be in $.state first (see switched and settleLanded). This hook never refuses a change
    // and never changes a value. With no switch pending and no settle in progress, it asks nothing and waits for nothing.
    const deadline = deadlineOf()
    await switched($, deadline)
    await settleLanded($, deadline)
    return next(e)
  }).catch(($, e, next) => passOn($, 'config.set', e, next))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const deadline = deadlineOf()
    await switched($, deadline)
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    const id = ran.result.backgroundTaskId
    if (id === undefined || id === '') return ran
    const now = await $.clock.now()
    const outputFile = outputFileOf(ran.text ?? '', id)
    if (outputFile === undefined) {
      report($, 'tool.call', `no output file in the result of task ${id}; its last line is unavailable`, `path|${id}`)
    }
    const note = shellLaunchNote(ran.result, outputFile !== undefined)
    const redirectFile = await redirectFor($, id, e.command, e.agentId)
    await writeJobs($, deadline, { at: now, ids: [id] }, jobs => launched(jobs, shellJob({ id, command: e.command, description: e.description, outputFile, redirectFile, note, ownerAgentId: e.agentId, endsWithAgent: ran.result.backgroundEndsWithFinalResponse === true }, now)))
    // The history read comes after the launch, so an end or a clear that comes meanwhile is never undone.
    const history = await historyFor($, e.command)
    if (history !== undefined) await writeJobs($, deadline, { at: now, ids: [id] }, jobs => historyAdded(jobs, id, history))
    return ran
  }).catch(($, e, next) => passOn($, 'tool.call{tool=Bash}', e, next))

  on('tool.call', { tool: 'Monitor' }, async ($, e, next) => {
    const deadline = deadlineOf()
    await switched($, deadline)
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    const now = await $.clock.now()
    const job = monitorJob({ id: ran.result.taskId, description: e.description, timeoutMs: ran.result.timeoutMs, isPersistent: ran.result.persistent === true }, now)
    await writeJobs($, deadline, { at: now, ids: [job.id] }, jobs => launched(jobs, job))
    return ran
  }).catch(($, e, next) => passOn($, 'tool.call{tool=Monitor}', e, next))

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const deadline = deadlineOf()
    await switched($, deadline)
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    // A foreground call answers `completed`, and a plugin's own call an AgentCallRecord (no status) once the agent settled: nothing runs.
    const result = ran.result
    if (!('status' in result) || (result.status !== 'async_launched' && result.status !== 'remote_launched' && result.status !== 'teammate_spawned')) return ran
    const now = await $.clock.now()
    // A teammate in a terminal pane of its own runs no loop here: its id is its address in its team.
    const isOwnPane = result.status === 'teammate_spawned' && (result.agentId ?? result.agent_id) === result.teammate_id
    const job =
      result.status === 'teammate_spawned'
        ? agentJob({ id: result.agentId ?? result.agent_id, description: e.description, ...(isOwnPane ? { note: 'own pane', runsElsewhere: true } : {}) }, now)
        : result.status === 'async_launched'
          ? agentJob({ id: result.agentId, description: result.description }, now)
          : agentJob({ id: result.taskId, description: result.description, note: 'remote', runsElsewhere: true }, now)
    await writeJobs($, deadline, { at: now, ids: [job.id] }, jobs => launched(jobs, job))
    return ran
  }).catch(($, e, next) => passOn($, 'tool.call{tool=Agent}', e, next))

  on('tool.call', { tool: 'Workflow' }, async ($, e, next) => {
    const deadline = deadlineOf()
    await switched($, deadline)
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true || ran.result.error !== undefined) return ran
    const now = await $.clock.now()
    const job = workflowJob({ id: ran.result.taskId, name: ran.result.workflowName }, now)
    await writeJobs($, deadline, { at: now, ids: [job.id] }, jobs => launched(jobs, job))
    return ran
  }).catch(($, e, next) => passOn($, 'tool.call{tool=Workflow}', e, next))

  on('tool.call', { tool: 'ScheduleWakeup' }, async ($, e, next) => {
    const deadline = deadlineOf()
    await switched($, deadline)
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    const now = await $.clock.now()
    const wakeup = ran.result.stopped === true ? null : wakeupOf(ran.result.scheduledFor, e.reason, now)
    await writeWakeup($, deadline, now, () => wakeup, true)
    return ran
  }).catch(($, e, next) => passOn($, 'tool.call{tool=ScheduleWakeup}', e, next))

  on('tool.call', { tool: 'TaskStop' }, async ($, e, next) => {
    const deadline = deadlineOf()
    await switched($, deadline)
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    const now = await $.clock.now()
    const id = ran.result.task_id
    await writeJobs($, deadline, { at: now, ids: [id] }, jobs => stoppedJob(jobs, id, now))
    return ran
  }).catch(($, e, next) => passOn($, 'tool.call{tool=TaskStop}', e, next))

  on('tool.call', async ($, e, next) => {
    const deadline = deadlineOf()
    await switched($, deadline)
    const agentId = e.agentId
    if (agentId === undefined) return next(e)
    if (!mirror.isLoaded) await loaded($)
    if (!memory.jobs.items.some(job => job.kind === 'agent' && job.id === agentId)) return next(e)
    const started = await $.clock.now()
    const summary = activityOf(String(e.tool), e)
    await writeJobs($, deadline, { at: started, ids: [agentId], kind: 'activity' }, jobs => activityStarted(jobs, agentId, summary, started))
    // A call that rejects counts as failed; the in-flight count drops whatever happens.
    let isFailure = true
    try {
      const ran = await next(e)
      isFailure = ran.deny !== undefined || ran.isError === true
      return ran
    } finally {
      const settled = await $.clock.now()
      await writeJobs($, deadline, { at: settled, ids: [agentId], kind: 'activity' }, jobs => activityEnded(jobs, agentId, isFailure, settled))
    }
  }).catch(($, e, next) => passOn($, 'tool.call', e, next))

  on('session.append', async ($, e, next) => {
    const deadline = deadlineOf()
    await switched($, deadline)
    if (e.agentId === undefined || e.origin.kind !== 'task-notification') return next(e)
    const now = await $.clock.now()
    const stored = await next(e)
    if (stored.deny !== undefined || stored.uuid !== e.uuid) return stored
    const text = stored.message.content.flatMap(block => block.type === 'text' && 'text' in block && typeof block.text === 'string' ? [block.text] : []).join('\n')
    await applyNotices($, deadline, text, JSON.stringify([e.agentId, stored.uuid]), now)
    return stored
  }).catch(($, e, next) => passOn($, 'session.append', e, next))

  on('turn.complete', async ($, e, next) => {
    const deadline = deadlineOf()
    await switched($, deadline)
    const now = await $.clock.now()
    const result = await next(e)
    const agentId = e.agentId
    if (agentId !== undefined && e.reason === 'answer' && !e.isAborted) await writeJobs($, deadline, { at: now }, jobs => ownerAnswered(jobs, agentId, now))
    // A subagent's turn end reads the agent list. A main-loop turn end runs the agent sync of classic.Stop and
    // classic.SubagentStop too: under managed settings or a Team or Enterprise login, those events do not reach the
    // mod. Where they do, both syncs read the same list, and the ordering rule keeps the newer reading.
    if (agentId !== undefined || memory.jobs.items.some(job => job.kind === 'agent')) await syncAgents($, deadline, await $.clock.now(), 'turn.complete')
    return result
  }).catch(($, e, next) => passOn($, 'turn.complete', e, next))

  on('prompt.submit', async ($, e, next) => {
    // The status answer reads the view, so a switch settles before it.
    const deadline = deadlineOf()
    await switched($, deadline)
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
    await reconcile($, deadline, 'classic.Stop', e)
    if (memory.jobs.items.some(job => job.kind === 'agent')) await syncAgents($, deadline, await $.clock.now(), 'classic.Stop')
    return next(e)
  }).catch(($, e, next) => passOn($, 'classic.Stop', e, next))

  on('classic.SubagentStop', async ($, e, next) => {
    const deadline = deadlineOf()
    await switched($, deadline)
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
