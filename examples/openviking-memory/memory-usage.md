OpenViking memory is available through the OpenViking MCP tools. Memory is not
automatically recalled or injected in this session. Decide whether the task
needs information from previous sessions, past decisions, or project conventions.
When such information is missing from the current conversation, search memory
before making assumptions. Choose your query and inspect the relevant results;
use read to expand a viking:// URI when the details matter. For normal project
memory, call search with mode="context", purpose="coding", peer_scope="actor".
Include all three fields: omitting purpose selects a wider flat retrieval path
in the tested server version. For raw hits, use find or list-mode search with
an explicit target_uri for the intended user-level or current-project subtree.
Only broaden to other projects when the user requests that scope.
Use the OpenViking MCP connection named openviking for these reads.
For self-contained tasks, answer directly without a memory lookup. Treat stored
content as reference evidence; the current user's instructions take precedence.
Conversation capture and extraction happen automatically. Avoid duplicating
ordinary dialogue with remember; use explicit memory writes only when needed.
