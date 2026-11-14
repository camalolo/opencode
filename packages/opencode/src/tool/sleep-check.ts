export * as SleepCheck from "./sleep-check"

import { Option, Schema } from "effect"
import { PositiveInt } from "@opencode-ai/core/schema"

/**
 * The sleep_until micro-language: a closed set of typed checks that compile
 * to the `(observe, predicate, met_example)` triples the sleep engine already
 * stores, probes, and runs. The agent states intent; this module owns every
 * mechanical detail — shell quoting, progress lines, the pgrep bracket trick,
 * the fabricated positive — so the failure modes that used to surface as
 * arm-time refusals (inconsistent met_example, quoting bugs, self-matching
 * pgrep, silent exit 1) become unrepresentable for typed checks.
 *
 * Compiled triples flow through the existing arm-time proof gate unchanged;
 * for typed variants the gate doubles as a mechanical self-test of the
 * compiler. Two arm-time gates apply to agent-authored `custom` checks only:
 * `conditionClock` (the file_quiet predicate legitimately embeds `date +%s`,
 * which is engine-generated rather than an agent-authored time window) and
 * the rewrite advice on refusals.
 *
 * Typed checks compile to POSIX sh; on Windows only `custom` is accepted
 * (native per-variant evaluation is the eventual cross-platform fix).
 */

export const OutputMarker = Schema.Struct({
  type: Schema.Literal("output_marker"),
  command: Schema.String.annotate({
    description: "Command whose combined stdout+stderr is watched at every check.",
  }),
  marker: Schema.String.annotate({
    description: "Fixed string (not a regex) whose appearance in the command output means done. Single line.",
  }),
})

export const FileContains = Schema.Struct({
  type: Schema.Literal("file_contains"),
  path: Schema.String.annotate({
    description: "File to watch; its last 200 lines are the state document.",
  }),
  pattern: Schema.String.annotate({
    description: "Fixed string (not a regex) whose appearance in the file means done. Single line.",
  }),
})

export const ProcessExited = Schema.Struct({
  type: Schema.Literal("process_exited"),
  pattern: Schema.String.annotate({
    description: "Regex for pgrep -f matched against the full command line. Must start with a letter or digit.",
  }),
})

export const UrlStatus = Schema.Struct({
  type: Schema.Literal("url_status"),
  url: Schema.String.annotate({
    description: "HTTP(S) URL polled at every check.",
  }),
  expect: Schema.Number.annotate({
    description: "HTTP status code that means done (100-599).",
  }),
})

export const FileQuiet = Schema.Struct({
  type: Schema.Literal("file_quiet"),
  path: Schema.String.annotate({
    description: "File whose last-write time is watched. A missing file counts as quiet.",
  }),
  seconds: PositiveInt.annotate({
    description: "The file must be unwritten for at least this many seconds.",
  }),
})

export const CustomCheck = Schema.Struct({
  type: Schema.Literal("custom"),
  observe: Schema.String.annotate({
    description: "Shell command that prints the current state document to stdout (exit code ignored).",
  }),
  predicate: Schema.String.annotate({
    description: "Shell code reading the state document on stdin: exit 0 = met, exit 1 = unmet with a progress line.",
  }),
  met_example: Schema.String.annotate({
    description: "Literal state document that means done; proven to satisfy the predicate at arm time.",
  }),
})

export const Check = Schema.Union([OutputMarker, FileContains, ProcessExited, UrlStatus, FileQuiet, CustomCheck]).annotate({
  description:
    "What to wait for. Prefer a typed check; use custom only when no typed check fits. Typed checks compile to POSIX sh.",
  discriminator: "type",
})

export type Check = Schema.Schema.Type<typeof Check>

/** The triple the sleep engine runs, plus a human-readable rendering. */
export interface Compiled {
  readonly observe: string
  readonly predicate: string
  readonly met_example: string
  readonly human: string
}

export type CompiledCheck =
  | { readonly ok: true; readonly compiled: Compiled }
  | { readonly ok: false; readonly reason: string }

const fromJson = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)
const decodeCheck = Schema.decodeUnknownOption(Check)

const compact = (text: string) => {
  const one = text.replaceAll("\n", " ").trim()
  return one.length > 160 ? `${one.slice(0, 157)}…` : one
}

/**
 * Human-readable check description for status lines and wake messages.
 * Prefers the armed variant (re-compiling it is pure and deterministic);
 * falls back to the stored shell triple, then the legacy condition.
 */
export const describeTrigger = (trigger: {
  readonly variant?: string
  readonly observe?: string
  readonly predicate?: string
  readonly condition: string
}): string => {
  if (trigger.variant !== undefined) {
    const decoded = Option.flatMap(fromJson(trigger.variant), decodeCheck)
    if (Option.isSome(decoded)) {
      const compiled = compileCheck(decoded.value)
      if (compiled.ok) return compiled.compiled.human
    }
  }
  if (trigger.observe !== undefined && trigger.predicate !== undefined)
    return `${compact(trigger.observe)} | ${compact(trigger.predicate)}`
  return compact(trigger.condition)
}

/**
 * POSIX single-quote escaping: every character is literal inside single
 * quotes except the single quote itself, which closes, escapes, and reopens.
 */
const shquote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`

const refuse = (reason: string): CompiledCheck => ({ ok: false, reason })

const singleLine = (value: string, what: string): string | undefined => {
  if (value.length === 0) return `${what} must not be empty`
  // grep matches line by line; a multi-line fixed string can never match,
  // which would be a never-firing check.
  if (value.includes("\n")) return `${what} must be a single line`
  return undefined
}

export const compileCheck = (check: Check): CompiledCheck => {
  if (process.platform === "win32") {
    if (check.type === "custom")
      return {
        ok: true,
        compiled: {
          observe: check.observe,
          predicate: check.predicate,
          met_example: check.met_example,
          human: "custom shell check",
        },
      }
    return refuse(
      "typed checks compile to POSIX sh, which Windows cmd.exe cannot run; on Windows use check type custom with cmd.exe-compatible shell",
    )
  }
  switch (check.type) {
    case "output_marker":
      return outputMarker(check)
    case "file_contains":
      return fileContains(check)
    case "process_exited":
      return processExited(check)
    case "url_status":
      return urlStatus(check)
    case "file_quiet":
      return fileQuiet(check)
    case "custom":
      return {
        ok: true,
        compiled: {
          observe: check.observe,
          predicate: check.predicate,
          met_example: check.met_example,
          human: `custom check: ${check.observe}`,
        },
      }
  }
}

const outputMarker = (check: Schema.Schema.Type<typeof OutputMarker>): CompiledCheck => {
  const bad = singleLine(check.command, "command") ?? singleLine(check.marker, "marker")
  if (bad) return refuse(bad)
  return {
    ok: true,
    compiled: {
      observe: `${check.command} 2>&1`,
      predicate: `grep -qF -- ${shquote(check.marker)} && { echo ${shquote(`done: ${check.marker}`)}; exit 0; }; echo waiting for ${shquote(check.marker)} in command output; exit 1`,
      met_example: check.marker,
      human: `output of ${check.command} contains ${JSON.stringify(check.marker)}`,
    },
  }
}

const fileContains = (check: Schema.Schema.Type<typeof FileContains>): CompiledCheck => {
  const bad = singleLine(check.path, "path") ?? singleLine(check.pattern, "pattern")
  if (bad) return refuse(bad)
  return {
    ok: true,
    compiled: {
      observe: `tail -n 200 ${shquote(check.path)} 2>/dev/null`,
      predicate: `grep -qF -- ${shquote(check.pattern)} && { echo done: ${shquote(check.pattern)} found; exit 0; }; echo waiting for ${shquote(check.pattern)} in last 200 lines of ${shquote(check.path)}; exit 1`,
      met_example: check.pattern,
      human: `last 200 lines of ${check.path} contain ${JSON.stringify(check.pattern)}`,
    },
  }
}

/**
 * pgrep -f runs the condition text through `sh -c` (and ssh), so while the
 * check runs the full condition is some process's command line; an
 * unbracketed pattern would always find its own wrapper and never fire. The
 * bracket trick `[f]oo` fixes that only when the first character is a plain
 * literal — a leading `^` would turn the bracket into a negated class, and
 * `\` or `[` would change the meaning of the expression that follows — so
 * those patterns are refused rather than silently broken.
 */
const processExited = (check: Schema.Schema.Type<typeof ProcessExited>): CompiledCheck => {
  const pattern = check.pattern
  if (pattern.length === 0) return refuse("pattern must not be empty")
  const first = pattern[0]!
  if (!/[a-zA-Z0-9]/.test(first))
    return refuse(
      `pattern must start with a letter or digit (got ${JSON.stringify(first)}): the pattern is bracket-escaped (${JSON.stringify(`[${first}]${pattern.slice(1)}`)}) so the check cannot match its own wrapper shell, and that escape is only sound for a literal first character`,
    )
  try {
    new RegExp(pattern)
  } catch {
    return refuse(`pattern is not a valid regular expression: ${JSON.stringify(pattern)}`)
  }
  return {
    ok: true,
    compiled: {
      observe: `pgrep -f ${shquote(`[${first}]${pattern.slice(1)}`)} 2>/dev/null || true`,
      predicate: `grep -q . && { echo still running; exit 1; }; echo process exited`,
      met_example: "",
      human: `process matching /${pattern}/ exits`,
    },
  }
}

const urlStatus = (check: Schema.Schema.Type<typeof UrlStatus>): CompiledCheck => {
  if (!/^https?:\/\//.test(check.url)) return refuse("url must start with http:// or https://")
  if (!Number.isInteger(check.expect) || check.expect < 100 || check.expect > 599)
    return refuse(`expect must be an HTTP status code between 100 and 599 (got ${check.expect})`)
  // curl needs a bound well under the predicate's share of the check timeout
  // (half of check_timeout_seconds), or a hung server would eat the whole budget.
  const want = String(check.expect)
  return {
    ok: true,
    compiled: {
      observe: `curl -s -o /dev/null -w '%{http_code}' --max-time 12 ${shquote(check.url)}`,
      predicate: `code=$(cat); [ "$code" = ${shquote(want)} ] && { echo url status ${want}; exit 0; }; echo url status: $code, waiting for ${want}; exit 1`,
      met_example: want,
      human: `${check.url} responds with status ${want}`,
    },
  }
}

/**
 * A state comparison over file age: no wall-clock literal the agent authored,
 * and it cannot silently expire — it either observes enough quiet or the
 * trigger times out visibly. A missing file reads as mtime 0 (quiet forever),
 * which the arm-time live probe turns into an immediate "already met" refusal,
 * so a typo'd path is caught at arm time, not after a silent instant fire.
 */
const fileQuiet = (check: Schema.Schema.Type<typeof FileQuiet>): CompiledCheck => {
  const bad = singleLine(check.path, "path")
  if (bad) return refuse(bad)
  return {
    ok: true,
    compiled: {
      observe: `stat -c %Y ${shquote(check.path)} 2>/dev/null || echo 0`,
      predicate: `age=$(( $(date +%s) - $(cat) )); [ "$age" -ge ${check.seconds} ] && { echo quiet: no write for $age s; exit 0; }; echo last write $age s ago, waiting for ${check.seconds} s of quiet; exit 1`,
      met_example: "1",
      human: `${check.path} unwritten for ${check.seconds} s`,
    },
  }
}
