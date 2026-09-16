import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Message, UserMessage } from "@opencode-ai/sdk/v2"
import {
  isTimelineReady,
  loadFullHistoryTimeline,
  loadOlderTimeline,
  selectUserMessages,
  selectVisibleUserMessages,
} from "./model"

const user = (id: string) => ({ id, role: "user" }) as UserMessage
const assistant = (id: string) => ({ id, role: "assistant" }) as AssistantMessage

describe("timeline model", () => {
  test("selects users and applies the revert boundary", () => {
    const messages: Message[] = [user("msg_z"), assistant("msg_a"), user("msg_b"), user("msg_c")]
    const users = selectUserMessages(messages)

    expect(users.map((message) => message.id)).toEqual(["msg_z", "msg_b", "msg_c"])
    expect(selectVisibleUserMessages(users, "msg_b").map((message) => message.id)).toEqual(["msg_z"])
    expect(selectVisibleUserMessages(users)).toBe(users)
  })

  test("waits for an assistant-only load to hydrate its user root", () => {
    expect(isTimelineReady([assistant("msg_2")], true)).toBe(false)
    expect(isTimelineReady([user("msg_1"), assistant("msg_2")], true)).toBe(true)
    expect(isTimelineReady([], false)).toBe(true)
  })

  test("loads exactly one opaque cursor page", async () => {
    let calls = 0
    const anchors: Array<string | boolean> = []

    await loadOlderTimeline({
      sessionID: () => "ses_test",
      more: () => true,
      loading: () => false,
      loadMore: async () => {
        calls += 1
      },
      before: () => anchors.push("before"),
      after: (done) => anchors.push("after", done),
    })

    expect(calls).toBe(1)
    expect(anchors).toEqual(["before", "after", true])
  })

  test("stops when a page adds no raw messages", async () => {
    let calls = 0
    await loadOlderTimeline({
      sessionID: () => "ses_test",
      more: () => true,
      loading: () => false,
      loadMore: async () => {
        calls += 1
      },
    })

    expect(calls).toBe(1)
  })

  test("does not restore an anchor after the session changes", async () => {
    let sessionID = "ses_old"
    let restore = 0

    await loadOlderTimeline({
      sessionID: () => sessionID,
      more: () => true,
      loading: () => false,
      loadMore: async () => {
        sessionID = "ses_new"
      },
      after: () => {
        restore += 1
      },
    })

    expect(restore).toBe(0)
  })

  test("releases the anchor when loading history fails", async () => {
    let restore = 0

    await expect(
      loadOlderTimeline({
        sessionID: () => "ses_test",
        more: () => true,
        loading: () => false,
        loadMore: async () => {
          throw new Error("history failed")
        },
        after: () => {
          restore += 1
        },
      }),
    ).rejects.toThrow("history failed")

    expect(restore).toBe(1)
  })
})

describe("full history loader", () => {
  const harness = (pages: number[], sessionID = "ses_test") => {
    let index = 0
    let size = pages[0] ?? 0
    const calls: Array<number | undefined> = []
    return {
      calls,
      size: () => size,
      input: {
        sessionID: () => sessionID,
        more: () => index < pages.length - 1,
        loading: () => false,
        size: () => size,
        loadMore: async () => {
          calls.push(index)
          index++
          size = pages[Math.min(index, pages.length - 1)]
        },
      },
    }
  }

  test("pages until more() reports the transcript is complete", async () => {
    const state = harness([20, 220, 313])
    await loadFullHistoryTimeline(state.input)
    expect(state.calls).toEqual([0, 1])
  })

  test("stops when a page adds no messages", async () => {
    const state = harness([20, 20, 20])
    await loadFullHistoryTimeline(state.input)
    expect(state.calls).toEqual([0])
  })

  test("stops when the session changes mid-load", async () => {
    let sessionID = "ses_old"
    let calls = 0
    await loadFullHistoryTimeline({
      sessionID: () => sessionID,
      more: () => true,
      loading: () => false,
      size: () => 20,
      loadMore: async () => {
        calls++
        sessionID = "ses_new"
      },
    })
    expect(calls).toBe(1)
  })

  test("does nothing without a session", async () => {
    let calls = 0
    await loadFullHistoryTimeline({
      sessionID: () => undefined,
      more: () => true,
      loading: () => false,
      size: () => 0,
      loadMore: async () => {
        calls++
      },
    })
    expect(calls).toBe(0)
  })

  test("propagates load failures", async () => {
    await expect(
      loadFullHistoryTimeline({
        sessionID: () => "ses_test",
        more: () => true,
        loading: () => false,
        size: () => 20,
        loadMore: async () => {
          throw new Error("page failed")
        },
      }),
    ).rejects.toThrow("page failed")
  })
})
