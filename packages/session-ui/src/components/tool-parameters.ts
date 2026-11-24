export function hasToolParameters(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  return Object.keys(value).length > 0
}

export function toolParametersText(value: unknown) {
  if (value === undefined) return ""
  if (typeof value === "string") return value
  return JSON.stringify(value, null, 2) ?? ""
}
