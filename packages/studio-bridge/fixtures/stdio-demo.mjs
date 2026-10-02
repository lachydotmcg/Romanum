import path from 'node:path';
import { StudioBridge } from '../src/index.ts';
import { createFixtureStdioTransport, loadInstalledMcpSdk } from '../src/transport/index.ts';

const sdk = loadInstalledMcpSdk(process.env.ROMANUM_BRIDGE_SDK_ROOT ? path.join(process.env.ROMANUM_BRIDGE_SDK_ROOT, 'package.json') : new URL('../package.json', import.meta.url));
const transport = createFixtureStdioTransport(sdk);
const bridge = new StudioBridge(transport, { validateInput: transport.validateInput });
try {
  await transport.start();
  await bridge.initialize();
  const discovery = await bridge.discover();
  const target = bridge.selectStudio('studio-b');
  const capability = discovery.capabilities.find((item) => item.name === 'get_studio_state');
  const action = bridge.prepareAction({ actionId: 'stdio-demo-read', target, tool: capability.name, version: capability.version, input: {} });
  const result = await bridge.execute(action.actionId);
  console.log(JSON.stringify({ fixture: true, transport: 'local stdio child', selected: target.studioId, result, realStudioConnected: false }, null, 2));
} finally {
  bridge.close();
  await transport.waitForClose();
}
