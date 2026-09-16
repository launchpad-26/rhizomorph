/**
 * The process collector — prd-57 ruling 1 and ruling 2, licensed by ADR-0052.
 *
 * `collector-loader.ts` is the only place the factory may be constructed;
 * `server/collector-wrap-boundary.test.ts` derives that rule by walking the
 * barrels and asserts it, so a factory built anywhere else reddens a law this
 * directory never names.
 */
export { createProcessCollector, PROCESS_COLLECTOR_NAME, type ProcessSnapshot } from './collector.js'
export {
  createProcTableReader,
  defaultProcessTableReader,
  NO_LEG_READER,
  type ProcessRow,
  type ProcessTableReader,
  type ProcessTableReading,
} from './read-table.js'
