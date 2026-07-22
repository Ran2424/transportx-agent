/**
 * Structured diagnostic for protocol parsing and version negotiations.
 *
 * Contract consumers (Server, Browser Kernel, Extension, Web Feature) should
 * surface diagnostics to the Browser Application Kernel as `AppError` entries
 * with `category: 'protocol'` rather than silently rejecting messages.
 */
export type ContractDiagnosticCode =
  | 'unknown_schema_version'
  | 'revision_regression'
  | 'missing_required_field'
  | 'missing_text_field'
  | 'invalid_type'
  | 'duplicate_id'
  | 'unsupported_value'
  | 'out_of_range'
  | 'unknown_reference'
  | 'unsafe_value';

export type ContractDiagnosticSeverity = 'warning' | 'error';

export type ContractDiagnostic = {
  code: ContractDiagnosticCode;
  path: string;
  message: string;
  severity: ContractDiagnosticSeverity;
  expected?: string | number;
  received?: string | number;
};

export function diagnostic(input: Omit<ContractDiagnostic, 'severity'> & { severity?: ContractDiagnosticSeverity }): ContractDiagnostic {
  return { severity: input.severity ?? 'error', ...input };
}

export function diagnosticMessage(diag: ContractDiagnostic): string {
  const head = diag.severity === 'warning' ? 'warning' : 'error';
  return `[${diag.code}] ${head} at ${diag.path}: ${diag.message}`;
}
