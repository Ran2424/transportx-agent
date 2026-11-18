import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';

export const table = {
  file: 'evidence/counts.csv',
  filters: [
    { column: 'area', value: 'north' },
    { column: 'period', value: 'AM' },
  ],
  aggregates: [{ op: 'sum', column: 'count', as: 'total' }],
};
export const answer = 'Use this result only for the selected reporting window.';
const tableClaims = (evidenceId) => [
  { kind: 'scope', label: 'Requested scope', evidenceId, expectedFilters: table.filters },
  { kind: 'sample', label: 'Comparison population', evidenceId },
  { kind: 'value', label: 'Total count', evidenceId, column: 'total' },
];
export function createEvidenceModel(getCwd) {
  const state = {};
  const requests = [];
  const dispatcher = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks));
      const active = state.active;
      assert.ok(active, 'Unexpected model request outside an active scenario');
      const index = active.requests++;
      const tools = (body.tools ?? []).map((item) => item.function.name);
      requests.push({ scenario: active.name, index, tools });
      if (index === 0) {
        assert.ok(tools.includes('analyze_workspace_table'), 'Table tool must be available in the first request');
        assert.ok(
          tools.includes('complete_evidence_analysis'),
          'Completion tool must be available in the first request'
        );
      }
      let call, content, finish = 'stop';
      if (active.name === 'verified') {
        if (index === 0) content = 'PLAN_ONLY_SENTINEL: I will inspect the data.';
        else if (index === 1)
          call = {
            name: 'analyze_workspace_table',
            args: { ...table, file: path.join(getCwd(), table.file) },
          };
        else if (index === 2) {
          const result = body.messages.findLast((item) => item.role === 'tool');
          const text = typeof result?.content === 'string' ? result.content : JSON.stringify(result?.content);
          const match = text.match(/ev_[0-9a-f]{16}/);
          assert.ok(match, 'The table result must return a current-turn evidence ID');
          state.capturedId = match[0];
          call = {
            name: 'complete_evidence_analysis',
            args: { status: 'completed', answer, claims: tableClaims(state.capturedId) },
          };
        } else if (index === 3) content = 'Model completion text should be replaced by the verified answer.';
        else throw new Error('Unexpected request in verified scenario: ' + index);
      } else if (active.name === 'direct-delivery') {
        const average = [{ op: 'avg', column: 'count', as: 'mean' }];
        if (index === 0) call = {
          name: 'analyze_workspace_table',
          args: { ...table, filters: [{ column: 'period', value: 'am' }], aggregates: average, deliver: true },
        };
        else if (index === 1) {
          const result = body.messages.findLast((item) => item.role === 'tool');
          const json = JSON.parse(typeof result.content === 'string' ? result.content : result.content[0].text);
          assert.equal(json.delivered, false);
          assert.deepEqual(json.unmatchedFilters, [{ column: 'period', value: 'am', examples: ['AM', 'PM'] }]);
          call = { name: 'complete_evidence_analysis',
            args: { answer: 'The average is 99.', evidence: [json.evidenceId] } };
        } else if (index === 2) {
          const result = body.messages.findLast((item) => item.role === 'tool');
          assert.match(JSON.stringify(result.content), /unmatched filters/);
          call = { name: 'analyze_workspace_table',
            args: { ...table, aggregates: average, deliver: true } };
        } else if (index === 3) {
          const result = body.messages.findLast((item) => item.role === 'tool');
          const json = JSON.parse(typeof result.content === 'string' ? result.content : result.content[0].text);
          assert.equal(json.delivered, true);
          content = 'The computed answer has already been submitted.';
          finish = 'length';
        } else throw new Error('Unexpected model request after direct delivery');
      } else if (active.name === 'required-explanation') {
        if (index === 0) call = { name: 'analyze_workspace_table', args: { ...table, deliver: true } };
        else if (index === 1) {
          const result = body.messages.findLast((item) => item.role === 'tool');
          const json = JSON.parse(typeof result.content === 'string' ? result.content : result.content[0].text);
          assert.equal(json.delivered, false);
          assert.match(json.deliveryNote, /requires explanation/);
          active.main = json.evidenceId;
          call = { name: 'complete_evidence_analysis', args: { answer: 'Unbound total', evidence: [active.main] } };
        } else if (index === 2) {
          assert.match(JSON.stringify(body.messages.findLast(item => item.role === 'tool').content), /requires structured claims/);
          call = { name: 'analyze_workspace_table', args: {
            file: table.file, filters: table.filters, groupBy: ['period'],
            aggregates: [{ op: 'count', as: 'records' }],
          } };
        } else if (index === 3) {
          const result = body.messages.findLast(item => item.role === 'tool');
          active.time = JSON.parse(typeof result.content === 'string' ? result.content : result.content[0].text).evidenceId;
          call = { name: 'complete_evidence_analysis', args: {
            claims: [...tableClaims(active.main), { kind: 'time', label: 'Window', evidenceId: active.main, column: 'total' }],
          } };
        } else if (index === 4) {
          assert.match(JSON.stringify(body.messages.findLast(item => item.role === 'tool').content), /Time claims require/);
          const claims = tableClaims(active.main);
          claims[0].expectedFilters = [{ column: 'period', value: 'AM' }];
          call = { name: 'complete_evidence_analysis', args: { claims } };
        } else if (index === 5) {
          assert.match(JSON.stringify(body.messages.findLast(item => item.role === 'tool').content), /expectedFilters must match/);
          call = { name: 'complete_evidence_analysis', args: {
            claims: [...tableClaims(active.main), { kind: 'time', label: 'Window', evidenceId: active.time, column: 'period' }],
          } };
        } else if (index === 6) content = 'Complete.';
        else throw new Error('Unexpected request in required-explanation scenario');
      } else if (active.name === 'csv-read-is-not-a-calculation') {
        if (index === 0) call = { name: 'read', args: { path: table.file } };
        else if (index === 1) {
          const result = body.messages.findLast((item) => item.role === 'tool');
          const id = JSON.stringify(result.content).match(/ev_[0-9a-f]{16}/)?.[0];
          assert.ok(id);
          call = { name: 'complete_evidence_analysis', args: { answer: 'The total is 99.', evidence: [id] } };
        } else if (index <= 3) content = 'I could not finish the analysis.';
        else throw new Error('Unexpected request in CSV read scenario');
      } else if (active.name === 'plans') {
        assert.ok(index < 2, 'Only one repair follow-up is permitted');
        content = 'PLAN_TWICE_SENTINEL: I will investigate later.';
      } else if (active.name === 'repair-write') {
        if (index === 1)
          call = { name: 'write', args: { path: 'evidence/forbidden.txt', content: 'Must be blocked' } };
        else if (index <= 2) content = 'I will inspect the evidence later.';
        else throw new Error('Unexpected repair-write request: ' + index);
      } else if (active.name === 'missing') {
        if (index === 0)
          call = { name: 'analyze_workspace_table', args: { ...table, file: 'evidence/missing.csv' } };
        else if (index === 1)
          call = {
            name: 'complete_evidence_analysis',
            args: { status: 'missing', answer: 'The file evidence/missing.csv is absent.', evidence: [] },
          };
        else if (index === 2) content = 'Completion.';
        else throw new Error('Unexpected missing-data request: ' + index);
      } else if (active.name === 'invalid-is-not-missing') {
        if (index === 0)
          call = { name: 'analyze_workspace_table', args: { ...table, aggregates: [{ op: 'sum', as: 'total' }] } };
        else if (index === 1)
          call = {
            name: 'complete_evidence_analysis',
            args: { status: 'missing', answer: 'The file evidence/counts.csv is absent.', evidence: [] },
          };
        else if (index <= 3) content = 'I could not finish the analysis.';
        else throw new Error('Unexpected invalid-query request: ' + index);
      } else if (active.name === 'forged-related') {
        if (index === 0) call = { name: 'analyze_workspace_table', args: table };
        else if (index === 1) {
          const response = body.messages.findLast((item) => item.role === 'tool');
          const result = JSON.parse(typeof response.content === 'string' ? response.content : response.content.find(block => block.type === 'text').text);
          call = { name: 'complete_evidence_analysis', args: { answer, evidence: [result.evidenceId], relatedToolCallIds: ['call_forged_receipt'] } };
        } else if (index <= 3) content = 'I could not finish the analysis.';
        else throw new Error('Unexpected related-receipt request: ' + index);
      } else if (active.name === 'stale') {
        if (index === 0)
          call = {
            name: 'complete_evidence_analysis',
            args: {
              status: 'answered',
              answer: 'Stale fake answer.',
              evidence: [state.capturedId],
            },
          };
        else if (index <= 2) content = 'STALE_PLAN_SENTINEL: I will check later.';
        else throw new Error('Unexpected stale scenario request: ' + index);
      } else if (active.name === 'unsafe') {
        if (index === 0)
          call = {
            name: 'analyze_workspace_table',
            args: { ...table, file: '../foreign.csv' },
          };
        else if (index === 1)
          call = {
            name: 'analyze_workspace_table',
            args: { ...table, file: 'https://example.invalid/foreign.csv' },
          };
        else if (index <= 3) content = 'UNSAFE_PLAN_SENTINEL: I will check later.';
        else throw new Error('Unexpected unsafe scenario request: ' + index);
      } else throw new Error('Unknown scenario');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (delta, finish_reason = null) =>
        res.write(
          'data: ' +
            JSON.stringify({
              id: 'evidence-smoke',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'probe',
              choices: [{ index: 0, delta, finish_reason }],
            }) +
            '\n\n'
        );
      if (call)
        send({
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: 'call_' + randomUUID().replaceAll('-', ''),
              type: 'function',
              function: { name: call.name, arguments: JSON.stringify(call.args) },
            },
          ],
        });
      else send({ role: 'assistant', content });
      send({}, call ? 'tool_calls' : finish);
      res.end('data: [DONE]\n\n');
    } catch (error) {
      state.dispatcherError = error;
      res.writeHead(500);
      res.end('Invalid smoke dispatcher request.');
    }
  });
  return { dispatcher, state, requests };
}
