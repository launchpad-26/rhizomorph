import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import type { SceneLayout, Vec3 } from './layout.js'
import { lerp3, stationPosition } from './layout.js'
import { PALETTE } from './palette.js'
import { allStations, type SceneModel } from './sceneModel.js'

/**
 * `commit.landed` made visible: a bright traveller running out along the
 * branch line it landed on.
 *
 * Spawned by sha, not by count, so replay and reconnect can't double-fire.
 * On mount the whole backlog is marked seen and only genuinely recent commits
 * flare — otherwise every reload would fire two hundred pulses at once.
 */

const MAX_PULSES = 32
const PULSE_MS = 1_500
/** A commit older than this on arrival is history, not news. */
const PULSE_WINDOW_MS = 10_000

interface Pulse {
  from: Vec3
  to: Vec3
  startedAt: number
}

interface Route {
  from: Vec3
  to: Vec3
}

export function Pulses({ layout, model }: { layout: SceneLayout; model: SceneModel }) {
  const mesh = useRef<THREE.InstancedMesh>(null)
  const pulses = useRef<Pulse[]>([])
  const seen = useRef(new Set<string>())

  const routes = useMemo(() => {
    const map = new Map<string, Route>()
    if (model.trunk) map.set(model.trunk.id, { from: layout.trunkBottom, to: layout.trunkTop })
    for (const branch of layout.branches) {
      map.set(branch.station.id, { from: branch.anchor, to: stationPosition(branch) })
    }
    return map
  }, [layout, model.trunk])

  useEffect(() => {
    const now = Date.now()
    for (const station of allStations(model)) {
      for (const commit of station.commits) {
        if (seen.current.has(commit.sha)) continue
        seen.current.add(commit.sha)
        if (now - commit.ts > PULSE_WINDOW_MS) continue
        const route = routes.get(station.id)
        if (!route) continue
        pulses.current.push({ from: route.from, to: route.to, startedAt: now })
      }
    }
    if (pulses.current.length > MAX_PULSES) {
      pulses.current.splice(0, pulses.current.length - MAX_PULSES)
    }
  }, [model, routes])

  useFrame(() => {
    const instanced = mesh.current
    if (!instanced) return

    const now = Date.now()
    pulses.current = pulses.current.filter((pulse) => now - pulse.startedAt < PULSE_MS)

    const matrix = new THREE.Matrix4()
    const position = new THREE.Vector3()
    const quaternion = new THREE.Quaternion()
    const scale = new THREE.Vector3()

    for (let index = 0; index < MAX_PULSES; index += 1) {
      const pulse = pulses.current[index]
      if (!pulse) {
        matrix.makeScale(0, 0, 0)
        instanced.setMatrixAt(index, matrix)
        continue
      }
      const t = (now - pulse.startedAt) / PULSE_MS
      const point = lerp3(pulse.from, pulse.to, easeOut(t))
      position.set(point[0], point[1], point[2])
      // Swells on departure, thins out as it lands.
      scale.setScalar(1.6 * Math.sin(Math.PI * t) + 0.2)
      matrix.compose(position, quaternion, scale)
      instanced.setMatrixAt(index, matrix)
    }

    instanced.count = MAX_PULSES
    instanced.instanceMatrix.needsUpdate = true
  })

  return (
    <instancedMesh ref={mesh} args={[undefined, undefined, MAX_PULSES]} frustumCulled={false}>
      <sphereGeometry args={[0.1, 10, 10]} />
      <meshBasicMaterial
        color={PALETTE.amber}
        toneMapped={false}
        transparent
        opacity={0.9}
        blending={THREE.AdditiveBlending}
        depthWrite={false}
      />
    </instancedMesh>
  )
}

function easeOut(t: number): number {
  return 1 - (1 - t) * (1 - t)
}
