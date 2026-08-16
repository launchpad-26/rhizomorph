import { describe, expect, it } from 'vitest'
import { HOST_CAPABILITIES, HOST_GLOBAL, hostName, hostProvides, readHost } from './host.js'

/**
 * THE HOST PROBE (#574) — the seam prd-34's shell turns eight controls on
 * through, without editing a file under `settings/`.
 *
 * The claims worth holding are the two failure directions. **Fail closed:** a
 * descriptor that is absent, malformed, anonymous or empty reads as no host, so
 * the groups stay disabled with their reason — the state that tells the truth
 * when the truth is unknown. **Fail honest:** a host may not enable a control
 * by declaring a capability nobody here knows about, so the vocabulary is
 * closed and a typo in the shell's preload is a disabled control rather than a
 * silently live one.
 */

/** A scope object standing in for `globalThis`, so no test touches the real global. */
function scopeWith(descriptor: unknown): object {
  return { [HOST_GLOBAL]: descriptor }
}

describe('a browser is the default, and every malformed answer collapses to it', () => {
  it('reads no host when nothing announced one', () => {
    expect(readHost({})).toBeNull()
    expect(hostName({})).toBe('a browser')
    for (const capability of HOST_CAPABILITIES) expect(hostProvides(capability, {})).toBe(false)
  })

  it.each([
    ['not an object', 'the desktop shell'],
    ['no name', { capabilities: ['shell'] }],
    ['an empty name', { name: '', capabilities: ['shell'] }],
    ['no capabilities', { name: 'the desktop shell' }],
    ['an empty capability list', { name: 'the desktop shell', capabilities: [] }],
    ['capabilities that are not a list', { name: 'the desktop shell', capabilities: 'shell' }],
    ['only capabilities nobody here knows', { name: 'the desktop shell', capabilities: ['teleport'] }],
  ])('reads no host from a descriptor with %s', (_case, descriptor) => {
    expect(readHost(scopeWith(descriptor))).toBeNull()
  })

  it('drops an unknown capability without dropping the host that declared it', () => {
    // A shell one version ahead may name something this build has never heard
    // of. That is not a reason to refuse the whole descriptor — but it is also
    // not a capability, and nothing here may act on it.
    const scope = scopeWith({ name: 'the desktop shell', capabilities: ['shell', 'teleport'] })
    expect(readHost(scope)).toEqual({ name: 'the desktop shell', capabilities: ['shell'] })
  })
})

describe('a host that says what it is, and only what it says', () => {
  it('provides exactly what it declared', () => {
    const scope = scopeWith({ name: 'the desktop shell', capabilities: ['shell', 'notify'] })

    expect(hostName(scope)).toBe('the desktop shell')
    expect(hostProvides('shell', scope)).toBe(true)
    expect(hostProvides('notify', scope)).toBe(true)
    // The three it did not claim — a shell whose tray never appeared is a real
    // host, and it does not get the tray controls by being a shell.
    expect(hostProvides('tray', scope)).toBe(false)
    expect(hostProvides('launchAtLogin', scope)).toBe(false)
    expect(hostProvides('updates', scope)).toBe(false)
  })

  it('names five capabilities and no more — the vocabulary is closed', () => {
    expect(HOST_CAPABILITIES).toEqual(['shell', 'tray', 'notify', 'launchAtLogin', 'updates'])
  })

  it('announces itself under an undotted global, so the storage law has nothing to exempt', () => {
    // `coverage-law.test.tsx` sweeps the package for `rhizomorph.*` string
    // literals and allows them in `registry.ts` alone. A host descriptor is not
    // a storage key and must not need an exception in a law about storage.
    expect(HOST_GLOBAL).toBe('rhizomorphHost')
    expect(/['"`]rhizomorph\.[A-Za-z0-9.]+['"`]/.test(`'${HOST_GLOBAL}'`)).toBe(false)
  })
})
