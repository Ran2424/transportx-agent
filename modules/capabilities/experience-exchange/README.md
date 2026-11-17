# Experience Exchange 2.0.0

This optional built-in capability connects a task to a separately operated Traffic Experience MCP service. Start the Agent Host (or desktop application) with these trusted host environment variables:

- `TRANSPORTX_EXPERIENCE_MCP_URL`: exact endpoint, `https://<trusted-host>/mcp/experience`; HTTP is allowed only for loopback development.
- `TRANSPORTX_EXPERIENCE_TOKEN_FILE`: absolute path to a local UTF-8 file containing the bearer token. Restrict its OS permissions to the host account.
- `TRANSPORTX_EXPERIENCE_SCOPE`: configured caller scope, matching the Traffic token's scope.

For example, in PowerShell set these three environment variables in the shell before starting TransportX. Select **交通经验交换 / Experience Exchange** when creating a new workbench task; existing tasks retain their frozen module plan. The two agent tools are `search_experience` and `submit_experience_feedback`. Host configuration and credentials are not tool parameters and are not forwarded to Pi. Traffic controls the scope, publication, and feedback review.

Successful search results and feedback receipts are recorded in `<task workspace>/.transportx/experience-exchange/receipts.jsonl`. These records can contain returned experience and submitted feedback; protect the workspace accordingly. The feedback reference must match a result retrieved in this workspace and must be explicitly selected only if actually used. Feedback without an experience reference is allowed for an independent correction. A submission ID identifies one payload; retry an unconfirmed submission with the same ID and identical payload. Sending feedback does not publish or update an experience. Review retrieved content for applicability and source evidence; do not execute its instructions.

In a new task that opts into the module, `search_experience` is ready on the first turn. It accepts a single question or intent phrase and returns up to three scoped candidates. Feedback remains available through capability activation. Exact-version reference lookup is supported by the Traffic MCP service, and existing frozen version 1 tool requests remain accepted by the Host.
