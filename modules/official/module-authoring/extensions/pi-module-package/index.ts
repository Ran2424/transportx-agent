import type { TSchema } from 'typebox';
import { readFileSync } from 'node:fs';
import { parseToolInterfaceContract } from '../../../../../src/contracts/tool-interface.ts';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { postHostOperation } from '../../../../shared/host-client.ts';

const contract = parseToolInterfaceContract(JSON.parse(readFileSync(new URL("../../tool-contract.json", import.meta.url), "utf8")));
if (!contract) throw new Error("Invalid Module Package Tool Contract");

export default function modulePackage(pi: ExtensionAPI) {
  const errors = new Set<string>();
  pi.on('session_shutdown', () => errors.clear());
  pi.on('tool_result', (event) => {
    if (event.toolName === 'tau_module_package' && errors.delete(event.toolCallId)) return { isError: true };
  });
  pi.registerTool({
    name: 'tau_module_package', label: '制作工具包',
    description: 'Statically inspect a generated TransportX module inside this task, or request its installation after the user has requested installation. Install uses the existing native trust confirmation; inspection never executes code. Successful install makes tools available to new tasks, not this already frozen task. Keep credentials outside the package.',
    parameters: contract!.input as unknown as TSchema,
    async execute(toolCallId, params, signal): Promise<{ content: { type: 'text'; text: string }[]; details: Record<string, unknown> }> {
      try {
        const result = await postHostOperation<Record<string, unknown>>({ endpoint: process.env.TAU_MODULE_ENDPOINT, sessionId: process.env.TAU_MODULE_SESSION_ID, token: process.env.TAU_MODULE_TOKEN }, '/api/internal/modules/package', params as Record<string, unknown>, { toolCallId, contractVersion: '1.0.0', signal, timeoutMs: 300_000 });
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: { kind: 'tau-module-package', ...result } };
      } catch (error) {
        errors.add(toolCallId);
        const failure = error as Error & { commit?: string };
        const result = { code: failure.commit === 'unknown' ? 'module_install_unknown' : 'module_package_failed', message: failure.message.slice(0, 1500), recovery: 'Inspect the existing module in capability management before another install attempt. Generation, inspection, trust confirmation and installation are separate steps.' };
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: { kind: 'tau-module-package-error', error: result } };
      }
    },
  });
}
