import { createMemo, Show } from "solid-js"
import { ToolRegistry, type ToolProps } from "@opencode-ai/session-ui/message-part"
import { GenericTool } from "@opencode-ai/session-ui/basic-tool"
import { AttachmentCardV2 } from "@opencode-ai/session-ui/v2/attachment-card-v2"
import { typeLabel } from "@opencode-ai/session-ui/message-file"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"

type SendFileMetadata = {
  path?: string
  filename?: string
  mime?: string
  size?: number
  download?: boolean
}

// Navigates straight to the download endpoint so the browser's download
// manager starts immediately and streams to disk. Buffering through fetch+blob
// would hold large files in memory with no visible progress until fully
// downloaded. The endpoint answers with Content-Disposition: attachment, so the
// download attribute is only a hint; auth rides the ?auth_token= query
// credential the endpoint accepts (same base64 user:pass format as Basic auth).
export function downloadSendFile(input: {
  server: { url: string; username?: string; password?: string }
  directory: string
  path: string
  filename: string
}) {
  const url = new URL("/file/download", input.server.url)
  url.searchParams.set("directory", input.directory)
  url.searchParams.set("path", input.path)
  if (input.server.password) {
    url.searchParams.set("auth_token", btoa(`${input.server.username ?? "opencode"}:${input.server.password}`))
  }
  const anchor = document.createElement("a")
  anchor.href = url.toString()
  anchor.download = input.filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB", "TB"]
  let value = bytes
  let unit = -1
  do {
    value /= 1024
    unit++
  } while (value >= 1024 && unit < units.length - 1)
  return `${value >= 100 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`
}

export function SendFileTool(props: ToolProps) {
  const sdk = useSDK()
  const serverSDK = useServerSDK()
  const metadata = createMemo(() => (props.metadata ?? {}) as SendFileMetadata)
  const ready = createMemo(
    () => props.status === "completed" && metadata().download === true && !!metadata().path && !!metadata().filename,
  )

  const download = () => {
    const meta = metadata()
    if (!meta.path || !meta.filename) return
    downloadSendFile({
      server: serverSDK().server.http,
      directory: sdk().directory,
      path: meta.path,
      filename: meta.filename,
    })
  }

  const label = createMemo(() => {
    const meta = metadata()
    if (!meta.filename) return ""
    const size = meta.size ? ` \u00B7 ${formatSize(meta.size)}` : ""
    return `${typeLabel(meta.filename, meta.mime ?? "", "FILE")}${size}`
  })

  return (
    <Show when={ready()} fallback={<GenericTool tool={props.tool} status={props.status} input={props.input} />}>
      <AttachmentCardV2 title={metadata().filename ?? ""} hover={metadata().path} clickable onClick={() => download()}>
        {label()}
      </AttachmentCardV2>
    </Show>
  )
}

ToolRegistry.register({ name: "send_file_to_user", render: SendFileTool })
