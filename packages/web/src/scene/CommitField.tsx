import { useLayoutEffect, useRef } from 'react'
import * as THREE from 'three'
import { MAX_BEADS, type CommitBead } from './layout.js'
import { PALETTE, TRUNK_COLOR } from './palette.js'

/**
 * Every commit in the swarm as one instanced draw call. ~200 commits is the
 * stated target; the pool is sized for 1200 so a long session degrades by
 * dropping beads (see `MAX_BEADS`) rather than by dropping frames.
 */

const dim = new THREE.Color(PALETTE.dim)
const branchHot = new THREE.Color(PALETTE.cyan)
const trunkHot = new THREE.Color(TRUNK_COLOR)

export function CommitField({ beads }: { beads: CommitBead[] }) {
  const mesh = useRef<THREE.InstancedMesh>(null)

  useLayoutEffect(() => {
    const instanced = mesh.current
    if (!instanced) return

    const matrix = new THREE.Matrix4()
    const scale = new THREE.Vector3()
    const position = new THREE.Vector3()
    const quaternion = new THREE.Quaternion()
    const color = new THREE.Color()

    const count = Math.min(beads.length, MAX_BEADS)
    for (let index = 0; index < count; index += 1) {
      const bead = beads[index] as CommitBead
      // Bigger commits read as heavier beads, with a floor so nothing vanishes.
      const size = 0.75 + Math.min(bead.commit.files, 12) * 0.05
      position.set(bead.position[0], bead.position[1], bead.position[2])
      scale.setScalar(size * (0.6 + bead.recency * 0.6))
      matrix.compose(position, quaternion, scale)
      instanced.setMatrixAt(index, matrix)
      color.copy(dim).lerp(bead.onTrunk ? trunkHot : branchHot, 0.25 + bead.recency * 0.75)
      instanced.setColorAt(index, color)
    }

    instanced.count = count
    instanced.instanceMatrix.needsUpdate = true
    if (instanced.instanceColor) instanced.instanceColor.needsUpdate = true
  }, [beads])

  return (
    <instancedMesh
      ref={mesh}
      args={[undefined, undefined, MAX_BEADS]}
      // Instances live all over the scene; the pool's own bounds are wrong.
      frustumCulled={false}
    >
      <sphereGeometry args={[0.055, 8, 8]} />
      <meshBasicMaterial toneMapped={false} />
    </instancedMesh>
  )
}
