// Transcript rows of tool calls: what a `session.append` row and a `$.session.messages()` answer hold. Pure: no `$`,
// no I/O, no clock. The hooks in register.tsx read the rows and pass the time in.

import { keptTextOf } from './output'

/** A plain record: a tool's input or its stored result. */
export type Fields = Record<string, unknown>

/** One finished tool call, from its result row and the input its response row gave. */
export type RowCall = {
  /** The call's tool use id. */
  id: string
  tool: string
  /** The agent whose loop made the call; absent for the main loop. */
  agentId?: string
  /** The arguments the model gave; empty when the response row was not seen. */
  input: Fields
  /** What Claude read: the result row's text. A call inside a Code Mode script that succeeded has none. */
  text: string
  isError: boolean
  /** The tool's stored record, from `$.session.messages()`; absent when the transcript holds none. */
  result?: Fields
  /** When its result row came. */
  at: number
}

export const isFields = (value: unknown): value is Fields => typeof value === 'object' && value !== null && !Array.isArray(value)
export const stringOf = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)
export const numberOf = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)

/** The text of a tool_result block's content: a string, or its text blocks joined with newlines. */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.flatMap(block => (isFields(block) && block.type === 'text' && typeof block.text === 'string' ? [block.text] : [])).join('\n')
}

/**
 * The fields of each tracked tool's input that its change reads (see applyCall in register.tsx), each by its name:
 * a shell's command, description, and background setting, a Monitor's description, timeout, and persistent setting, a
 * subagent's description, a wakeup's reason, and the task id of a stop or its deprecated `shell_id`. A workflow reads
 * none. Downrange keeps no other field, such as an Agent's prompt or a Monitor's command.
 */
const INPUT_FIELDS: ReadonlyMap<string, (input: Fields) => Fields> = new Map<string, (input: Fields) => Fields>([
  ['Bash', ({ command, description, run_in_background }: Fields) => ({ command, description, run_in_background })],
  ['Monitor', ({ description, timeout_ms, persistent }: Fields) => ({ description, timeout_ms, persistent })],
  ['Agent', ({ description }: Fields) => ({ description })],
  ['ScheduleWakeup', ({ reason }: Fields) => ({ reason })],
  ['TaskStop', ({ task_id, shell_id }: Fields) => ({ task_id, shell_id })],
])

/** The fields of a call's input that the change of its tool reads (see INPUT_FIELDS); none for any other tool. */
export function callInputOf(tool: string, input: Fields): Fields {
  const fields = INPUT_FIELDS.get(tool)?.(input) ?? {}
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined))
}

/** The tracked tools whose change reads a call's result text: a shell's id and output file, and, with no stored result, a Monitor's or a teammate's id. */
const TEXT_TOOLS: ReadonlySet<string> = new Set(['Bash', 'Monitor', 'Agent'])

/** What a call that waits for its stored result keeps of its result text: the parts that keptTextOf keeps, for a tool that reads them; else nothing. */
export const waitingTextOf = (tool: string, text: string): string => (TEXT_TOOLS.has(tool) ? keptTextOf(text) : '')

/** The tool_use blocks of a response row. */
export function toolUsesOf(content: unknown): { id: string; name: string; input: Fields }[] {
  if (!Array.isArray(content)) return []
  return content.flatMap(block =>
    isFields(block) && block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string'
      ? [{ id: block.id, name: block.name, input: isFields(block.input) ? block.input : {} }]
      : [],
  )
}

/** The tool_result blocks of a result row. */
export function toolResultsOf(content: unknown): { id: string; text: string; isError: boolean }[] {
  if (!Array.isArray(content)) return []
  return content.flatMap(block =>
    isFields(block) && block.type === 'tool_result' && typeof block.tool_use_id === 'string'
      ? [{ id: block.tool_use_id, text: contentText(block.content), isError: block.is_error === true }]
      : [],
  )
}

/**
 * The stored results of the calls named in `wanted`, from what `$.session.messages()` answered: an assistant row's
 * `toolUses` entries, with the fields of their input that callInputOf keeps for the tool that the entry names, and a
 * user row's `toolResults`. A call counts only once its `result` is there: the transcript stores it a moment after the
 * result row, and never for a call inside a Code Mode script.
 */
export function resultsOf(rows: unknown, wanted: ReadonlySet<string>): Map<string, { result: unknown; input?: Fields }> {
  const inputs = new Map<string, Fields>()
  const found = new Map<string, { result: unknown; input?: Fields }>()
  if (!Array.isArray(rows)) return found
  const entries = rows.flatMap(row => (isFields(row) ? [...(Array.isArray(row.toolUses) ? row.toolUses : []), ...(Array.isArray(row.toolResults) ? row.toolResults : [])] : []))
  for (const entry of entries) {
    if (isFields(entry) && typeof entry.tool_use_id === 'string' && isFields(entry.input)) inputs.set(entry.tool_use_id, callInputOf(stringOf(entry.tool) ?? '', entry.input))
  }
  for (const entry of entries) {
    if (!isFields(entry) || typeof entry.tool_use_id !== 'string' || !wanted.has(entry.tool_use_id) || entry.result === undefined) continue
    const input = inputs.get(entry.tool_use_id)
    found.set(entry.tool_use_id, { result: entry.result, ...(input === undefined ? {} : { input }) })
  }
  return found
}

/** Whether the user rows of a `$.session.messages()` answer list the result of call `id`, with or without its stored result. */
export function isResultListed(rows: unknown, id: string): boolean {
  return Array.isArray(rows) && rows.some(row => isFields(row) && Array.isArray(row.toolResults) && row.toolResults.some(done => isFields(done) && done.tool_use_id === id))
}

/** The engine's words at the start of the result of a command that runs in the background. */
const BACKGROUND_START = /^Command running in background with ID: ([A-Za-z0-9_-]{1,128})\. Output is being written to: /

/** Whether a Bash result's text may say that the command runs in the background, so that its stored result names the task. */
export const isBackgroundText = (text: string): boolean => /background/i.test(text)

/**
 * The task id of a background command with no stored result: only for a call that asked for `run_in_background`, and
 * only from the engine's words at the start of its text. Output that a foreground command prints cannot pose as them.
 */
export function backgroundIdOf(input: Fields, text: string): string | undefined {
  if (input.run_in_background !== true && input.run_in_background !== 'true') return undefined
  return BACKGROUND_START.exec(text)?.[1]
}

/** The task id at the start of a Monitor result's text, `Monitor started (task <id>, ...`. */
export function monitorIdOf(text: string): string | undefined {
  return /^Monitor started \(task ([A-Za-z0-9_-]{1,128}),/.exec(text)?.[1]
}

/** The agent id of a teammate spawn's text, which starts `Spawned successfully.` and names it on an `agent_id:` line. */
export function teammateIdOf(text: string): string | undefined {
  if (!text.startsWith('Spawned successfully.')) return undefined
  return /^agent_id: ([A-Za-z0-9_.@-]{1,128})$/m.exec(text)?.[1]
}

/** The rows that wait for their agent's launch and are at most `maxAgeMs` old at `now`, in order; an agent with none left goes. */
export function earlyKept<T extends { at: number }>(early: ReadonlyMap<string, readonly T[]>, now: number, maxAgeMs: number): Map<string, T[]> {
  const kept = new Map<string, T[]>()
  for (const [agentId, list] of early) {
    const young = list.filter(one => now - one.at <= maxAgeMs)
    if (young.length > 0) kept.set(agentId, young)
  }
  return kept
}
