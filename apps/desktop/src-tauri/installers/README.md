# Windows installer identity

`windows.nsi` vendors the official Tauri NSIS template for the locked and
installed `@tauri-apps/cli` version **2.12.3**. It keeps the existing NSIS
updater channel across the Raccoon rename.

## Provenance

- Official repository: <https://github.com/tauri-apps/tauri>
- Release tag: `tauri-cli-v2.12.3`
- Tag commit: `59b63ab500da9859f12d8888c3298bc29bba0b92`
- Immutable template source:
  <https://raw.githubusercontent.com/tauri-apps/tauri/59b63ab500da9859f12d8888c3298bc29bba0b92/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi>
- Original template SHA-256:
  `8ae02c66f8adb4a0d15d97f984fbacd2b44262d8a4d03fefaf6177f67f7008e5`
- License source:
  <https://raw.githubusercontent.com/tauri-apps/tauri/59b63ab500da9859f12d8888c3298bc29bba0b92/LICENSE-MIT>

The only upstream changes are these two complete technical key literals,
derived from the pre-rename Git baseline below:

```diff
-!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCTNAME}"
+!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Nexus"
 !define MANUKEY "Software\${MANUFACTURER}"
-!define MANUPRODUCTKEY "${MANUKEY}\${PRODUCTNAME}"
+!define MANUPRODUCTKEY "Software\nexusstudio\Nexus"
```

Both product name and publisher may change independently. Deriving the second
key from `${MANUKEY}` would therefore change the installation identity again.
The manufacturer segment must follow the pinned NSIS fallback, independently
of Cargo authors.

## Pre-rename baseline

The baseline was read from Git HEAD
`401fe87b894224d8e3afa8c64d817631e785608f` before the Raccoon release commit,
using `rtk proxy git show HEAD:<path>`. The tests retain this immutable identity
snapshot so they also run in shallow CI checkouts after HEAD changes.

| Source at that revision                  | Identity field     | Value                     |
| ---------------------------------------- | ------------------ | ------------------------- |
| `apps/desktop/src-tauri/tauri.conf.json` | `productName`      | `Nexus`                   |
| `apps/desktop/src-tauri/tauri.conf.json` | `identifier`       | `com.nexusstudio.desktop` |
| Base and Windows release configurations  | `bundle.publisher` | absent                    |
| `apps/desktop/src-tauri/Cargo.toml`      | `package.authors`  | `["Nexus Studio"]`        |
| `apps/desktop/package.json`              | `@tauri-apps/cli`  | `2.12.3`                  |

The pinned NSIS bundler defaults manufacturer to identifier component
`nexusstudio`, not to `Nexus Studio`. Thus the location key is
`Software\nexusstudio\Nexus`, and the uninstall key ends in `Nexus`.
`Software\Nexus Studio\Nexus` would require an explicit historical publisher
override, which is absent from this baseline. Old shortcut names use
`Nexus.lnk`; authors are not the old product name.

The `installerHooks` include appears before the unconditional key definitions.
The first `NSIS_HOOK_PREINSTALL` expansion is inside `Section Install`, after
`.onInit` restores the previous installation path and maintenance detection can
run. A supported hook cannot replace these identities early enough, so the full
official template is retained.

Everything else remains upstream, including the explicit installation-directory
guard, current-user mode, signing, maintenance choices, and the NSIS `/UPDATE`
branch that bypasses the previous NSIS uninstaller. No migration commands or
additional data deletion are introduced. Application data still uses the
unchanged `com.nexusstudio.desktop` identifier.

No shortcut migration hook is added. Existing shortcuts are left to upstream
behavior; this patch does not claim that old shortcut names are renamed or
removed. It does not synthesize a previous installation or old shortcuts on a
fresh install. New installations use the same stable technical registry keys
while displaying the current product name and publisher.

## Configuration to merge

Merge the following fields into `apps/desktop/src-tauri/tauri.conf.json`, retaining
the existing WiX configuration and other bundle settings:

```json
{
  "bundle": {
    "publisher": "Raccoon",
    "windows": {
      "nsis": {
        "template": "installers/windows.nsi",
        "installMode": "currentUser"
      }
    }
  }
}
```

`template` is relative to the Tauri configuration directory. No
`installerHooks` setting is needed. Keep the existing bundle targets so NSIS
installers and updater artifacts continue to be produced.

Set `bundle.publisher` explicitly: the pinned NSIS bundler uses
`settings.publisher()` and otherwise falls back to the second identifier
component (`nexusstudio` here). It does not use `Cargo.authors` for this fallback.
The CLI passes `config.publisher` into `BundleSettings.publisher`. The visible
`DisplayName` and `Publisher` remain `${PRODUCTNAME}` and `${MANUFACTURER}`.
Pinned implementation sources:

- <https://raw.githubusercontent.com/tauri-apps/tauri/59b63ab500da9859f12d8888c3298bc29bba0b92/crates/tauri-bundler/src/bundle/windows/nsis/mod.rs>
- <https://raw.githubusercontent.com/tauri-apps/tauri/59b63ab500da9859f12d8888c3298bc29bba0b92/crates/tauri-cli/src/interface/rust.rs>

## Verification and updates

`scripts/lib/windows-installer.test.mjs` reads local files without building the
application or downloading upstream sources. It normalizes CRLF to LF, reverses
only the two key changes, and requires the resulting SHA-256 to match the
original official template. It also checks key expansion for changing brands
and publishers, dynamic display values, early key use, the installation-path
guard, updater behavior, and the configuration above.
It derives expected technical keys from the recorded Git identity fields and
rejects both treating authors as the product name and using authors as an
implicit NSIS manufacturer.

When upgrading the CLI, obtain the official template from the matching release
tag's immutable commit, verify its digest, reapply only the two key changes, and
update this provenance and the test pins together. Review upstream maintenance
and updater changes before accepting a new digest.

These checks are static policy and integrity checks. No local application build,
NSIS compilation, Windows installation, upgrade, signing, or runtime validation
is claimed.

## Upstream MIT license

```text
MIT License

Copyright (c) 2017 - Present Tauri Apps Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
