import fs from 'node:fs';

const KINDS = new Set(['question', 'task']);
const CATEGORIES = new Set(['bus', 'metro', 'ride-hailing', 'road', 'weather', 'spatial']);

export function loadSuite(filePath) {
  const suite = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const errors = [];
  if (suite.schemaVersion !== 1) errors.push('Unsupported eval suite schemaVersion');
  if (!suite.id || !Array.isArray(suite.cases) || !suite.cases.length) errors.push('Suite id and cases are required');
  const ids = new Set();
  for (const [index, item] of (suite.cases || []).entries()) {
    const at = `cases[${index}]`;
    if (!item.id || ids.has(item.id)) errors.push(`${at}: case id must be unique`); else ids.add(item.id);
    if (!KINDS.has(item.kind) || !CATEGORIES.has(item.category)) errors.push(`${at}: invalid kind or category`);
    if (!Array.isArray(item.turns) || !item.turns.length || item.turns.some((turn) => !turn.user || typeof turn.user !== 'string')) errors.push(`${at}: at least one user turn is required`);
    for (const turn of item.turns || []) for (const fact of turn.expected?.facts || []) {
      if (!fact.label || fact.value === undefined) errors.push(`${at}: each fact requires label and value`);
      if (typeof fact.value === 'number' && !fact.unit) errors.push(`${at}: numeric fact ${fact.label || '<unknown>'} requires a unit`);
      if (typeof fact.value === 'number' && (!Number.isFinite(fact.value) || fact.tolerance !== undefined && (!Number.isFinite(fact.tolerance) || fact.tolerance < 0))) errors.push(`${at}: invalid numeric fact`);
    }
    if (!Array.isArray(item.requiredModuleVersions) || !item.requiredModuleVersions.length || item.requiredModuleVersions.some((entry) => !entry.id || !entry.version)) errors.push(`${at}: requiredModuleVersions is required`);
    if (item.grading?.requireSuccessfulTurn !== true || item.grading?.requireNoToolError !== true) errors.push(`${at}: successful turns and no tool errors must be required`);
  }
  if (errors.length) throw new Error(errors.join('\n'));
  return suite;
}

function normalized(value) {
  return String(value).normalize('NFKC').toLowerCase().replace(/[，,]/g, '').replace(/[—–~～至]/g, '-').replace(/\s+/g, ' ').trim();
}

function numericValues(text) {
  return [...normalized(text).matchAll(/-?\d+(?:\.\d+)?/g)].map((match) => Number(match[0])).filter(Number.isFinite);
}

function assertion(id, passed, message) { return { id, passed, message }; }

export function gradeCase(evalCase, run) {
  const assertions = [];
  const answers = Array.isArray(run.answers) ? run.answers : [];
  const answer = answers.join('\n');
  assertions.push(assertion('execution.completed', run.completed === true, run.completed ? 'All turns completed' : run.error || 'Case did not complete'));
  assertions.push(assertion('execution.answer', answers.length === evalCase.turns.length && answers.every((item) => typeof item === 'string' && item.trim()), 'Each turn must have a non-empty final answer'));
  assertions.push(assertion('execution.tools', !run.toolError, run.toolError || 'No tool error'));
  assertions.push(assertion('execution.pendingUi', !run.pendingExtensionUi, 'No pending Extension UI request'));
  const modules = new Map((run.plan?.modules || []).map((item) => [item.id, item.version]));
  for (const module of evalCase.requiredModuleVersions) assertions.push(assertion(`plan.${module.id}`, modules.get(module.id) === module.version, `Expected ${module.id}@${module.version}; received ${modules.get(module.id) || 'missing'}`));
  for (const [turnIndex, turn] of evalCase.turns.entries()) {
    const turnAnswer = answers[turnIndex] || '';
    for (const fact of turn.expected?.facts || []) {
      let passed;
      if (typeof fact.value === 'number') {
        const tolerance = fact.tolerance || 0;
        passed = numericValues(turnAnswer).some((value) => Math.abs(value - fact.value) <= tolerance) && normalized(turnAnswer).includes(normalized(fact.unit));
      } else passed = normalized(turnAnswer).includes(normalized(fact.value));
      assertions.push(assertion(`turn.${turnIndex}.fact.${fact.label}`, passed, `Expected ${fact.label}: ${fact.value}${fact.unit || ''}`));
    }
    for (const term of turn.expected?.requiredTerms || []) assertions.push(assertion(`turn.${turnIndex}.term.${term}`, normalized(turnAnswer).includes(normalized(term)), `Required term: ${term}`));
    for (const term of turn.expected?.forbiddenTerms || []) assertions.push(assertion(`turn.${turnIndex}.forbidden.${term}`, !normalized(turnAnswer).includes(normalized(term)), `Forbidden term: ${term}`));
    if (turn.expected?.timeRange) assertions.push(assertion(`turn.${turnIndex}.timeRange`, normalized(turnAnswer).includes(normalized(turn.expected.timeRange)), `Expected time range: ${turn.expected.timeRange}`));
  }
  for (const artifact of evalCase.expectedArtifacts || []) {
    const matches = (run.artifacts || []).filter((item) => item.kind === artifact.kind && item.pattern === artifact.pathPattern);
    assertions.push(assertion(`artifact.${artifact.kind}.${artifact.pathPattern}`, matches.some((item) => item.valid), matches.length ? matches.map((item) => item.error || item.path).join(', ') : 'Expected artifact was not found'));
  }
  if (evalCase.grading.requireDatasetCitation) assertions.push(assertion('citation.dataset', run.hasDatasetCitation === true, 'A valid dataset citation occurrence is required'));
  const passed = assertions.every((item) => item.passed);
  return { caseId: evalCase.id, kind: evalCase.kind, category: evalCase.category, passed, assertions, answer, durationMs: run.durationMs || 0, usage: run.usage || null };
}

export function gradeRun(suite, run) {
  const cases = [];
  for (const item of suite.cases) {
    const attempts = (run.cases || []).filter((candidate) => candidate.caseId === item.id);
    attempts.forEach((attempt, index) => cases.push({ ...gradeCase(item, attempt), caseId: attempts.length > 1 ? `${item.id}#${attempt.attempt || index + 1}` : item.id }));
  }
  const passed = cases.filter((item) => item.passed).length;
  return { schemaVersion: 1, suiteId: suite.id, runId: run.runId, model: run.model, generatedAt: new Date().toISOString(), totals: { cases: cases.length, passed, failed: cases.length - passed }, passed: cases.length > 0 && passed === cases.length, cases };
}

export function summaryMarkdown(summary) {
  const lines = [`# Traffic Agent Eval — ${summary.suiteId}`, '', `- Model: ${summary.model || '<unspecified>'}`, `- Result: ${summary.totals.passed}/${summary.totals.cases} passed`, `- Generated: ${summary.generatedAt}`, '', '| Case | Kind | Result | Failed assertions |', '|---|---|---:|---|'];
  for (const item of summary.cases) lines.push(`| ${item.caseId} | ${item.kind} | ${item.passed ? 'PASS' : 'FAIL'} | ${item.assertions.filter((assertion) => !assertion.passed).map((assertion) => assertion.message).join('; ').replaceAll('|', '\\|')} |`);
  return `${lines.join('\n')}\n`;
}
