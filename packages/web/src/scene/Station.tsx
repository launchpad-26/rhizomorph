import { useFrame } from '@react-three/fiber'
import { useMemo, useRef } from 'react'
import * as THREE from 'three'
import type { BranchLayout } from './layout.js'
import { stationPosition, toTuple } from './layout.js'
import { PALETTE, STATUS_COLOR } from './palette.js'
import { livenessGlow, stationLiveness } from './sceneModel.js'

/**
 * One worktree: a lit core, an additive halo whose brightness *is* agent
 * liveness (flatline = dim), and a wireframe cage when hovered or focused.
 * No post-processing bloom — the halo is a cheap stand-in that costs one
 * transparent sphere instead of a render pass.
 */

const CORE_RADIUS = 0.24

export interface StationProps {
  branch: BranchLayout
  now: number
  active: boolean
  onHover: (id: string | null) => void
}

export function Station({ branch, now, active, onHover }: StationProps) {
  const group = useRef<THREE.Group>(null)
  const halo = useRef<THREE.Mesh>(null)
  const cage = useRef<THREE.Mesh>(null)

  const { station } = branch
  const liveness = stationLiveness(station, now)
  const glow = livenessGlow(liveness)
  const color = station.agentStatus ? STATUS_COLOR[station.agentStatus] : PALETTE.cyan
  const position = stationPosition(branch)
  // Deterministic phase so ten stations don't breathe in lockstep.
  const phase = useMemo(() => hashPhase(station.id), [station.id])
  const fade = 1 - branch.convergence

  useFrame((state) => {
    const t = state.clock.elapsedTime
    const breathe = liveness === 'live' ? 1 + Math.sin(t * 1.8 + phase) * 0.09 : 1
    if (halo.current) halo.current.scale.setScalar(breathe * (active ? 1.25 : 1))
    if (cage.current) cage.current.rotation.y = t * 0.4
    if (group.current) group.current.scale.setScalar(Math.max(fade, 0.001))
  })

  return (
    <group ref={group} position={toTuple(position)}>
      <mesh
        onPointerOver={(event) => {
          event.stopPropagation()
          onHover(station.id)
        }}
        onPointerOut={() => onHover(null)}
      >
        {/* Generous invisible hit area — a 0.24 sphere is hard to hover. */}
        <sphereGeometry args={[CORE_RADIUS * 3, 8, 8]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>

      <mesh>
        <sphereGeometry args={[CORE_RADIUS, 24, 24]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={0.4 + glow * 2.2}
          roughness={0.35}
          metalness={0.1}
          toneMapped={false}
          transparent
          opacity={fade}
        />
      </mesh>

      <mesh ref={halo}>
        <sphereGeometry args={[CORE_RADIUS * 2.6, 16, 16]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={(0.05 + glow * 0.16) * fade}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>

      {active && (
        <mesh ref={cage}>
          <icosahedronGeometry args={[CORE_RADIUS * 2.1, 1]} />
          <meshBasicMaterial color={PALETTE.cyan} wireframe transparent opacity={0.5} />
        </mesh>
      )}
    </group>
  )
}

function hashPhase(id: string): number {
  let hash = 0
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) | 0
  }
  return (Math.abs(hash) % 628) / 100
}
