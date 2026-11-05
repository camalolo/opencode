export * as BrowserTools from "./tools"

import { Effect, Schema } from "effect"
import * as Tool from "@/tool/tool"
import { BrowserAgent } from "./agent"
import { BrowserDaemon } from "./daemon"

const text = (data: { content: string | object }, fallback: string): string => {
  if (typeof data.content === "string") return data.content
  if (data.content != null) return JSON.stringify(data.content)
  return fallback
}

const OptionalString = Schema.String.pipe(Schema.optional)
const OptionalNumber = Schema.Number.pipe(Schema.optional)
const OptionalBoolean = Schema.Boolean.pipe(Schema.optional)

const tab = Schema.String.annotate({
  description: "Tab id from browser_get_tabs or browser_open_tab. Omit to act on the active tab.",
})
const wait = {
  timeoutMs: OptionalNumber.annotate({
    description: "Wait until the selector matches before acting (ms). 0 disables waiting.",
  }),
  pollMs: OptionalNumber.annotate({ description: "Poll interval in ms while waiting for the selector." }),
}
const target = {
  index: OptionalNumber.annotate({ description: "0-based match index when multiple elements match the selector." }),
  tabId: tab,
  ...wait,
}

export const NavigateParameters = Schema.Struct({ url: Schema.String, tabId: tab })
export const ClickParameters = Schema.Struct({ selector: Schema.String, ...target })
export const TypeParameters = Schema.Struct({
  selector: Schema.String,
  text: Schema.String,
  clear: OptionalBoolean.annotate({ description: "Clear the element before typing." }),
  ...target,
})
export const SelectParameters = Schema.Struct({
  selector: Schema.String,
  value: OptionalString.annotate({ description: "Option value to select." }),
  label: OptionalString.annotate({ description: "Option label to select." }),
  optionIndex: OptionalNumber.annotate({ description: "0-based option index to select." }),
  ...target,
})
export const ScreenshotParameters = Schema.Struct({ tabId: tab })
export const SnapshotParameters = Schema.Struct({ tabId: tab })
export const ScrollParameters = Schema.Struct({
  selector: OptionalString.annotate({ description: "Scroll this element into view instead of scrolling by pixels." }),
  x: OptionalNumber.annotate({ description: "Horizontal scroll offset in px." }),
  y: OptionalNumber.annotate({ description: "Vertical scroll offset in px." }),
  ...wait,
  tabId: tab,
})
export const WaitParameters = Schema.Struct({ ms: OptionalNumber, tabId: tab })
export const QueryParameters = Schema.Struct({
  selector: OptionalString.annotate({ description: "CSS selector to read. Required for every mode except page_text." }),
  mode: OptionalString.annotate({
    description:
      "text (default) | value | attribute | property | html | list | exists | page_text. page_text extracts whole-page text (shadow DOM + same-origin iframes).",
  }),
  attribute: OptionalString.annotate({ description: "Attribute name for mode: attribute." }),
  property: OptionalString.annotate({ description: "Property name for mode: property." }),
  index: OptionalNumber,
  limit: OptionalNumber.annotate({ description: "Max items for mode: list (default 50), or max chars for page_text (default 20000)." }),
  pattern: OptionalString.annotate({ description: "Regex to highlight matches inside extracted page_text." }),
  flags: OptionalString.annotate({ description: "Regex flags for pattern (default \"i\")." }),
  ...wait,
  tabId: tab,
})
export const DownloadParameters = Schema.Struct({
  url: OptionalString,
  selector: OptionalString.annotate({ description: "Click this element to trigger the download instead of navigating." }),
  filename: OptionalString,
  conflictAction: OptionalString,
  saveAs: OptionalBoolean,
  wait: OptionalBoolean.annotate({ description: "Wait for the download to finish and return the local file path." }),
  downloadTimeoutMs: OptionalNumber,
  index: OptionalNumber,
  tabId: tab,
  ...wait,
})
export const ListDownloadsParameters = Schema.Struct({
  limit: OptionalNumber,
  state: OptionalString,
})
export const SetFileInputParameters = Schema.Struct({
  selector: Schema.String,
  filePath: Schema.String,
  fileName: OptionalString,
  mimeType: OptionalString,
  ...target,
})
export const HighlightParameters = Schema.Struct({
  selector: Schema.String,
  duration: OptionalNumber.annotate({ description: "How long the highlight stays visible (ms)." }),
  color: OptionalString,
  showInfo: OptionalBoolean,
  ...target,
})
export const ConsoleParameters = Schema.Struct({
  tabId: tab,
  clear: OptionalBoolean,
  filter: OptionalString,
})
export const ErrorsParameters = Schema.Struct({
  tabId: tab,
  clear: OptionalBoolean,
})
export const ClaimTabParameters = Schema.Struct({
  tabId: Schema.Number,
  force: OptionalBoolean,
})
export const ReleaseTabParameters = Schema.Struct({ tabId: Schema.Number })
export const OpenTabParameters = Schema.Struct({
  url: OptionalString,
  active: OptionalBoolean,
})
export const CloseTabParameters = Schema.Struct({ tabId: OptionalNumber })
export const EmptyParameters = Schema.Struct({})

type Result = Tool.ExecuteResult<{}>
const run = (input: () => Promise<Result>): Effect.Effect<Result> => Effect.tryPromise(input).pipe(Effect.orDie)

export const NavigateTool = Tool.define(
  "browser_navigate",
  Effect.succeed({
    description: "Navigate to a URL in the browser",
    parameters: NavigateParameters,
    execute: (params: Schema.Schema.Type<typeof NavigateParameters>, ctx: Tool.Context): Effect.Effect<Result> =>
      run(async () => {
        const data = await BrowserAgent.run("navigate", { url: params.url, tabId: params.tabId }, ctx.sessionID)
        return { title: `navigate ${params.url}`, output: text(data, `Navigated to ${params.url}`), metadata: {} }
      }),
  }),
)

export const ClickTool = Tool.define(
  "browser_click",
  Effect.succeed({
    description: "Click an element on the page using a CSS selector",
    parameters: ClickParameters,
    execute: (params: Schema.Schema.Type<typeof ClickParameters>, ctx: Tool.Context): Effect.Effect<Result> =>
      run(async () => {
        const data = await BrowserAgent.run("click", { ...params }, ctx.sessionID)
        return { title: `click ${params.selector}`, output: text(data, `Clicked ${params.selector}`), metadata: {} }
      }),
  }),
)

export const TypeTool = Tool.define(
  "browser_type",
  Effect.succeed({
    description: "Type text into an input element",
    parameters: TypeParameters,
    execute: (params: Schema.Schema.Type<typeof TypeParameters>, ctx: Tool.Context): Effect.Effect<Result> =>
      run(async () => {
        const data = await BrowserAgent.run("type", { ...params }, ctx.sessionID)
        return { title: `type ${params.selector}`, output: text(data, `Typed "${params.text}" into ${params.selector}`), metadata: {} }
      }),
  }),
)

export const SelectTool = Tool.define(
  "browser_select",
  Effect.succeed({
    description: "Select an option in a native select element",
    parameters: SelectParameters,
    execute: (params: Schema.Schema.Type<typeof SelectParameters>, ctx: Tool.Context): Effect.Effect<Result> =>
      run(async () => {
        const data = await BrowserAgent.run("select", { ...params }, ctx.sessionID)
        const summary = params.value ?? params.label ?? (params.optionIndex != null ? String(params.optionIndex) : "option")
        return { title: `select ${params.selector}`, output: text(data, `Selected ${summary} in ${params.selector}`), metadata: {} }
      }),
  }),
)

export const ScreenshotTool = Tool.define(
  "browser_screenshot",
  Effect.succeed({
    description: "Take a screenshot of the current page. Returns base64 image data URL.",
    parameters: ScreenshotParameters,
    execute: (params: Schema.Schema.Type<typeof ScreenshotParameters>, ctx: Tool.Context): Effect.Effect<Result> =>
      run(async () => {
        const data = await BrowserAgent.run("screenshot", { tabId: params.tabId }, ctx.sessionID)
        const url = text(data, "")
        if (!url.startsWith("data:")) throw new Error(url || "Screenshot failed")
        return {
          title: "screenshot",
          output: "Screenshot captured.",
          metadata: {},
          attachments: [{ type: "file" as const, mime: "image/png", url }],
        }
      }),
  }),
)

export const SnapshotTool = Tool.define(
  "browser_snapshot",
  Effect.succeed({
    description: "Get an accessibility tree snapshot of the page.",
    parameters: SnapshotParameters,
    execute: (params: Schema.Schema.Type<typeof SnapshotParameters>, ctx: Tool.Context): Effect.Effect<Result> =>
      run(async () => {
        const data = await BrowserAgent.run("snapshot", { tabId: params.tabId }, ctx.sessionID)
        return { title: "snapshot", output: text(data, "Snapshot failed"), metadata: {} }
      }),
  }),
)

export const ScrollTool = Tool.define(
  "browser_scroll",
  Effect.succeed({
    description: "Scroll the page or scroll an element into view",
    parameters: ScrollParameters,
    execute: (params: Schema.Schema.Type<typeof ScrollParameters>, ctx: Tool.Context): Effect.Effect<Result> =>
      run(async () => {
        const data = await BrowserAgent.run("scroll", { ...params }, ctx.sessionID)
        return { title: "scroll", output: text(data, "Scrolled"), metadata: {} }
      }),
  }),
)

export const WaitTool = Tool.define(
  "browser_wait",
  Effect.succeed({
    description: "Wait for a specified duration",
    parameters: WaitParameters,
    execute: (params: Schema.Schema.Type<typeof WaitParameters>, ctx: Tool.Context): Effect.Effect<Result> =>
      run(async () => {
        const data = await BrowserAgent.run("wait", { ms: params.ms, tabId: params.tabId }, ctx.sessionID)
        return { title: "wait", output: text(data, "Waited"), metadata: {} }
      }),
  }),
)

export const QueryTool = Tool.define(
  "browser_query",
  Effect.succeed({
    description:
      "Read data from the page using selectors, optional wait, or page_text extraction (shadow DOM + same-origin iframes).",
    parameters: QueryParameters,
    execute: (params: Schema.Schema.Type<typeof QueryParameters>, ctx: Tool.Context): Effect.Effect<Result> =>
      run(async () => {
        const data = await BrowserAgent.run("query", { ...params }, ctx.sessionID)
        return { title: `query ${params.mode ?? "text"}`, output: text(data, "Query failed"), metadata: {} }
      }),
  }),
)

export const DownloadTool = Tool.define(
  "browser_download",
  Effect.succeed({
    description: "Download a file via URL or by clicking an element on the page.",
    parameters: DownloadParameters,
    execute: (params: Schema.Schema.Type<typeof DownloadParameters>, ctx: Tool.Context): Effect.Effect<Result> =>
      run(async () => {
        const data = await BrowserAgent.run("download", { ...params }, ctx.sessionID)
        return { title: "download", output: text(data, "Download started"), metadata: {} }
      }),
  }),
)

export const ListDownloadsTool = Tool.define(
  "browser_list_downloads",
  Effect.succeed({
    description: "List recent downloads (Chrome backend) or session downloads (agent backend).",
    parameters: ListDownloadsParameters,
    execute: (_params: Schema.Schema.Type<typeof ListDownloadsParameters>, _ctx: Tool.Context): Effect.Effect<Result> =>
      run(async () => {
        const data = await BrowserAgent.run("list_downloads", {}, "")
        return { title: "downloads", output: text(data, "[]"), metadata: {} }
      }),
  }),
)

export const SetFileInputTool = Tool.define(
  "browser_set_file_input",
  Effect.succeed({
    description: "Set a file input element's selected file using a local file path.",
    parameters: SetFileInputParameters,
    execute: (params: Schema.Schema.Type<typeof SetFileInputParameters>, ctx: Tool.Context): Effect.Effect<Result> =>
      run(async () => {
        const data = await BrowserAgent.run("set_file_input", { ...params }, ctx.sessionID)
        return { title: `set_file_input ${params.selector}`, output: text(data, "Set file input"), metadata: {} }
      }),
  }),
)

export const HighlightTool = Tool.define(
  "browser_highlight",
  Effect.succeed({
    description: "Highlight an element on the page with a colored border for visual debugging.",
    parameters: HighlightParameters,
    execute: (params: Schema.Schema.Type<typeof HighlightParameters>, ctx: Tool.Context): Effect.Effect<Result> =>
      run(async () => {
        const data = await BrowserAgent.run("highlight", { ...params }, ctx.sessionID)
        return { title: `highlight ${params.selector}`, output: text(data, "Highlight failed"), metadata: {} }
      }),
  }),
)

export const ConsoleTool = Tool.define(
  "browser_console",
  Effect.succeed({
    description: "Read console log messages from the page. Uses chrome.debugger API for complete capture. " +
      "The debugger attaches lazily on first call and may show a banner in the browser.",
    parameters: ConsoleParameters,
    execute: (params: Schema.Schema.Type<typeof ConsoleParameters>, ctx: Tool.Context): Effect.Effect<Result> =>
      run(async () => {
        const data = await BrowserAgent.run("console", { tabId: params.tabId, clear: params.clear, filter: params.filter }, ctx.sessionID)
        return { title: "console", output: text(data, "[]"), metadata: {} }
      }),
  }),
)

export const ErrorsTool = Tool.define(
  "browser_errors",
  Effect.succeed({
    description: "Read JavaScript errors from the page. Uses chrome.debugger API for complete capture. " +
      "The debugger attaches lazily on first call and may show a banner in the browser.",
    parameters: ErrorsParameters,
    execute: (params: Schema.Schema.Type<typeof ErrorsParameters>, ctx: Tool.Context): Effect.Effect<Result> =>
      run(async () => {
        const data = await BrowserAgent.run("errors", { tabId: params.tabId, clear: params.clear }, ctx.sessionID)
        return { title: "errors", output: text(data, "[]"), metadata: {} }
      }),
  }),
)

export const CdpTool = Tool.define(
  "browser_cdp",
  Effect.succeed({
    description:
      "Get the raw CDP endpoint of the automation browser (agent-browser backend only). " +
      "Returns port, browserWs and httpBase. Re-run before EVERY attach: the browser relaunches on daemon recycle (~every 6h) and gets a new ephemeral port and new target UUIDs. " +
      "Never send an Origin header when connecting (Chromium rejects it with 403). List pages via GET httpBase + /json/list; attach browser-level via browserWs.",
    parameters: EmptyParameters,
    execute: (_params: Schema.Schema.Type<typeof EmptyParameters>, _ctx: Tool.Context): Effect.Effect<Result> =>
      run(async () => {
        const data = await BrowserAgent.run("cdp", {}, "")
        return { title: "cdp endpoint", output: text(data, "{}"), metadata: {} }
      }),
  }),
)

export const OpenTabTool = Tool.define(
  "browser_open_tab",
  Effect.succeed({
    description: "Open a new browser tab",
    parameters: OpenTabParameters,
    execute: (params: Schema.Schema.Type<typeof OpenTabParameters>, ctx: Tool.Context): Effect.Effect<Result> =>
      run(async () => {
        const data = await BrowserAgent.run("open_tab", { url: params.url, active: params.active }, ctx.sessionID)
        return { title: "open tab", output: text(data, "Opened new tab"), metadata: {} }
      }),
  }),
)

export const CloseTabTool = Tool.define(
  "browser_close_tab",
  Effect.succeed({
    description: "Close a browser tab owned by this session",
    parameters: CloseTabParameters,
    execute: (params: Schema.Schema.Type<typeof CloseTabParameters>, ctx: Tool.Context): Effect.Effect<Result> =>
      run(async () => {
        const data = await BrowserAgent.run("close_tab", { tabId: params.tabId }, ctx.sessionID)
        return { title: "close tab", output: text(data, "Closed tab"), metadata: {} }
      }),
  }),
)

export const GetTabsTool = Tool.define(
  "browser_get_tabs",
  Effect.succeed({
    description: "List all open browser tabs",
    parameters: EmptyParameters,
    execute: (_params: Schema.Schema.Type<typeof EmptyParameters>, _ctx: Tool.Context): Effect.Effect<Result> =>
      run(async () => {
        const data = await BrowserAgent.run("get_tabs", {}, "")
        return { title: "tabs", output: text(data, "ok"), metadata: {} }
      }),
  }),
)

export const ListClaimsTool = Tool.define(
  "browser_list_claims",
  Effect.succeed({
    description: "List tab ownership claims",
    parameters: EmptyParameters,
    execute: (_params: Schema.Schema.Type<typeof EmptyParameters>, _ctx: Tool.Context): Effect.Effect<Result> =>
      Effect.succeed({
        title: "claims",
        output: JSON.stringify(BrowserAgent.listClaims()),
        metadata: {},
      }),
  }),
)

export const ClaimTabTool = Tool.define(
  "browser_claim_tab",
  Effect.succeed({
    description: "Claim a browser tab for this session",
    parameters: ClaimTabParameters,
    execute: (params: Schema.Schema.Type<typeof ClaimTabParameters>, ctx: Tool.Context): Effect.Effect<Result> =>
      Effect.suspend(() => {
        const claim = BrowserAgent.claimTab(params.tabId, ctx.sessionID, params.force)
        if ("conflict" in claim) {
          return Effect.succeed({
            title: `claim tab ${claim.tabId}`,
            output: `Tab ${claim.tabId} is already claimed by session ${claim.owner}. Pass force: true to take it over.`,
            metadata: {},
          })
        }
        return Effect.succeed({ title: `claim tab ${claim.tabId}`, output: JSON.stringify(claim), metadata: {} })
      }),
  }),
)

export const ReleaseTabTool = Tool.define(
  "browser_release_tab",
  Effect.succeed({
    description: "Release a claimed browser tab",
    parameters: ReleaseTabParameters,
    execute: (params: Schema.Schema.Type<typeof ReleaseTabParameters>, ctx: Tool.Context): Effect.Effect<Result> =>
      Effect.succeed({
        title: `release tab ${params.tabId}`,
        output: JSON.stringify(BrowserAgent.releaseTab(params.tabId, ctx.sessionID)),
        metadata: {},
      }),
  }),
)

export const StatusTool = Tool.define(
  "browser_status",
  Effect.succeed({
    description: "Check backend connection status and current tab claims.",
    parameters: EmptyParameters,
    execute: (_params: Schema.Schema.Type<typeof EmptyParameters>, _ctx: Tool.Context): Effect.Effect<Result> =>
      run(async () => {
        const state = BrowserDaemon.status()
        const health = await BrowserDaemon.healthy()
        return {
          title: "browser status",
          output: JSON.stringify({ ...state, ...health, claims: BrowserAgent.listClaims() }),
          metadata: {},
        }
      }),
  }),
)

export const VersionTool = Tool.define(
  "browser_version",
  Effect.succeed({
    description: "Return the installed @different-ai/opencode-browser plugin version.",
    parameters: EmptyParameters,
    execute: (_params: Schema.Schema.Type<typeof EmptyParameters>, _ctx: Tool.Context): Effect.Effect<Result> =>
      Effect.succeed({
        title: "browser version",
        output: JSON.stringify({
          name: "opencode built-in browser",
          version: BrowserDaemon.daemonVersion(),
          backend: "agent-browser",
        }),
        metadata: {},
      }),
  }),
)

export const DebugTool = Tool.define(
  "browser_debug",
  Effect.succeed({
    description: "Debug plugin loading and connection status.",
    parameters: EmptyParameters,
    execute: (_params: Schema.Schema.Type<typeof EmptyParameters>, _ctx: Tool.Context): Effect.Effect<Result> =>
      Effect.succeed({
        title: "browser debug",
        output: [
          "loaded: true",
          `backend: agent-browser (built-in)`,
          `agentSession: ${BrowserDaemon.status().session}`,
          `agentConnection: ${JSON.stringify(BrowserDaemon.status().connection)}`,
          `agentBrowserVersion: ${BrowserDaemon.daemonVersion() ?? ""}`,
          `timestamp: ${new Date().toISOString()}`,
        ].join("\n"),
        metadata: {},
      }),
  }),
)

export const all = [
  NavigateTool,
  ClickTool,
  TypeTool,
  SelectTool,
  ScreenshotTool,
  SnapshotTool,
  ScrollTool,
  WaitTool,
  QueryTool,
  DownloadTool,
  ListDownloadsTool,
  SetFileInputTool,
  HighlightTool,
  ConsoleTool,
  ErrorsTool,
  CdpTool,
  OpenTabTool,
  CloseTabTool,
  GetTabsTool,
  ListClaimsTool,
  ClaimTabTool,
  ReleaseTabTool,
  StatusTool,
  VersionTool,
  DebugTool,
]
