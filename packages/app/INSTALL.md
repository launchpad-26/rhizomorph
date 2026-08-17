# Installing rhizomorph

Download the installer for your platform, run it, and open the app. It starts
its own server on `127.0.0.1`, opens a window on it, and puts an icon in your
tray. Nothing leaves your machine.

| platform | file |
|---|---|
| Windows | `rhizomorph-Setup-<version>.exe` |
| macOS | `rhizomorph-<version>-<arch>.dmg` |
| Linux | `rhizomorph-<version>-<arch>.AppImage`, or the `.deb` |

## Your system will warn about this app, and here is exactly what it will say

**These builds are not signed.** That is a deliberate decision, not an
oversight — prd-34 **ruling 9**: code signing costs ~$120/yr for Windows
(Azure Trusted Signing) and ~$99/yr for macOS (Apple Developer, and it is
mandatory for macOS auto-update). Signing buys trust from people who do not
already have it, and that audience arrives at a real release rather than at a
merge. The packaging pipeline is built so signing is one environment variable
away; the money is spent when there is something to sign for someone.

So the warnings below are expected. Each one is what an *unsigned* app looks
like, not what a *dangerous* one looks like — the difference is that nobody has
paid a platform authority to vouch for the publisher.

### Windows

> **Windows protected your PC**
> Microsoft Defender SmartScreen prevented an unrecognised app from starting.

Choose **More info**, then **Run anyway**.

### macOS

> **“rhizomorph” cannot be opened because the developer cannot be verified.**

or, on newer versions:

> **“rhizomorph” is damaged and can’t be opened. You should move it to the
> Trash.**

The second one is Gatekeeper's message for an unsigned app that has been through
the quarantine flag, and it is misleading — nothing is damaged. Either:

- right-click the app in Applications and choose **Open**, then **Open** again
  in the dialog; or
- clear the quarantine attribute once:

  ```sh
  xattr -dr com.apple.quarantine /Applications/rhizomorph.app
  ```

### Linux

Nothing warns — Linux has no signing authority in the way the other two do.

```sh
chmod +x rhizomorph-<version>-<arch>.AppImage
./rhizomorph-<version>-<arch>.AppImage
```

or install the `.deb` with your usual tool.

## Verifying a download

Every release publishes SHA-256 sums beside the installers. This is the check
that is actually available without signing, so it is the one worth doing:

```sh
# macOS / Linux
shasum -a 256 rhizomorph-<version>-<arch>.dmg

# Windows (PowerShell)
Get-FileHash .\rhizomorph-Setup-<version>.exe -Algorithm SHA256
```

Compare the result with the value in the release's `SHA256SUMS`.

## What the app does on first launch

It opens the **demonstration fleet** — twenty simulated lanes, loudly labelled
as simulated in the header, on real event data through the real renderer. That
is deliberate: an instrument watching a quiet repo renders nothing, and a
stranger who did everything right would conclude it was broken.

When you are ready, **Watch my own repo…** in the application menu takes you to
`/connect`, which walks you through choosing a repository and proves the
connection row by row. The demonstration fleet stays in the menu afterwards, for
showing somebody what the tool does without waiting for a fleet to be running.

## Updates

Updates download quietly and apply when you next restart the app — never
mid-session, never under a running fleet. While builds are unsigned there is no
update feed to check against, and the tray says exactly that rather than
claiming to be up to date.

## Uninstalling

- **Windows** — Settings → Apps → rhizomorph → Uninstall.
- **macOS** — drag the app to the Trash.
- **Linux** — delete the AppImage, or `apt remove rhizomorph`.

Your recordings are not in the app bundle and are not removed with it: they live
under the data root the CLI reports (`rhizomorph doctor`), and deleting them is
your own act.
