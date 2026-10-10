export interface InputCaptureCondition {
  bindingId: string;
  expectedRevision: number;
  expectedInputCount: number;
}

/** Shared by the CLI and authenticated host route. Counts refer to immutable
 * accepted inputs, including inputs whose receiver acknowledgement is pending. */
export function parseInputCaptureConditions(value: unknown): InputCaptureCondition[] {
  if (!Array.isArray(value) || !value.length || value.length > 32) throw new Error('invalid_input_capture_conditions');
  const ids = new Set<string>();
  return value.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)
      || typeof row.bindingId !== 'string' || !/^[a-f0-9]{64}$/.test(row.bindingId) || ids.has(row.bindingId)
      || !Number.isSafeInteger(row.expectedRevision) || row.expectedRevision < 1
      || !Number.isSafeInteger(row.expectedInputCount) || row.expectedInputCount < 0
      || Object.keys(row).some(key => !['bindingId', 'expectedRevision', 'expectedInputCount'].includes(key))) {
      throw new Error('invalid_input_capture_conditions');
    }
    ids.add(row.bindingId);
    return { bindingId: row.bindingId, expectedRevision: row.expectedRevision, expectedInputCount: row.expectedInputCount };
  });
}
