/** The ticker's period. */
export const TICK_MS = 1_000
/** A ticker with no period for this long has stopped (a refused period ends an interval); the next write starts it again. */
export const TICKER_STALE_MS = 3_000
/** The least time between two reads of one job's output. */
export const READ_EVERY_MS = 2_000
/** Outputs larger than this are read at most every LARGE_READ_EVERY_MS. */
export const LARGE_FILE_BYTES = 262_144
/** The least time between two reads of a large output. */
export const LARGE_READ_EVERY_MS = 10_000
/** The largest file $.fs.read reads (4 MiB); a larger output goes through `tail`. */
export const FS_READ_MAX = 4_194_304
/** Bytes `tail -c` returns, and characters kept from the end of a whole read. The `tail` call in register.tsx writes this number as the text '16384': change both together. */
export const TAIL_BYTES = 16_384
/** How long `tail` may run. */
export const TAIL_TIMEOUT_MS = 2_000
/** Display lines searched for progress, newest first. */
export const PROGRESS_LINES = 10
/** Characters before a ratio that decide whether it is a known progress counter, such as `Step` or `[builder `. */
export const COUNTER_CONTEXT = 256
/** The least time between anchor and sample before a rate ETA shows. */
export const ETA_MIN_SPAN_MS = 10_000
/** The least percentage-point gain before a rate ETA shows. */
export const ETA_MIN_GAIN = 1
/** Silence before a running shell or agent shows `quiet`. */
export const QUIET_MS = 120_000
/** Failed subagent calls in a row before the failing flag shows. */
export const FAILING_STREAK = 3
/** How long an ended job keeps the session live and shows in the band. */
export const RECENT_MS = 60_000
/** Ended jobs older than this leave the /downrange table. */
export const TABLE_RECENT_MS = 1_800_000
/** The most ended jobs in the /downrange table. */
export const TABLE_FINISHED_ROWS = 5
/** The most rows in the /downrange table. */
export const TABLE_MAX_ROWS = 15
/** A /downrange table narrower than this joins Kind into Job and ETA into Progress. */
export const TABLE_NARROW_COLUMNS = 100
/** Ended jobs kept in state. */
export const MAX_FINISHED = 20
/** Ordering barriers of tasks with no row kept in each of the jobs state's observed and removed lists. The oldest go first. A kept row's barriers stay and do not count. */
export const MAX_BARRIERS = 2_000
/** A wakeup this far past due is dropped. */
export const WAKEUP_STALE_MS = 600_000
/** A scheduled trigger this close before the due time clears the wakeup. */
export const TRIGGER_EARLY_MS = 5_000
/** A job or wakeup first seen this soon before a Stop or SubagentStop hook began may be newer than its snapshot, so absence does not end it. */
export const SNAPSHOT_SLACK_MS = 10_000
/** A repeated status prompt inside this window goes to Claude. */
export const REPEAT_WINDOW_MS = 60_000
/** Durations kept per history key. */
export const MAX_RUNS = 5
/** History keys kept in the store. */
export const MAX_KEYS = 200
/** Lengths kept in state. */
export const TITLE_MAX = 120
export const LINE_MAX = 200
export const NOTE_MAX = 80
export const ACTIVITY_MAX = 60
/** The longest unknown status word a diagnostic quotes. */
export const STATUS_WORD_MAX = 20
/** Lengths in the /downrange table, wide and narrow. */
export const CELL_TITLE_MAX = 40
export const CELL_LINE_MAX = 80
export const CELL_LINE_NARROW_MAX = 40
/** Band layout: room for the two buttons, and the longest snippet title. */
export const BAND_BUTTONS_COLUMNS = 20
export const BAND_TITLE_MAX = 24
/** Pane layout. */
export const BAR_CELLS = 10
export const BAR_MIN_COLUMNS = 60
export const PANE_TITLE_MIN = 12
export const PANE_FIXED_COLUMNS = 44

/** Stored child rows retained for duplicate suppression. */
export const NOTICE_ROWS_MAX = 256
/** The longest wait of a hook for the mirror write that holds its change; past it, the hook goes on with the change in memory only. */
export const MIRROR_WAIT_MS = 2_000
/** Sessions of one process whose start time for Finished stays in memory, for a /resume back to them; the oldest goes first. */
export const MAX_SESSIONS = 32
/** The waits after a call's result row of the reads of its stored result, in ms; after the last read, the call has no result. */
export const LOOKUP_DELAYS_MS: readonly number[] = [0, 50, 100, 250, 1_000, 3_000]
/** Newest rows that a read of stored results asks for when it cannot read on from the call's own response row. */
export const LOOKUP_LAST = 8
/** A result row that a read still lists this long after it came, with no stored result, makes that read also ask for the newest rows. */
export const BARE_RESULT_MS = 250
/** Characters that a call which waits for its stored result keeps of its result text: from its start, and from each output notice on (see keptTextOf). */
export const KEPT_TEXT_MAX = 2_048
/** The longest Monitor deadline: the Monitor tool caps a larger `timeout_ms` to this. */
export const MONITOR_TIMEOUT_MAX_MS = 1_800_000
/** Inputs of tool calls kept until their result row comes; the oldest goes first. */
export const INPUTS_MAX = 512
/** Result rows that wait for their stored result; past it, the oldest goes on with its text only. */
export const WAITING_MAX = 256
/** Tool use ids kept so that no call applies twice; the oldest goes first. */
export const DELIVERED_MAX = 2_000
/** A result row this young at a notification, a snapshot, or a turn end waits until this age for its stored result, which Claude Code stores about 55 ms after the row. */
export const FIRST_HOLD_MS = 100
/** The longest wait for stored results before a notification, a snapshot, a turn end, the table, or Clear finished applies. */
export const FIRST_WAIT_MS = 2_000
/** The longest wait for stored results before a slash command or a /config change, which can reload the mod. */
export const FLUSH_WAIT_MS = 1_000
/** Rows of an agent that Downrange does not track yet wait this long at most for its launch, this many per agent. */
export const EARLY_ROWS_MS = 5_000
export const EARLY_ROWS_MAX = 64
/** Agents whose rows wait for their launch at once; the oldest goes first. */
export const EARLY_AGENTS_MAX = 32
/** Tool calls of one agent that count as in flight at once; past it, the oldest closes. */
export const OPEN_CALLS_MAX = 64
/** A subagent's tool call with no result row for this long (2 hours) closes. */
export const OPEN_CALL_MS = 7_200_000
