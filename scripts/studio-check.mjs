import { connectStudio } from '../src/lib/harness/studio.ts';

// Local operator command only. A hosted web process cannot reach a user's Studio.
// No auto-selection, editing, code execution, paid tools or playtesting.
const [executable, studioId, ...extra] = process.argv.slice(2);
let connection;
try {
  if (!executable || extra.length) throw new Error('arguments');
  connection = await connectStudio(executable, true);
  const studios = await connection.listStudios();
  if (!studioId) console.log(JSON.stringify({ connected: true, studios }, null, 2));
  else {
    const tools = await connection.tools(studioId);
    const stateTool = tools.find((tool) => tool.name === 'studio_get_studio_state');
    if (!stateTool) throw new Error('state unavailable');
    const state = await stateTool.execute(stateTool.parse({}), { ownerId: 'local-operator', projectId: 'connection-check', runId: 'connection-check', actionId: 'read-state', signal: new AbortController().signal });
    console.log(JSON.stringify({ connected: true, studioId, tools: tools.map(({ name, effect }) => ({ name, effect })), state }, null, 2));
  }
} catch {
  console.error('Studio check failed. Supply an absolute StudioMCP executable path and, optionally, a session ID from discovery. Enable MCP in Studio first.');
  process.exitCode = 1;
} finally { await connection?.close(); }
