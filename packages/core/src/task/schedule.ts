export * as TaskSchedule from "./schedule"

import { Cron } from "croner"
import { Schema } from "effect"

export class InvalidScheduleError extends Schema.TaggedErrorClass<InvalidScheduleError>()("Task.InvalidScheduleError", {
  message: Schema.String,
}) {}

export interface Schedule {
  readonly cron: string
  readonly timezone?: string
}

/**
 * Validates a five-field cron expression and optional IANA timezone. Croner
 * accepts unknown timezone names, so the timezone is checked against
 * Intl.DateTimeFormat explicitly. Returns the error, or undefined when the
 * schedule is valid — synchronous on purpose so CRUD paths can fail fast
 * without an effectual boundary.
 */
export const validate = (input: Schedule): InvalidScheduleError | undefined => {
  if (input.timezone !== undefined) {
    try {
      new Intl.DateTimeFormat("en", { timeZone: input.timezone })
    } catch {
      return new InvalidScheduleError({ message: `Unknown timezone: ${input.timezone}` })
    }
  }
  try {
    new Cron(input.cron, input.timezone === undefined ? {} : { timezone: input.timezone })
    return undefined
  } catch (error) {
    return new InvalidScheduleError({ message: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * Next fire time strictly after `after` (epoch ms). Assumes a valid schedule;
 * invalid expressions stored outside the CRUD path would die loudly here.
 * The 1s offset keeps the query strictly-after: cron fires land on whole
 * seconds and croner strips milliseconds from its search base.
 */
export const nextAfter = (input: Schedule & { readonly after: number }): number => {
  const cron = new Cron(input.cron, input.timezone === undefined ? {} : { timezone: input.timezone })
  const next = cron.nextRun(new Date(input.after + 1000))
  if (!next) throw new InvalidScheduleError({ message: `schedule ${input.cron} has no future occurrence` })
  return next.getTime()
}
