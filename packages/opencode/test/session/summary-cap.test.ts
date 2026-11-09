import { describe, expect, test } from "bun:test"
import { capFileDiffs } from "@/session/summary"

describe("session.summary.capFileDiffs", () => {
  const diff = (file: string) => ({ file, patch: "+x", additions: 1, deletions: 0 })

  test("drops dependency-tree entries regardless of separator style", () => {
    const out = capFileDiffs([
      diff(".venv/Lib/site-packages/PIL/Image.py"),
      diff("node_modules/left-pad/index.js"),
      diff("venv/lib/python3.12/site-packages/av/__init__.py"),
      diff("src/__pycache__/mod.pyc"),
      diff("E:\\work\\.venv\\Scripts\\activate.bat"),
      diff("src/real-change.ts"),
    ])
    expect(out.map((item) => item.file)).toEqual(["src/real-change.ts"])
  })

  test("keeps similarly-named files that are not dependency dirs", () => {
    const out = capFileDiffs([diff("src/venv-tools.ts"), diff(".venvful/app.py")])
    expect(out).toHaveLength(2)
  })

  test("caps the number of persisted entries", () => {
    const out = capFileDiffs(Array.from({ length: 1200 }, (_, i) => diff(`src/file-${i}.ts`)))
    expect(out).toHaveLength(500)
    expect(out[0]?.file).toBe("src/file-0.ts")
  })

  test("tolerates entries without a file path", () => {
    const out = capFileDiffs([{ file: undefined, patch: "+x", additions: 1, deletions: 0 }, diff("src/a.ts")])
    expect(out).toHaveLength(2)
  })
})
