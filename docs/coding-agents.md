# Using RDK in a coding agent or harness

Coding agents usually run without a terminal and may not have access to your
home directory. Give them credentials through the environment; do not run the
interactive setup wizard just to retrieve knowledge.

## Direct queries

Create or copy an API key from **dashboard.retrodeck.ai → Settings → API key**,
then inject it into the agent or sandbox:

```bash
export RDK_API_KEY='...'
rdk query "instagram clone spec" --json
```

`--json` writes parseable JSON to stdout. Network retrieval that may settle a
tip still requires `--select <chunkId>` or explicit unattended authorization
with `--auto --max-tip <usd>`.

If a sandbox cannot inherit environment variables, add `RDK_API_KEY` to that
sandbox's environment configuration. Alternatively, mount an existing config
file and set `RDK_CONFIG_PATH=/mounted/config.json`. Set `RDK_VAULT_PATH` only
when the agent should read or save local vault content.

## MCP-capable agents

```json
{
  "mcpServers": {
    "rdk": {
      "command": "rdk",
      "args": ["mcp:serve"],
      "env": { "RDK_API_KEY": "..." }
    }
  }
}
```

The MCP server starts without `~/.rdk/config.json` when `RDK_API_KEY` is set.
Never place the key in a URL, command argument, prompt, or log.

## Headless node setup

Most agents only need `rdk query`. If an agent genuinely needs a persisted node
configuration, setup can be run without prompts:

```bash
rdk init --non-interactive --api-key "$RDK_API_KEY" \
  --vault /path/to/vault --plan free --no-autostart --no-mcp-config
```

`RDK_NON_INTERACTIVE=1` and `CI=true` also disable prompts. When credentials are
missing, RDK exits immediately with instructions to set `RDK_API_KEY` or
`RDK_CONFIG_PATH`; it never launches the wizard in a headless process.
