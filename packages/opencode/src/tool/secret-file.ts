import path from "path"
import { Effect } from "effect"
import { InstanceState } from "@/effect/instance-state"

/**
 * Refuse model reads of stored secrets: they must be consumed through shell
 * redirection/pipes so the value never enters the conversation.
 */
export const assertNotSecretPath = (filepath: string) =>
  Effect.gen(function* () {
    const ins = yield* InstanceState.context
    const dir = path.join(ins.directory, ".opencode", "secrets")
    if (filepath === dir || filepath.startsWith(dir + path.sep)) {
      throw new Error(
        "This path holds a secret provided by the user. Never read it directly; consume it inside a shell command instead, e.g. `some-command < <path>`.",
      )
    }
  })

export * as SecretFile from "./secret-file"
