import { createMemo, Show } from "solid-js"
import { ToolRegistry, type ToolProps } from "@opencode-ai/session-ui/message-part"
import { GenericTool } from "@opencode-ai/session-ui/basic-tool"
import { AttachmentCardV2 } from "@opencode-ai/session-ui/v2/attachment-card-v2"
import { typeLabel } from "@opencode-ai/session-ui/message-file"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import { showToast } from "@/utils/toast"

type SendFileMetadata = {
  path?: string
  filename?: string
  mime?: string
  size?: number
  download?: boolean
}

export async function downloadSendFile(input: {
  server: { url: string; username?: string; password?: string }
  directory: string
  path: string
  filename: string
}) {
  const url = new URL("/file/download", input.server.url)
  url.searchParams.set("directory", input.directory)
  url.searchParams.set("path", input.path)
  const headers: Record<string, string> = {}
  if (input.server.password) {
    headers.authorization = `Basic ${btoa(`${input.server.username ?? "opencode"}:${input.server.password}`)}`
  }
  const response = await fetch(url, { headers })
  if (!response.ok) throw new Error(`Download failed: ${response.status}`)
  const blob = await response.blob()
  const href = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = href
  anchor.download = input.filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(href)
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
  const language = useLanguage()
  const sdk = useSDK()
  const serverSDK = useServerSDK()
  const metadata = createMemo(() => (props.metadata ?? {}) as SendFileMetadata)
  const ready = createMemo(
    () => props.status === "completed" && metadata().download === true && !!metadata().path && !!metadata().filename,
  )

  const download = () => {
    const meta = metadata()
    if (!meta.path || !meta.filename) return
    const filename = meta.filename
    downloadSendFile({
      server: serverSDK().server.http,
      directory: sdk().directory,
      path: meta.path,
      filename,
    }).catch(() => {
      showToast({
        variant: "error",
        title: language.t("session.sendfile.downloadFailed"),
        description: language.t("session.sendfile.downloadFailed.description", { filename }),
      })
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
