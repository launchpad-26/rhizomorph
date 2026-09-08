import { SYNTHETIC_DASH } from '../branching/index.js'
import type { FailedArm } from '../compare/types.js'
import type { LabCheckpoint, LabExperiment } from '../types.js'
import { type CanvasLayout, layoutCanvas } from './organism.js'

/**
 * The lane canvas, drawn (prd53 ruling 5, #329): `layoutCanvas`'s output as
 * SVG, one path and one node per organism, one stub per failed arm, and an
 * accessible sentence that says exactly how many of each. Nothing here counts
 * anything — the layout already did, from the record.
 */
export interface LaneCanvasProps {
  experiment: LabExperiment
  checkpoint?: LabCheckpoint | null
  failedArms?: readonly FailedArm[]
  width?: number
  height?: number
}

function cssRgba(source: { readonly rgb: readonly [number, number, number]; readonly alpha: number }): string {
  const [r, g, b] = source.rgb
  return `rgba(${r}, ${g}, ${b}, ${source.alpha})`
}

function pathD(points: readonly { x: number; y: number }[]): string {
  const [a, b, c] = points
  if (a === undefined || b === undefined || c === undefined) return ''
  return `M${a.x.toFixed(2)},${a.y.toFixed(2)} Q${b.x.toFixed(2)},${b.y.toFixed(2)} ${c.x.toFixed(2)},${c.y.toFixed(2)}`
}

export function describeCanvas(layout: CanvasLayout, forkId: string): string {
  const n = layout.organisms.length
  const stubs = layout.stubs.length
  return `${n} organism${n === 1 ? '' : 's'} from ${n} run${n === 1 ? '' : 's'} of experiment ${forkId}${stubs === 0 ? '' : ` — and ${stubs} arm${stubs === 1 ? '' : 's'} that never dispatched`}`
}

export function LaneCanvas({ experiment, checkpoint = null, failedArms = [], width = 480, height = 160 }: LaneCanvasProps) {
  const layout = layoutCanvas({ experiment, checkpoint, failedArms, width, height })
  return (
    <svg
      data-testid={`lane-canvas-${experiment.forkId}`}
      data-organisms={layout.organisms.length}
      data-stubs={layout.stubs.length}
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      role="img"
      aria-label={describeCanvas(layout, experiment.forkId)}
      className="block h-auto w-full"
    >
      <circle cx={layout.root.at.x} cy={layout.root.at.y} r={layout.root.radius} fill={cssRgba(layout.root.ink)} data-testid={`lane-canvas-root-${experiment.forkId}`} />
      {layout.organisms.map((organism) => (
        <g key={organism.id} data-testid={`canvas-organism-${organism.id}`} data-state={organism.state} data-arm={organism.arm} data-run={organism.run}>
          <path d={pathD(organism.path)} stroke={cssRgba(organism.ink)} strokeWidth={organism.width} strokeDasharray={`${SYNTHETIC_DASH[0]} ${SYNTHETIC_DASH[1]}`} fill="none" strokeLinecap="round" />
          <circle cx={organism.node.x} cy={organism.node.y} r={organism.state === 'unmeasured' ? 2.5 : 3.5} fill={organism.state === 'unmeasured' ? 'none' : cssRgba(organism.nodeInk)} stroke={cssRgba(organism.nodeInk)} strokeWidth={1.25} />
        </g>
      ))}
      {layout.stubs.map((stub) => (
        <g key={`stub-${stub.arm}`} data-testid={`canvas-stub-${stub.arm}`}>
          <line x1={stub.at.x} y1={stub.at.y} x2={stub.at.x + 8} y2={stub.at.y + 6} stroke="var(--color-broken)" strokeWidth={1.25} strokeDasharray="2 2" />
          <title>{`arm ${stub.arm} never dispatched — ${stub.error}`}</title>
        </g>
      ))}
    </svg>
  )
}
