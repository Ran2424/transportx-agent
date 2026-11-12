import type { ExtensionAPI } from '@earendil-works/pi-coding-agent' with { 'resolution-mode': 'import' };
import { registerChatGPTPlanProvider } from './chatgpt-provider.js';

export default async function (pi: ExtensionAPI) {
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  if (agentDir) await registerChatGPTPlanProvider(pi, agentDir);
}
