# Raccoon automation MCP

This stdio MCP server bridges the automation project and module tools from ShardBrowser to Raccoon's scoped local HTTP service. Rust owns project storage, runs, module grants and browser lifecycle operations. Every tool requires an explicit `connectionId`.

The desktop initializes HTTP in a disabled state. After Tauri registers the HTTP commands, explicitly start it with `browser_automation_http_start`. Passing `port` as `0` chooses an ephemeral port. Read `browser_automation_http_status` for the actual port and explicitly obtain a Bearer token with `browser_automation_http_token`.

Saving a different port through `browser_automation_http_start` reserves the new loopback socket before gracefully draining the prior listener for up to five seconds. A failed bind or settings write keeps the prior listener running. Once a port change succeeds, update the MCP client's endpoint to the returned port.

Configure the MCP client's command as `node` with the absolute path to this package's `index.js` as its argument. Supply `RACCOON_AUTOMATION_API` with the returned `http://127.0.0.1` origin and port, and supply `RACCOON_AUTOMATION_TOKEN` with the desktop-issued token through the client's private environment configuration. This configuration is optional for desktop automation. Keep credentials outside source, ordinary logs and shared configuration.

The native Settings download action calls `browser_automation_mcp_download` with an existing absolute parent directory. Rust exports the embedded package into a fresh `raccoon-automation-mcp` subdirectory and adds a numeric suffix when that path already exists. The command returns the resulting absolute directory. It copies the exact runtime scripts, manifest, this guide, tests and MIT notice. An export failure can leave partial files in the newly reserved directory.

Install dependencies inside the exported directory with `npm install` or `pnpm install`, then configure the MCP client with that directory's `index.js`. Installation requires access to the package registry. The desktop download action itself uses the embedded source files. Node.js 24 or later is required.

The client rejects remote URLs and redirects. It sends `connectionId` as the query on every automation HTTP request. A run also requires the caller's stable `operationId`, which must be reused when reconciling the same submission. Request failures return MCP errors, and the client performs no automatic write retries.

The 18 tools cover project create, list, read, save, delete, duplicate, export, import, run, reconcile, stop and status, scoped Fleet records, module list, install, removal, permission inspection and grants. Module binaries are application-installed resources, and flow grants are scoped to the requested connection. Module installation paths refer to the Raccoon machine.

`reconcile_automation_project` calls `POST /automation/projects/:id/reconcile?connectionId=...` with a boolean `confirmed` body field. The MCP tool defaults `confirmed` to `false` for service reconciliation. Set it explicitly to `true` only after the user has inspected browser state and external side effects and confirmed ending the affected runs. The response carries the shared service's latest state or `null`. Pending or uncertain results remain service errors for further inspection.

The HTTP signing key and configured port are stored by Rust in `automation_http_settings` in the existing v2 SQLite database. Startup always leaves the listener disabled. Token rotation invalidates prior credentials immediately. The stored key is plaintext application data.

The dependencies use the repository's existing exact SDK version `1.32.1` and Zod `4.4.3`. The root lockfile importer must be synchronized by the integration owner before a frozen workspace install. Direct tests run with `rtk proxy node --test packages/automation-mcp/test/*.test.js` after dependencies are available. Rust authentication and scope unit tests live in `http.rs` and require CI execution.

## Upstream source

The Node SDK bridge, automation tool names and HTTP route design derive from ProxyShard/ShardBrowser at commit `99e780e2e685e5b3b5357c5baee8796e10b3ce1e`, specifically `mcp/index.js` and `src-tauri/src/api.rs`. The MIT notice is retained in `LICENSE.upstream`.
