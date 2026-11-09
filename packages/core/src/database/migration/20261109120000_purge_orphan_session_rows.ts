import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261109120000_purge_orphan_session_rows",
  up(tx) {
    return Effect.gen(function* () {
      // Sessions deleted before foreign-key enforcement left their messages,
      // parts, and todos behind (217k+ rows on long-lived installs). The
      // projector now cascades through the schema's ON DELETE CASCADE, so
      // this only cleans the legacy rows once. Parts go first: their
      // message_id is intact even when the session is gone, but the message
      // purge below would hide them from a later pass.
      yield* tx.run(
        `DELETE FROM \`part\` WHERE \`session_id\` NOT IN (SELECT \`id\` FROM \`session\`);`,
      )
      yield* tx.run(
        `DELETE FROM \`message\` WHERE \`session_id\` NOT IN (SELECT \`id\` FROM \`session\`);`,
      )
      yield* tx.run(
        `DELETE FROM \`todo\` WHERE \`session_id\` NOT IN (SELECT \`id\` FROM \`session\`);`,
      )
      yield* tx.run(
        `DELETE FROM \`session_message\` WHERE \`session_id\` NOT IN (SELECT \`id\` FROM \`session\`);`,
      )
      yield* tx.run(
        `DELETE FROM \`session_input\` WHERE \`session_id\` NOT IN (SELECT \`id\` FROM \`session\`);`,
      )
      yield* tx.run(
        `DELETE FROM \`session_context_epoch\` WHERE \`session_id\` NOT IN (SELECT \`id\` FROM \`session\`);`,
      )
      yield* tx.run(
        `DELETE FROM \`session_sleep\` WHERE \`session_id\` NOT IN (SELECT \`id\` FROM \`session\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
