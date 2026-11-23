export function readPartText(accum: Record<string, string> | undefined, part: { id: string; text?: string }): string {
  return (accum?.[part.id] ?? part.text ?? "").trim()
}

// Single-sentence reasoning reads inline ("Thinking: <text>") instead of a
// collapsed block. Sentences are counted by terminal punctuation followed by
// whitespace or end; known imprecision: abbreviations like "e.g." count as a
// terminator, so such texts collapse — harmless, it only changes the shape.
export function reasoningIsShort(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim()
  if (!normalized) return true
  return (normalized.match(/[.!?…]+(?=\s|$)/g)?.length ?? 1) < 2
}
