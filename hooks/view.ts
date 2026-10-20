import type { AgentJob, Job, JobState, Wakeup } from '../types'
import { isRunning } from './jobs'
import {
  BAND_BUTTONS_COLUMNS,
  BAND_TITLE_MAX,
  BAR_CELLS,
  BAR_MIN_COLUMNS,
  CELL_LINE_MAX,
  CELL_LINE_NARROW_MAX,
  CELL_TITLE_MAX,
  FAILING_STREAK,
  NOTE_MAX,
  PANE_FIXED_COLUMNS,
  PANE_TITLE_MIN,
  QUIET_MS,
  LARGE_READ_EVERY_MS,
  TICK_MS,
  RECENT_MS,
  TABLE_FINISHED_ROWS,
  TABLE_MAX_ROWS,
  TABLE_NARROW_COLUMNS,
  TABLE_RECENT_MS,
} from './limits'
import { clip, durationText, etaText, oneLine, remainingByRate } from './output'

/** One job as every view shows it. */
export type Row = {
  id: string
  glyph: string
  tone: JobState
  title: string
  kind: string
  age: string
  progress?: string
  percent?: number
  bar?: string
  eta?: string
  isSlow: boolean
  last?: string
  tableLast?: string
  flag?: string
  note?: string
}

/** One colored piece of the band line. */
export type BandPart = { text: string; tone: 'plain' | 'failed' | 'done' }

/** What the pane draws. */
export type PaneModel = { header: string; running: Row[]; ended: Row[] }

const GLYPHS: Readonly<Record<JobState, string>> = { running: '●', completed: '✓', failed: '✗', stopped: '■', gone: '◌' }

/** The words before a redirect file's name in a row's note, as in `output: build.log`. */
const REDIRECT_NOTE = 'output: '

/** Where a shell row's lines come from when that is its redirect file: `output: <file name>`. */
function redirectNoteOf(job: Job): string | undefined {
  if (job.kind !== 'shell' || job.redirectFile === undefined || job.redirectBytes === undefined) return undefined
  return clip(oneLine(`${REDIRECT_NOTE}${job.redirectFile.split(/[\\/]/).pop() ?? ''}`), NOTE_MAX)
}

const endOf = (job: Job): number => job.endedAt ?? job.startedAt

/** The tool of a subagent's activity summary, `<tool>: <detail>`. */
const toolOf = (activity: string): string => activity.split(': ', 1)[0] ?? activity

/** Whether none of a subagent's tool calls can reach Downrange: it runs elsewhere, and no call of it ran here. */
const isUnseenAgent = (job: AgentJob): boolean => job.runsElsewhere === true && job.toolCount === 0

function byAge(jobs: readonly Job[]): { running: Job[]; ended: Job[] } {
  return {
    running: jobs.filter(isRunning).sort((a, b) => a.startedAt - b.startedAt),
    ended: jobs.filter(job => !isRunning(job)).sort((a, b) => endOf(b) - endOf(a)),
  }
}

/** The ETA text: rate, then usual duration, then the monitor deadline. */
function etaOf(job: Job, now: number): { text: string; isSlow: boolean } | undefined {
  if (!isRunning(job)) return undefined
  if ((job.kind === 'monitor' || (job.kind === 'shell' && job.successfulReadAt !== undefined)) && job.progress !== undefined) {
    if (job.progress.percent >= 100) return { text: 'finishing', isSlow: false }
    const remaining = job.anchor === undefined ? undefined : remainingByRate(job.progress, job.anchor, now)
    if (remaining !== undefined) return { text: etaText(remaining), isSlow: false }
  }
  if (job.kind === 'shell' && job.usualMs !== undefined) {
    const elapsed = now - job.startedAt
    return elapsed < job.usualMs
      ? { text: `${etaText(job.usualMs - elapsed)} usual`, isSlow: false }
      : { text: `usual ${etaText(job.usualMs)}`, isSlow: elapsed > 1.5 * job.usualMs }
  }
  if (job.kind === 'monitor' && job.deadline !== undefined) {
    return { text: job.deadline > now ? `ends in ${etaText(job.deadline - now)}` : 'ending', isSlow: false }
  }
  return undefined
}

/** The flags of a running job: a subagent's failed calls in a row, else silence for QUIET_MS. */
function flagOf(job: Job, now: number): string | undefined {
  if (!isRunning(job)) return undefined
  if (job.omittedAt !== undefined) return 'awaiting confirmation'
  if (job.kind === 'agent' && job.activityStatus !== undefined && job.activityStatus !== 'running') return undefined
  if (job.kind === 'agent' && job.errorStreak >= FAILING_STREAK) return `${job.errorStreak} failed calls in a row`
  const quiet = now - (job.lastOutputAt ?? job.startedAt)
  const canBeQuiet = (job.kind === 'shell' && job.successfulReadAt !== undefined && now - job.successfulReadAt <= LARGE_READ_EVERY_MS + TICK_MS) || (job.kind === 'agent' && job.inFlight === 0 && !isUnseenAgent(job))
  return canBeQuiet && quiet >= QUIET_MS ? `quiet ${durationText(quiet)}` : undefined
}

function progressCell(job: Job): { text?: string; percent?: number } {
  if (!isRunning(job)) return { text: job.exitCode === undefined ? undefined : `exit ${job.exitCode}` }
  if ((job.kind === 'shell' || job.kind === 'monitor') && job.progress !== undefined) {
    const { label, percent } = job.progress
    return { text: label.endsWith('%') ? label : `${label} (${Math.round(percent)}%)`, percent }
  }
  if (job.kind === 'monitor' && job.eventCount > 0) return { text: `${job.eventCount} event${job.eventCount === 1 ? '' : 's'}` }
  if (job.kind === 'agent') {
    const text = [job.activityStatus === 'running' ? undefined : job.activityStatus, isUnseenAgent(job) ? undefined : `${job.toolCount} tool${job.toolCount === 1 ? '' : 's'}`].filter(Boolean).join(' · ')
    return { text: text === '' ? undefined : text }
  }
  return {}
}

function ageOf(job: Job, now: number): string {
  if (isRunning(job)) return `${job.isStartSeen ? '' : '≥'}${durationText(now - job.startedAt)}`
  return job.isStartSeen ? `took ${durationText(endOf(job) - job.startedAt)}` : 'ended'
}

function rowOf(job: Job, now: number): Row {
  const eta = etaOf(job, now)
  const progress = progressCell(job)
  const redirect = redirectNoteOf(job)
  return {
    id: job.id,
    glyph: GLYPHS[job.state],
    tone: job.state,
    title: job.title,
    kind: job.kind === 'task' ? job.taskType : job.kind,
    age: ageOf(job, now),
    progress: progress.text,
    percent: progress.percent,
    eta: eta?.text,
    isSlow: eta?.isSlow ?? false,
    last: job.lastLine,
    tableLast: job.kind === 'agent' && job.lastLine !== undefined ? toolOf(job.lastLine) : job.lastLine,
    flag: flagOf(job, now),
    note: redirect === undefined || job.note === undefined ? job.note ?? redirect : `${job.note} · ${redirect}`,
  }
}

function wakeupText(wakeup: Wakeup, now: number): string {
  return wakeup.dueAt > now ? `in ${durationText(wakeup.dueAt - now)}` : 'due now'
}

function headerOf(jobs: readonly Job[], wakeup: Wakeup | null, now: number): string {
  const running = jobs.filter(isRunning).length
  const failed = jobs.filter(job => job.state === 'failed' && now - endOf(job) <= TABLE_RECENT_MS).length
  return [
    ...(running > 0 ? [`${running} running`] : []),
    ...(failed > 0 ? [`${failed} failed`] : []),
    ...(wakeup === null ? [] : [`wakeup ${wakeupText(wakeup, now)} (${oneLine(wakeup.reason)})`]),
  ].join(' · ')
}

/** A table cell: one line, cut, with table syntax escaped; backslashes before a pipe double and one more escapes the pipe, so the pipe never ends the cell. */
const cell = (text: string, max: number): string =>
  clip(oneLine(text), max)
    .replace(/(\\*)\|/g, (_, slashes: string) => `${slashes}${slashes}\\|`)
    .replace(/`/g, "'")

/** Code spans keep backslashes literally. Put escaped table pipes between spans so their escapes cannot change the output. */
const codeCell = (text: string, max: number): string =>
  clip(oneLine(text), max)
    .replace(/`/g, "'")
    .split('|')
    .map(part => part === '' ? '' : `\`${part.trim() !== '' && part.startsWith(' ') && part.endsWith(' ') ? ` ${part} ` : part}\``)
    .join('\\|')

/**
 * One table row: the last output in backticks, then the flag and the note; a narrow table joins Kind into Job and ETA
 * into Progress. A subagent row shows its tool alone: the table enters the conversation, and a tool's input can hold
 * text that the main model never saw.
 */
function tableRow(row: Row, isNarrow: boolean): string {
  const last =
    [
      ...(row.tableLast === undefined ? [] : [codeCell(row.tableLast, isNarrow ? CELL_LINE_NARROW_MAX : CELL_LINE_MAX)]),
      ...(row.flag === undefined ? [] : [row.flag]),
      ...(row.note === undefined ? [] : [cell(row.note, NOTE_MAX)]),
    ].join(' · ') || '—'
  const title = cell(row.title, CELL_TITLE_MAX)
  const kind = cell(row.kind, CELL_TITLE_MAX)
  if (!isNarrow) return `| ${row.glyph} | ${title} | ${kind} | ${row.age} | ${row.progress ?? '—'} | ${row.eta ?? '—'} | ${last} |`
  const progress = [row.progress, row.eta].filter(part => part !== undefined).join(' · ') || '—'
  return `| ${row.glyph} | ${title} (${kind}) | ${row.age} | ${progress} | ${last} |`
}

/** The /downrange table: running jobs, then up to 5 jobs that ended in the last 30 minutes; below TABLE_NARROW_COLUMNS, five columns. */
export function tableOf(jobs: readonly Job[], wakeup: Wakeup | null, now: number, columns = TABLE_NARROW_COLUMNS, named = true): string {
  const { running, ended } = byAge(jobs)
  const shown = [...running, ...ended.filter(job => now - endOf(job) <= TABLE_RECENT_MS).slice(0, TABLE_FINISHED_ROWS)]
  if (shown.length === 0 && wakeup === null) return named ? '**Downrange**: no background work right now.' : 'No background work right now.'
  const header = [named ? '**Downrange**' : '', headerOf(jobs, wakeup, now)].filter(part => part !== '').join(' · ')
  if (shown.length === 0) return header
  const isNarrow = columns < TABLE_NARROW_COLUMNS
  const more = shown.length > TABLE_MAX_ROWS ? ['', `+${shown.length - TABLE_MAX_ROWS} more: /downrange pane shows all.`] : []
  return [
    header,
    '',
    isNarrow ? '| | Job | Age | Progress | Last output |' : '| | Job | Kind | Age | Progress | ETA | Last output |',
    isNarrow ? '| --- | --- | --- | --- | --- |' : '| --- | --- | --- | --- | --- | --- | --- |',
    ...shown.slice(0, TABLE_MAX_ROWS).map(job => tableRow(rowOf(job, now), isNarrow)),
    ...more,
  ].join('\n')
}

function snippetOf(job: Job, now: number): BandPart {
  const title = clip(job.title, BAND_TITLE_MAX)
  if (job.state === 'failed') return { text: `✗ ${title} ${job.exitCode === undefined ? 'failed' : `exit ${job.exitCode}`}`, tone: 'failed' }
  if (!isRunning(job)) return { text: `${GLYPHS[job.state]} ${title}`, tone: 'done' }
  const row = rowOf(job, now)
  const detail = [row.progress, row.eta].filter(part => part !== undefined).join(' ')
  return { text: `${title} ${detail === '' ? row.age : detail}`, tone: 'plain' }
}

/** The band line: counts first, then as many job snippets as the width holds. */
export function bandOf(jobs: readonly Job[], wakeup: Wakeup | null, now: number, columns: number): BandPart[] {
  const { running, ended } = byAge(jobs)
  const recent = ended.filter(job => now - endOf(job) < RECENT_MS)
  const failed = recent.filter(job => job.state === 'failed')
  const counts: BandPart[] = [
    ...(running.length > 0 ? [{ text: `● ${running.length} running`, tone: 'plain' as const }] : []),
    ...(failed.length > 0 ? [{ text: `✗ ${failed.length} failed`, tone: 'failed' as const }] : []),
    ...(wakeup === null ? [] : [{ text: `◷ ${wakeupText(wakeup, now)}`, tone: 'plain' as const }]),
  ]
  const hasProgress = (job: Job) => (job.kind === 'shell' || job.kind === 'monitor') && job.progress !== undefined
  const queue = [...failed, ...running.filter(hasProgress), ...running.filter(job => !hasProgress(job)), ...recent.filter(job => job.state !== 'failed')]
  const budget = columns - BAND_BUTTONS_COLUMNS
  const snippets: BandPart[] = []
  let used = counts.reduce((sum, part, index) => sum + part.text.length + (index === 0 ? 0 : 2), 0)
  for (const job of queue) {
    const snippet = snippetOf(job, now)
    if (used + snippet.text.length + 3 > budget) break
    snippets.push(snippet)
    used += snippet.text.length + 3
  }
  const joined = (parts: readonly BandPart[], separator: string): BandPart[] =>
    parts.flatMap((part, index) => (index === 0 ? [part] : [{ text: separator, tone: 'plain' as const }, part]))
  const divider: BandPart[] = counts.length > 0 && snippets.length > 0 ? [{ text: ' │ ', tone: 'plain' }] : []
  return [...joined(counts, '  '), ...divider, ...joined(snippets, ' · ')]
}

/** The band's sign of its keyboard path, drawn dim in the free room right before its first Button. */
const BAND_KEY_HINT = 'ctrl+x tab to choose'

/** Code point ranges a terminal draws two cells wide: every East Asian Wide (W) and Fullwidth (F) range of Unicode 17.0.0. A terminal that follows an older Unicode can draw some of them one cell wide, so the count errs toward less room. */
const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f],
  [0x231a, 0x231b],
  [0x2329, 0x232a],
  [0x23e9, 0x23ec],
  [0x23f0, 0x23f0],
  [0x23f3, 0x23f3],
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2630, 0x2637],
  [0x2648, 0x2653],
  [0x267f, 0x267f],
  [0x268a, 0x268f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f3],
  [0x26f5, 0x26f5],
  [0x26fa, 0x26fa],
  [0x26fd, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
  [0x2e80, 0x2e99],
  [0x2e9b, 0x2ef3],
  [0x2f00, 0x2fd5],
  [0x2ff0, 0x303e],
  [0x3041, 0x3096],
  [0x3099, 0x30ff],
  [0x3105, 0x312f],
  [0x3131, 0x318e],
  [0x3190, 0x31e5],
  [0x31ef, 0x321e],
  [0x3220, 0x3247],
  [0x3250, 0xa48c],
  [0xa490, 0xa4c6],
  [0xa960, 0xa97c],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe52],
  [0xfe54, 0xfe66],
  [0xfe68, 0xfe6b],
  [0xff01, 0xff60],
  [0xffe0, 0xffe6],
  [0x16fe0, 0x16fe4],
  [0x16ff0, 0x16ff6],
  [0x17000, 0x18cd5],
  [0x18cff, 0x18d1e],
  [0x18d80, 0x18df2],
  [0x1aff0, 0x1aff3],
  [0x1aff5, 0x1affb],
  [0x1affd, 0x1affe],
  [0x1b000, 0x1b122],
  [0x1b132, 0x1b132],
  [0x1b150, 0x1b152],
  [0x1b155, 0x1b155],
  [0x1b164, 0x1b167],
  [0x1b170, 0x1b2fb],
  [0x1d300, 0x1d356],
  [0x1d360, 0x1d376],
  [0x1f004, 0x1f004],
  [0x1f0cf, 0x1f0cf],
  [0x1f18e, 0x1f18e],
  [0x1f191, 0x1f19a],
  [0x1f200, 0x1f202],
  [0x1f210, 0x1f23b],
  [0x1f240, 0x1f248],
  [0x1f250, 0x1f251],
  [0x1f260, 0x1f265],
  [0x1f300, 0x1f320],
  [0x1f32d, 0x1f335],
  [0x1f337, 0x1f37c],
  [0x1f37e, 0x1f393],
  [0x1f3a0, 0x1f3ca],
  [0x1f3cf, 0x1f3d3],
  [0x1f3e0, 0x1f3f0],
  [0x1f3f4, 0x1f3f4],
  [0x1f3f8, 0x1f43e],
  [0x1f440, 0x1f440],
  [0x1f442, 0x1f4fc],
  [0x1f4ff, 0x1f53d],
  [0x1f54b, 0x1f54e],
  [0x1f550, 0x1f567],
  [0x1f57a, 0x1f57a],
  [0x1f595, 0x1f596],
  [0x1f5a4, 0x1f5a4],
  [0x1f5fb, 0x1f64f],
  [0x1f680, 0x1f6c5],
  [0x1f6cc, 0x1f6cc],
  [0x1f6d0, 0x1f6d2],
  [0x1f6d5, 0x1f6d8],
  [0x1f6dc, 0x1f6df],
  [0x1f6eb, 0x1f6ec],
  [0x1f6f4, 0x1f6fc],
  [0x1f7e0, 0x1f7eb],
  [0x1f7f0, 0x1f7f0],
  [0x1f90c, 0x1f93a],
  [0x1f93c, 0x1f945],
  [0x1f947, 0x1f9ff],
  [0x1fa70, 0x1fa7c],
  [0x1fa80, 0x1fa8a],
  [0x1fa8e, 0x1fac6],
  [0x1fac8, 0x1fac8],
  [0x1facd, 0x1fadc],
  [0x1fadf, 0x1faea],
  [0x1faef, 0x1faf8],
  [0x20000, 0x2fffd],
  [0x30000, 0x3fffd],
]
const EMOJI = /\p{Emoji_Presentation}/u
const ZERO_WIDTH = /[\p{Mn}\p{Me}\p{Cc}\p{Cf}]/u
/** U+FE0F asks for the emoji form of the character before it, two cells wide: it counts as that second cell. */
const EMOJI_FORM = 0xfe0f

/** The display cells of text: two for a wide or emoji character, none for a mark, a control, or a format character. An emoji sequence counts high, so a room check errs toward less. */
export function cellsOf(text: string): number {
  let cells = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (code === EMOJI_FORM) cells += 1
    else if (ZERO_WIDTH.test(char)) continue
    else if (EMOJI.test(char) || WIDE_RANGES.some(([first, last]) => code >= first && code <= last)) cells += 2
    else cells += 1
  }
  return cells
}

/** The key hint when the row holds it after the band line, before the Buttons, with a one-cell gap; the band line keeps all its room, in display cells. */
export function bandHintOf(parts: readonly BandPart[], columns: number): string | undefined {
  const line = parts.reduce((sum, part) => sum + cellsOf(part.text), 0)
  return line + 1 + cellsOf(BAND_KEY_HINT) + BAND_BUTTONS_COLUMNS <= columns ? BAND_KEY_HINT : undefined
}

/** Hidden: the user pressed Hide, and no job started after that. */
export function isBandHidden(jobs: readonly Job[], hiddenAt: number | null): boolean {
  return hiddenAt !== null && jobs.every(job => job.startedAt <= hiddenAt)
}

function barOf(percent: number): string {
  const filled = Math.min(BAR_CELLS, Math.max(0, Math.round((percent / 100) * BAR_CELLS)))
  return '▰'.repeat(filled) + '▱'.repeat(BAR_CELLS - filled)
}

/** The pane's model: titles fit the width; bars show from BAR_MIN_COLUMNS. */
export function paneModelOf(jobs: readonly Job[], wakeup: Wakeup | null, now: number, columns: number): PaneModel {
  const { running, ended } = byAge(jobs)
  const titleWidth = Math.max(PANE_TITLE_MIN, columns - PANE_FIXED_COLUMNS)
  const shape = (job: Job): Row => {
    const row = rowOf(job, now)
    return { ...row, title: clip(row.title, titleWidth), bar: columns >= BAR_MIN_COLUMNS && row.percent !== undefined ? barOf(row.percent) : undefined }
  }
  return { header: headerOf(jobs, wakeup, now), running: running.map(shape), ended: ended.map(shape) }
}
