import { formatZodIssues } from './format-issues.js'
import { exportLogsRequestSchema } from './types.js'

/**
 * `POST /v1/logs` accepts a structurally valid `ExportLogsServiceRequest` and
 * otherwise does nothing with it — turning log records into events is the
 * `sessionlog` collector's job, not this receiver's. All this route owes the
 * exporter is "did you send OTLP, yes or no."
 */
export interface ValidateLogsResult {
  malformed: boolean
  detail?: string
}

export function validateLogsExport(body: unknown): ValidateLogsResult {
  const parsed = exportLogsRequestSchema.safeParse(body)
  if (parsed.success) return { malformed: false }
  return { malformed: true, detail: formatZodIssues(parsed.error.issues) }
}
