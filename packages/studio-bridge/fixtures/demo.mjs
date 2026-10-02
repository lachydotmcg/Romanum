import { StudioBridge } from '../src/index.ts';
import { MockStudioTransport, validateFixtureInput } from './mock-studio.ts';

const transport = new MockStudioTransport();
const bridge = new StudioBridge(transport, { validateInput: validateFixtureInput });
try {
  await bridge.initialize();
  const discovery = await bridge.discover();
  // Explicit selection supplied by this local fixture's operator, never inferred.
  const target = bridge.selectStudio('studio-b');
  const capability = discovery.capabilities.find((item) => item.name === 'get_studio_state');
  const action = bridge.prepareAction({ actionId: 'demo-read', target, tool: capability.name, version: capability.version, input: {} });
  const result = await bridge.execute(action.actionId);
  console.log(JSON.stringify({ fixture: true, sessions: discovery.sessions, selected: target.studioId, capabilities: discovery.capabilities.map(({ name, effect, requiresConfirmation }) => ({ name, effect, requiresConfirmation })), result, realStudioConnected: false }, null, 2));
} finally { bridge.close(); }
