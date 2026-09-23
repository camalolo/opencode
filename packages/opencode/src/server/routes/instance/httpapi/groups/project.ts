import { Project } from "@/project/project"
import { ProjectV2 } from "@opencode-ai/core/project"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { ProjectNotFoundError } from "../errors"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/project"
const UpdatePayload = Schema.Struct({
  name: Schema.optional(Schema.String),
  icon: Schema.optional(Project.Info.fields.icon),
  commands: Schema.optional(Project.Info.fields.commands),
})
const WebOpenPayload = Schema.Struct({ directory: Schema.String })
const WebClosePayload = Schema.Struct({ directory: Schema.String })
const WebExpandPayload = Schema.Struct({ directory: Schema.String, expanded: Schema.Boolean })
const WebReorderPayload = Schema.Struct({ directory: Schema.String, index: Schema.Number })
const WebSeedPayload = Schema.Struct({
  projects: Schema.Array(Schema.Struct({ worktree: Schema.String, expanded: Schema.optional(Schema.Boolean) })),
})

export const ProjectApi = HttpApi.make("project")
  .add(
    HttpApiGroup.make("project")
      .add(
        HttpApiEndpoint.get("list", root, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Project.Info), "List of projects"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "project.list",
            summary: "List all projects",
            description: "Get a list of projects that have been opened with OpenCode.",
          }),
        ),
        HttpApiEndpoint.get("current", `${root}/current`, {
          query: WorkspaceRoutingQuery,
          success: described(Project.Info, "Current project information"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "project.current",
            summary: "Get current project",
            description: "Retrieve the currently active project that OpenCode is working with.",
          }),
        ),
        HttpApiEndpoint.post("initGit", `${root}/git/init`, {
          query: WorkspaceRoutingQuery,
          success: described(Project.Info, "Project information after git initialization"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "project.initGit",
            summary: "Initialize git repository",
            description: "Create a git repository for the current project and return the refreshed project info.",
          }),
        ),
        HttpApiEndpoint.patch("update", `${root}/:projectID`, {
          params: { projectID: ProjectV2.ID },
          query: WorkspaceRoutingQuery,
          payload: UpdatePayload,
          success: described(Project.Info, "Updated project information"),
          error: [HttpApiError.BadRequest, ProjectNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "project.update",
            summary: "Update project",
            description: "Update project properties such as name, icon, and commands.",
          }),
        ),
        HttpApiEndpoint.get("directories", `${root}/:projectID/directories`, {
          params: { projectID: ProjectV2.ID },
          query: WorkspaceRoutingQuery,
          success: described(ProjectV2.Directories, "Project directories"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "project.directories",
            summary: "List project directories",
            description: "List known local absolute directories for a project.",
          }),
        ),
        HttpApiEndpoint.get("webList", `${root}/web`, {
          success: described(Schema.Array(Project.WebEntry), "Web UI project list"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "project.webList",
            summary: "List web UI projects",
            description:
              "Get the server-maintained list of projects opened from the web UI, in sidebar order. Shared by every client of this server.",
          }),
        ),
        HttpApiEndpoint.post("webOpen", `${root}/web/open`, {
          payload: WebOpenPayload,
          success: described(Schema.Array(Project.WebEntry), "Updated web UI project list"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "project.webOpen",
            summary: "Open a project in the web UI list",
            description: "Prepend a directory to the web UI project list and publish the updated list.",
          }),
        ),
        HttpApiEndpoint.post("webClose", `${root}/web/close`, {
          payload: WebClosePayload,
          success: described(Schema.Array(Project.WebEntry), "Updated web UI project list"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "project.webClose",
            summary: "Remove a project from the web UI list",
            description: "Remove a directory from the web UI project list and publish the updated list.",
          }),
        ),
        HttpApiEndpoint.post("webExpand", `${root}/web/expand`, {
          payload: WebExpandPayload,
          success: described(Schema.Array(Project.WebEntry), "Updated web UI project list"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "project.webExpand",
            summary: "Set web UI project expansion",
            description: "Set the sidebar expansion state of a web UI project and publish the updated list.",
          }),
        ),
        HttpApiEndpoint.post("webReorder", `${root}/web/reorder`, {
          payload: WebReorderPayload,
          success: described(Schema.Array(Project.WebEntry), "Updated web UI project list"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "project.webReorder",
            summary: "Reorder the web UI project list",
            description: "Move a directory to a new index in the web UI project list and publish the updated list.",
          }),
        ),
        HttpApiEndpoint.post("webSeed", `${root}/web/seed`, {
          payload: WebSeedPayload,
          success: described(Schema.Array(Project.WebEntry), "Web UI project list after seeding"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "project.webSeed",
            summary: "Seed the web UI project list",
            description:
              "Append directories the server does not know yet to the web UI project list. Used to migrate a client's locally stored list.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "project",
          description: "Experimental HttpApi project routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
