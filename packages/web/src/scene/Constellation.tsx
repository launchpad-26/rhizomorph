import { Line, OrbitControls } from '@react-three/drei'
import { useFrame } from '@react-three/fiber'
import { useMemo, useRef } from 'react'
import * as THREE from 'three'
import { CommitField } from './CommitField.js'
import { Pulses } from './Pulses.js'
import { Station } from './Station.js'
import { stationPosition, toTuple, type SceneLayout } from './layout.js'
import { PALETTE, TRUNK_COLOR } from './palette.js'
import { livenessGlow, stationLiveness, type SceneModel } from './sceneModel.js'

/**
 * The constellation itself: main as the central trunk/star, worktrees as
 * stations orbiting it, branch lines that grow with commits, commits as
 * beads, `commit.landed` as a pulse running the line.
 *
 * Everything here is a function of `layout` + `model` — the scene owns no
 * state of its own beyond animation clocks.
 */

export interface ConstellationProps {
  model: SceneModel
  layout: SceneLayout
  /** Clock used for liveness only, so tests can pin it. */
  now: number
  hoveredId: string | null
  focusedId: string | null
  onHover: (id: string | null) => void
}

export function Constellation({
  model,
  layout,
  now,
  hoveredId,
  focusedId,
  onHover,
}: ConstellationProps) {
  const visible = layout.branches.filter((branch) => branch.visible)

  return (
    <>
      <color attach="background" args={[PALETTE.void]} />
      {/* Starts past the trunk so the centre stays crisp and only the far
          side of the swarm sinks into the void. */}
      <fog attach="fog" args={[PALETTE.void, 14, 32]} />
      <ambientLight intensity={0.4} />
      <pointLight position={[0, 0, 0]} intensity={12} distance={18} color={TRUNK_COLOR} />

      <Starfield />

      <Line
        points={[toTuple(layout.trunkBottom), toTuple(layout.trunkTop)]}
        color={TRUNK_COLOR}
        lineWidth={2}
        transparent
        opacity={0.55}
      />
      <Trunk model={model} now={now} active={model.trunk?.id === (hoveredId ?? focusedId)} />

      {visible.map((branch) => {
        const glow = livenessGlow(stationLiveness(branch.station, now))
        const active = branch.station.id === hoveredId || branch.station.id === focusedId
        return (
          <group key={branch.station.id}>
            <Line
              points={[toTuple(branch.anchor), toTuple(stationPosition(branch))]}
              color={active ? PALETTE.cyan : PALETTE.line}
              lineWidth={active ? 2 : 1}
              transparent
              opacity={(0.22 + glow * 0.5) * (1 - branch.convergence)}
            />
            <Station branch={branch} now={now} active={active} onHover={onHover} />
          </group>
        )
      })}

      <CommitField beads={layout.beads} />
      <Pulses layout={layout} model={model} />

      <OrbitControls
        makeDefault
        enablePan={false}
        enableDamping
        dampingFactor={0.08}
        autoRotate
        autoRotateSpeed={0.32}
        minDistance={5}
        maxDistance={22}
      />
    </>
  )
}

/** Main: the star everything else is measured against. */
function Trunk({ model, now, active }: { model: SceneModel; now: number; active: boolean }) {
  const halo = useRef<THREE.Mesh>(null)
  const glow = model.trunk === null ? 0.25 : livenessGlow(stationLiveness(model.trunk, now))

  useFrame((state) => {
    if (halo.current) {
      halo.current.scale.setScalar(1 + Math.sin(state.clock.elapsedTime * 1.1) * 0.06)
    }
  })

  return (
    <group>
      <mesh>
        <icosahedronGeometry args={[0.44, 2]} />
        <meshStandardMaterial
          color={TRUNK_COLOR}
          emissive={TRUNK_COLOR}
          emissiveIntensity={1.4 + glow}
          roughness={0.25}
          toneMapped={false}
        />
      </mesh>
      <mesh ref={halo}>
        <sphereGeometry args={[0.95, 24, 24]} />
        <meshBasicMaterial
          color={TRUNK_COLOR}
          transparent
          opacity={active ? 0.16 : 0.1}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
    </group>
  )
}

const STAR_COUNT = 700

/** Static backdrop. One draw call, never updated — pure atmosphere. */
function Starfield() {
  const positions = useMemo(() => {
    const array = new Float32Array(STAR_COUNT * 3)
    // Deterministic scatter on a shell, so the sky is the same every load.
    for (let index = 0; index < STAR_COUNT; index += 1) {
      const golden = Math.PI * (3 - Math.sqrt(5))
      const y = 1 - (index / (STAR_COUNT - 1)) * 2
      const radius = Math.sqrt(Math.max(1 - y * y, 0))
      const theta = golden * index
      const distance = 26 + ((index * 37) % 11)
      array[index * 3] = Math.cos(theta) * radius * distance
      array[index * 3 + 1] = y * distance
      array[index * 3 + 2] = Math.sin(theta) * radius * distance
    }
    return array
  }, [])

  return (
    <points frustumCulled={false}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <pointsMaterial
        size={0.11}
        sizeAttenuation
        color={PALETTE.slate}
        transparent
        opacity={0.65}
        toneMapped={false}
      />
    </points>
  )
}
