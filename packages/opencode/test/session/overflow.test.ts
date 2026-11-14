import { describe, expect, test } from "bun:test"
import { usable } from "@/session/overflow"

const model = (limits: { context: number; input?: number; output?: number }) =>
  ({
    limit: { context: limits.context, input: limits.input, output: limits.output },
  }) as any

describe("session.overflow.usable", () => {
  test("defaults to the reserved-token buffer", () => {
    const window = usable({ cfg: {}, model: model({ context: 200_000, output: 8_000 }) })
    // reserved = min(20_000, maxOutput) = 8_000
    expect(window).toBe(192_000)
  })

  test("a configured threshold is a direct fraction of the context window", () => {
    const window = usable({ cfg: { compaction: { threshold: 0.85 } }, model: model({ context: 200_000, output: 8_000 }) })
    expect(window).toBe(170_000)
  })

  test("a session threshold overrides the global threshold", () => {
    const window = usable({
      cfg: { compaction: { threshold: 0.85 } },
      model: model({ context: 200_000 }),
      session: { compactionThreshold: 0.7 } as any,
    })
    expect(window).toBe(140_000)
  })

  test("a null threshold resets to the default reserved-buffer behavior", () => {
    const window = usable({
      cfg: { compaction: { threshold: null } },
      model: model({ context: 200_000, output: 8_000 }),
    })
    expect(window).toBe(192_000)
  })

  test("threshold applies to the input limit when the model defines one", () => {
    const window = usable({
      cfg: { compaction: { threshold: 0.5 } },
      model: model({ context: 200_000, input: 100_000 }),
    })
    expect(window).toBe(50_000)
  })
})
