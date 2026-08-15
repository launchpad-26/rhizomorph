/**
 * A WEBGL2 CONTEXT THAT RECORDS INSTEAD OF RASTERISING.
 *
 * `marks.test.ts` already had one of these for canvas 2D, and its docblock said
 * why: *"the context is recorded rather than rasterised — what is worth asserting
 * is that the painter issues the calls the display list implies and none of its
 * own."* The argument is unchanged and the surface is friendlier. A 2D context's
 * meaning lives in a rasteriser, so recording `fill()` tells you a path was
 * filled and nothing about what came out. A GL context's meaning lives in the
 * call sequence itself: which program, which blend function, which stencil op,
 * how many vertices from which offset. Recording it is not a shadow of the real
 * thing, it *is* the submission.
 *
 * This is the half of #244 that a renderer swap can pay back. See `frame.ts` for
 * the other half — the geometry, which needs no context at all.
 *
 * It is deliberately permissive: every query answers success, because the point
 * is to exercise the painter's path rather than to simulate a driver.
 */

export interface GlCall {
  name: string
  args: readonly unknown[]
}

export interface RecordingGl {
  gl: WebGL2RenderingContext
  calls: GlCall[]
  /** Every call of one name, in order. */
  of(name: string): GlCall[]
  names(): string[]
  reset(): void
  /** Flip to make `isContextLost()` answer true, as a real driver reset does. */
  contextLost: boolean
}

/** The enums the painter reaches for, each its own distinguishable value. */
const ENUMS = [
  'ALWAYS',
  'ARRAY_BUFFER',
  'BLEND',
  'COLOR_BUFFER_BIT',
  'COMPILE_STATUS',
  'DEPTH_TEST',
  'EQUAL',
  'FLOAT',
  'FRAGMENT_SHADER',
  'INVERT',
  'KEEP',
  'LINEAR',
  'LINK_STATUS',
  'ONE',
  'ONE_MINUS_SRC_ALPHA',
  'R8',
  'RED',
  'REPEAT',
  'SCISSOR_TEST',
  'STATIC_DRAW',
  'STENCIL_BUFFER_BIT',
  'STENCIL_TEST',
  'STREAM_DRAW',
  'TEXTURE0',
  'TEXTURE_2D',
  'TEXTURE_MAG_FILTER',
  'TEXTURE_MIN_FILTER',
  'TEXTURE_WRAP_S',
  'TEXTURE_WRAP_T',
  'TRIANGLES',
  'UNPACK_ALIGNMENT',
  'UNSIGNED_BYTE',
  'VERTEX_SHADER',
  'ZERO',
] as const

/** Calls that hand back a handle rather than a value. */
const HANDLES = [
  'createBuffer',
  'createProgram',
  'createShader',
  'createTexture',
  'createVertexArray',
  'getUniformLocation',
] as const

/** Calls that answer a question. Every one of them answers yes. */
const QUERIES: Record<string, unknown> = {
  getShaderParameter: true,
  getProgramParameter: true,
  getShaderInfoLog: '',
  getProgramInfoLog: '',
}

const VOIDS = [
  'activeTexture',
  'attachShader',
  'bindBuffer',
  'bindTexture',
  'bindVertexArray',
  'blendFunc',
  'bufferData',
  'clear',
  'clearColor',
  'clearStencil',
  'colorMask',
  'compileShader',
  'deleteBuffer',
  'deleteProgram',
  'deleteShader',
  'deleteTexture',
  'deleteVertexArray',
  'disable',
  'drawArrays',
  'enable',
  'enableVertexAttribArray',
  'linkProgram',
  'pixelStorei',
  'shaderSource',
  'stencilFunc',
  'stencilMask',
  'stencilOp',
  'texImage2D',
  'texParameteri',
  'uniform1f',
  'uniform1i',
  'uniform2f',
  'uniform3f',
  'uniform4f',
  'useProgram',
  'vertexAttribPointer',
  'viewport',
] as const

export function recordingGl(): RecordingGl {
  const calls: GlCall[] = []
  const context: Record<string, unknown> = {}
  let handles = 0

  ENUMS.forEach((name, index) => {
    context[name] = 0x1000 + index
  })

  const note =
    (name: string, answer: (args: unknown[]) => unknown) =>
    (...args: unknown[]): unknown => {
      calls.push({ name, args })
      return answer(args)
    }

  for (const name of VOIDS) context[name] = note(name, () => undefined)
  for (const name of HANDLES) {
    context[name] = note(name, () => {
      handles += 1
      return { handle: handles, of: name }
    })
  }
  for (const [name, answer] of Object.entries(QUERIES)) context[name] = note(name, () => answer)

  const recording: RecordingGl = {
    gl: context as unknown as WebGL2RenderingContext,
    calls,
    of: (name: string) => calls.filter((call) => call.name === name),
    names: () => calls.map((call) => call.name),
    reset: () => {
      calls.length = 0
    },
    contextLost: false,
  }

  context.isContextLost = note('isContextLost', () => recording.contextLost)
  return recording
}
