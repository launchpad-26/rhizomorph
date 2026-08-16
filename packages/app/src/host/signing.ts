/**
 * SIGNING AS A SWITCH (#565; prd-34 **ruling 9**).
 *
 * > *The packaging pipeline is built so that signing is configuration rather
 * > than rework — certificates, notarisation and the update feed's signature
 * > checks are wired and switched off — and builds ship unsigned with install
 * > instructions that say plainly what the operating system will warn and why.*
 *
 * The decision and its reasoning, on the record so it can be revisited
 * honestly: this instrument's users today clone repositories and run
 * `npm install`, and run unsigned binaries daily. Signing buys trust from
 * people who do not already have it — a portfolio visitor, a stranger, a
 * non-technical colleague — and that audience arrives at a release, not at a
 * merge. The money (~$120/yr Azure Trusted Signing, ~$99/yr Apple Developer) is
 * spent when there is something to sign for someone.
 *
 * ## What "a switch" means concretely
 *
 * `electron-builder.yml` reads its identity from the environment, and the
 * environment is empty. Turning signing on is: put the credentials in the
 * environment, set `RHIZOMORPH_SIGN=1`, run the same workflow. No file in this
 * repo changes. {@link signingPlan} is that rule as data, so the packaging
 * workflow and the install notes read one source rather than three, and
 * `signing.test.ts` can assert the shipped default is *off* — the failure this
 * guards is the opposite of the usual one: a pipeline that quietly starts
 * demanding credentials nobody has, and fails every build.
 *
 * ## The warnings are named, not discovered
 *
 * An unsigned build is not a broken build, but it is a build that greets a
 * stranger with an alarming dialog. {@link OS_WARNINGS} is what each platform
 * actually says and what a person does about it, and `INSTALL.md` renders the
 * same text — because "ship unsigned with honest instructions" is only honest
 * if the instructions match the dialog.
 */

export type Platform = 'mac' | 'win' | 'linux'

export interface SigningPlan {
  /** Whether this build signs. False in this repo, on purpose (ruling 9). */
  enabled: boolean
  /** What the build does about the absence, per platform. */
  reason: string
  /** The environment variables that would turn it on, named so nobody has to guess at release week. */
  credentials: readonly string[]
  /** The yearly cost of turning it on, stated where the decision is made. */
  cost: string
}

/**
 * The one environment variable that flips it. Absent or anything but `1` means
 * unsigned — a signing pipeline that turned itself on when a stray credential
 * appeared in the environment would be a surprise at exactly the wrong moment.
 */
export const SIGN_ENV = 'RHIZOMORPH_SIGN'

export function signingPlan(env: NodeJS.ProcessEnv, platform: Platform): SigningPlan {
  const enabled = env[SIGN_ENV] === '1'
  const credentials =
    platform === 'mac'
      ? (['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'] as const)
      : platform === 'win'
        ? (['AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET'] as const)
        : ([] as const)

  return {
    enabled,
    reason: enabled
      ? `signing is on: ${platform} builds are signed from the environment`
      : `signing is deferred (prd-34 ruling 9) — ${platform} builds ship unsigned, with the warning documented in INSTALL.md`,
    credentials,
    cost: COST[platform],
  }
}

const COST: Record<Platform, string> = {
  mac: '~$99/yr — Apple Developer Program, and mandatory for macOS auto-update',
  win: '~$120/yr — Azure Trusted Signing (EV no longer buys a SmartScreen bypass, since 2024)',
  linux: 'nothing — no platform authority to pay',
}

export interface OsWarning {
  platform: Platform
  /**
   * The operating system's own words, verbatim — the phrase a person will read
   * on their screen and then search for. `INSTALL.md` must contain it, and
   * `signing.test.ts` asserts exactly that: paraphrasing the dialog is how
   * "honest instructions" quietly stops being true.
   */
  quote: string | null
  /** What the warning amounts to, in ours. */
  says: string
  /** What a person does about it. */
  remedy: string
}

/** What each OS will say about an unsigned build, and the way through it. `INSTALL.md` carries the same words. */
export const OS_WARNINGS: readonly OsWarning[] = [
  {
    platform: 'win',
    quote: 'Windows protected your PC',
    says: 'SmartScreen, because the publisher is unverified.',
    remedy: 'Choose **More info**, then **Run anyway**.',
  },
  {
    platform: 'mac',
    quote: 'cannot be opened because the developer cannot be verified',
    says: 'Gatekeeper, because the app is neither signed nor notarised. It may also claim the app is “damaged”, which it is not.',
    remedy:
      'Right-click the app and choose **Open**, then **Open** again; or run `xattr -dr com.apple.quarantine /Applications/rhizomorph.app` once.',
  },
  {
    platform: 'linux',
    quote: null,
    says: 'Nothing — Linux has no signing authority in the way the other two do.',
    remedy: 'Make the AppImage executable (`chmod +x`), or install the `.deb` as usual.',
  },
]

/** The note a build shows about itself, once (S3's *unsigned build* state). */
export function unsignedNote(plan: SigningPlan): string | null {
  if (plan.enabled) return null
  return 'This build is not signed. Your system will warn about it — INSTALL.md says exactly what it will say and why.'
}
