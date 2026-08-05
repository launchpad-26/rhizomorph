import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * prd9 ruling 5 names `user.email`, `user.account_*` and `organization.id`
 * as identity-relevant by the product's own reckoning (the parser allowlist
 * is what keeps them out of stored state); the record format's laws say a
 * record ships exactly what the log contains, verbatim. A captured OTel
 * fixture is exactly that kind of log — so a real account/org identifier
 * checked into `fixtures/` is a leak the moment the repo goes public, even
 * though no parser ever reads the field. This law makes that structurally
 * checked instead of relying on a human catching it at capture time.
 *
 * Grep-law style: real source text over the fixture files, no schema, no
 * OTLP envelope assumptions — so it also catches a leak in a fixture whose
 * shape this suite has never seen.
 */

const FIXTURES_DIR = fileURLToPath(new URL('./fixtures', import.meta.url))

const IDENTITY_FIELDS = ['organization.id', 'user.account_uuid', 'user.account_id', 'user.id', 'user.email'] as const
type IdentityField = (typeof IDENTITY_FIELDS)[number]

/** Obviously-synthetic shapes accepted per field — anything else is a live-looking value. */
const PLACEHOLDER_PATTERNS: Record<IdentityField, RegExp> = {
  'organization.id': /^(0{8}-0{4}-0{4}-0{4}-0{12}|org-\d+)$/,
  'user.account_uuid': /^0{8}-0{4}-0{4}-0{4}-0{12}$/,
  'user.account_id': /^user_TEST/,
  'user.id': /^(0+|user-\d+)$/,
  'user.email': /^[^@\s]+@example\.com$/,
}

function isIdentityField(key: string): key is IdentityField {
  return (IDENTITY_FIELDS as readonly string[]).includes(key)
}

/** One `{key, value}` -> string hit, wherever it's found in a fixture. */
interface AttributeHit {
  key: IdentityField
  value: string
}

/**
 * Walks an arbitrary parsed JSON value looking for OTLP `KeyValue` shapes
 * (`{key: string, value: {stringValue: string}}`) whose key names an
 * identity field — resource attributes, span attributes, and metric
 * datapoint attributes are all this same shape, and a generic walk finds
 * all three (plus anything a future span/datapoint kind adds) without
 * hard-coding the envelope.
 */
function findIdentityAttributeHits(node: unknown, out: AttributeHit[] = []): AttributeHit[] {
  if (Array.isArray(node)) {
    for (const entry of node) findIdentityAttributeHits(entry, out)
    return out
  }
  if (node !== null && typeof node === 'object') {
    const record = node as Record<string, unknown>
    const key = record.key
    const value = record.value
    if (typeof key === 'string' && isIdentityField(key) && value !== null && typeof value === 'object') {
      const stringValue = (value as Record<string, unknown>).stringValue
      if (typeof stringValue === 'string') out.push({ key, value: stringValue })
    }
    for (const nested of Object.values(record)) findIdentityAttributeHits(nested, out)
  }
  return out
}

function fixtureFiles(): string[] {
  return readdirSync(FIXTURES_DIR)
    .filter((name) => name.endsWith('.json'))
    .sort()
}

describe('fixture hygiene law: identity fields are placeholder-shaped everywhere under fixtures/', () => {
  it('the fixtures directory is non-empty — the sweep below would pass vacuously otherwise', () => {
    expect(fixtureFiles().length).toBeGreaterThan(0)
  })

  it('every identity-field attribute in every fixture is an obviously-synthetic placeholder', () => {
    const violations: string[] = []
    let hitCount = 0

    for (const name of fixtureFiles()) {
      const parsed: unknown = JSON.parse(readFileSync(`${FIXTURES_DIR}/${name}`, 'utf8'))
      for (const hit of findIdentityAttributeHits(parsed)) {
        hitCount += 1
        if (!PLACEHOLDER_PATTERNS[hit.key].test(hit.value)) {
          violations.push(`${name}: "${hit.key}" = "${hit.value}"`)
        }
      }
    }

    // At least the trace fixtures carry these fields — a sweep that finds
    // zero hits found nothing because it's broken, not because it's clean.
    expect(hitCount).toBeGreaterThan(0)
    expect(violations).toEqual([])
  })

  it('the detector fires on a deliberately live-looking value — proving it bites', () => {
    const rigged = [{ key: 'organization.id', value: { stringValue: 'deadbeef-1234-5678-9abc-def012345678' } }]
    const hits = findIdentityAttributeHits(rigged)
    expect(hits).toHaveLength(1)
    expect(PLACEHOLDER_PATTERNS['organization.id'].test(hits[0]?.value ?? '')).toBe(false)
  })

  it('the detector does not fire on the placeholder shapes actually in use — not vacuously true', () => {
    expect(PLACEHOLDER_PATTERNS['organization.id'].test('00000000-0000-0000-0000-000000000000')).toBe(true)
    expect(PLACEHOLDER_PATTERNS['organization.id'].test('org-1')).toBe(true)
    expect(PLACEHOLDER_PATTERNS['user.account_uuid'].test('00000000-0000-0000-0000-000000000000')).toBe(true)
    expect(PLACEHOLDER_PATTERNS['user.account_id'].test('user_TEST0000000000000000')).toBe(true)
    expect(PLACEHOLDER_PATTERNS['user.id'].test('0'.repeat(64))).toBe(true)
    expect(PLACEHOLDER_PATTERNS['user.id'].test('user-1')).toBe(true)
    expect(PLACEHOLDER_PATTERNS['user.email'].test('lachlan@example.com')).toBe(true)
  })

  it('a nested attribute (span-level, not just resource-level) is reachable by the walk — proving it is not resource-only', () => {
    const nested = {
      resourceSpans: [
        {
          resource: { attributes: [{ key: 'lane', value: { stringValue: 'probe-lane' } }] },
          scopeSpans: [
            {
              spans: [
                {
                  attributes: [{ key: 'user.id', value: { stringValue: 'not-a-placeholder-1234567890abcdef' } }],
                },
              ],
            },
          ],
        },
      ],
    }
    const hits = findIdentityAttributeHits(nested)
    expect(hits).toEqual([{ key: 'user.id', value: 'not-a-placeholder-1234567890abcdef' }])
  })
})
