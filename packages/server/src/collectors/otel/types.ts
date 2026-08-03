import { z } from 'zod'

/**
 * Minimal OTLP/HTTP JSON shapes — just enough of the export-request envelope
 * to reach attributes and datapoint values. Protobuf is out of scope; only
 * the JSON encoding claude/codex actually send (per research §S1) is modelled
 * here. Every object schema is `.passthrough()` so fields OTel adds later
 * don't turn into parse failures.
 */

const anyValueSchema = z
  .object({
    stringValue: z.string().optional(),
    intValue: z.union([z.string(), z.number()]).optional(),
    doubleValue: z.number().optional(),
    boolValue: z.boolean().optional(),
  })
  .passthrough()
export type OtlpAnyValue = z.infer<typeof anyValueSchema>

const keyValueSchema = z
  .object({
    key: z.string(),
    value: anyValueSchema.optional(),
  })
  .passthrough()
export type OtlpKeyValue = z.infer<typeof keyValueSchema>

const attributesSchema = z.array(keyValueSchema).optional()

const numberDataPointSchema = z
  .object({
    attributes: attributesSchema,
    asInt: z.union([z.string(), z.number()]).optional(),
    asDouble: z.number().optional(),
    timeUnixNano: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough()
export type OtlpNumberDataPoint = z.infer<typeof numberDataPointSchema>

const sumSchema = z
  .object({
    dataPoints: z.array(numberDataPointSchema).optional(),
    aggregationTemporality: z.number().optional(),
    isMonotonic: z.boolean().optional(),
  })
  .passthrough()

const gaugeSchema = z
  .object({
    dataPoints: z.array(numberDataPointSchema).optional(),
  })
  .passthrough()

const metricSchema = z
  .object({
    name: z.string(),
    unit: z.string().optional(),
    sum: sumSchema.optional(),
    gauge: gaugeSchema.optional(),
  })
  .passthrough()
export type OtlpMetric = z.infer<typeof metricSchema>

const scopeMetricsSchema = z
  .object({
    metrics: z.array(metricSchema).optional(),
  })
  .passthrough()

const resourceSchema = z
  .object({
    attributes: attributesSchema,
  })
  .passthrough()

const resourceMetricsSchema = z
  .object({
    resource: resourceSchema.optional(),
    scopeMetrics: z.array(scopeMetricsSchema).optional(),
  })
  .passthrough()
export type OtlpResourceMetrics = z.infer<typeof resourceMetricsSchema>

/** `POST /v1/metrics` body: `ExportMetricsServiceRequest` per the OTLP spec. */
export const exportMetricsRequestSchema = z
  .object({
    resourceMetrics: z.array(resourceMetricsSchema),
  })
  .passthrough()
export type ExportMetricsRequest = z.infer<typeof exportMetricsRequestSchema>

/**
 * `POST /v1/logs` body: `ExportLogsServiceRequest`. prd1 does not parse log
 * records into events (that's the `sessionlog` collector's job) — the route
 * only needs to accept a structurally valid body and reject a malformed one.
 */
export const exportLogsRequestSchema = z
  .object({
    resourceLogs: z.array(z.unknown()),
  })
  .passthrough()
export type ExportLogsRequest = z.infer<typeof exportLogsRequestSchema>

/**
 * `POST /v1/traces` body: `ExportTraceServiceRequest`. Only `traceId`/`spanId`/
 * `name`/the two nano timestamps are ever required by `parse-traces.ts`, and
 * even those stay optional here — a span missing one is a per-span
 * `collector.error`, not a whole-request 400 (mirrors `numberDataPointSchema`
 * above: structural validation here, business validation in the parser).
 */
const spanStatusOtlpSchema = z
  .object({
    code: z.number().optional(),
  })
  .passthrough()

const otlpSpanSchema = z
  .object({
    traceId: z.string().optional(),
    spanId: z.string().optional(),
    parentSpanId: z.string().optional(),
    name: z.string().optional(),
    startTimeUnixNano: z.union([z.string(), z.number()]).optional(),
    endTimeUnixNano: z.union([z.string(), z.number()]).optional(),
    attributes: attributesSchema,
    status: spanStatusOtlpSchema.optional(),
  })
  .passthrough()
export type OtlpSpan = z.infer<typeof otlpSpanSchema>

const scopeSpansSchema = z
  .object({
    spans: z.array(otlpSpanSchema).optional(),
  })
  .passthrough()

const resourceSpansSchema = z
  .object({
    resource: resourceSchema.optional(),
    scopeSpans: z.array(scopeSpansSchema).optional(),
  })
  .passthrough()
export type OtlpResourceSpans = z.infer<typeof resourceSpansSchema>

export const exportTraceRequestSchema = z
  .object({
    resourceSpans: z.array(resourceSpansSchema),
  })
  .passthrough()
export type ExportTraceRequest = z.infer<typeof exportTraceRequestSchema>

/** Extracts the one populated field of an `AnyValue`, stringified. */
export function anyValueToString(value: OtlpAnyValue | undefined): string | undefined {
  if (!value) return undefined
  if (value.stringValue !== undefined) return value.stringValue
  if (value.intValue !== undefined) return String(value.intValue)
  if (value.doubleValue !== undefined) return String(value.doubleValue)
  if (value.boolValue !== undefined) return String(value.boolValue)
  return undefined
}

/** Looks up one attribute's string form from a `KeyValue[]`, by key. */
export function attrString(attrs: OtlpKeyValue[] | undefined, key: string): string | undefined {
  const found = attrs?.find((attr) => attr.key === key)
  return anyValueToString(found?.value)
}

/** Looks up one attribute's numeric form (`intValue`/`doubleValue`) from a `KeyValue[]`, by key. */
export function attrInt(attrs: OtlpKeyValue[] | undefined, key: string): number | undefined {
  const str = attrString(attrs, key)
  if (str === undefined) return undefined
  const n = Number(str)
  return Number.isFinite(n) ? Math.trunc(n) : undefined
}

/** A datapoint's numeric value — `asDouble` for dollars, `asInt` for counts. */
export function dataPointValue(dp: OtlpNumberDataPoint): number | undefined {
  if (dp.asDouble !== undefined) return dp.asDouble
  if (dp.asInt !== undefined) {
    const n = Number(dp.asInt)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

/** All datapoints of a metric, whichever aggregation type it used. */
export function metricDataPoints(metric: OtlpMetric): OtlpNumberDataPoint[] {
  return metric.sum?.dataPoints ?? metric.gauge?.dataPoints ?? []
}
