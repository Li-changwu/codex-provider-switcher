# Codex Provider Switcher

VS Code extension for maintaining named local Codex provider profiles and switching the active profile safely.

## Supported Hosts

- Windows native extension host.
- Linux native extension host.
- VS Code Remote SSH when the extension host is Linux.

macOS, WSL, cross-device switching, and cloud profile/session synchronization are not supported.

## Install

### VS Code Marketplace

Install [Codex Provider Switcher from the VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=Li-changwu.codex-provider-switcher) in the Extensions view, or run:

```text
code --install-extension Li-changwu.codex-provider-switcher
```

VS Code automatically selects the compatible target package for the machine running the Extension Host. In a Remote SSH window, install the extension on the SSH host; VS Code selects the `linux-x64` package for a compatible remote glibc Linux x64 host. The available Marketplace targets are:

- Native Windows x64: `win32-x64`.
- Native glibc Linux x64: `linux-x64`.
- Remote SSH to glibc Linux x64: `linux-x64` on the remote Extension Host.

macOS, WSL, musl Linux, non-x64 hosts, and browser Extension Hosts are not supported.

### GitHub Releases

For an offline or manually verified installation, download the VSIX and `SHA256SUMS.txt` from [GitHub Releases](https://github.com/Li-changwu/codex-provider-switcher/releases). Choose the file for the machine running the VS Code Extension Host:

- Native Windows x64: `codex-provider-switcher-<version>@win32-x64.vsix`.
- Native glibc Linux x64: `codex-provider-switcher-<version>@linux-x64.vsix`.
- Remote SSH Linux x64: open the Remote SSH window first, then use the Linux VSIX in that window so VS Code installs it on the remote Extension Host.

Do not install either artifact on macOS, WSL, musl Linux, or a different CPU architecture.

Each release includes `SHA256SUMS.txt`. Verify the downloaded VSIX before installation:

```powershell
$vsix = "codex-provider-switcher-<version>@win32-x64.vsix"
$expected = (Select-String -Path .\SHA256SUMS.txt -Pattern "  $([regex]::Escape($vsix))$").Line.Split("  ")[0]
(Get-FileHash ".\$vsix" -Algorithm SHA256).Hash.ToLowerInvariant() -eq $expected
```

```sh
grep -F "  codex-provider-switcher-<version>@linux-x64.vsix" SHA256SUMS.txt | sha256sum -c -
```

The selected command must print `True` or `OK`; otherwise, do not install the file.

In VS Code, open the Extensions view, select the `...` menu, select **Install from VSIX...**, and choose the verified file. For Remote SSH, perform these steps in the connected Remote SSH window rather than a local window.

### Upgrade and Uninstall

Marketplace installations follow the normal VS Code extension update flow. To upgrade a manual installation, download and verify the newer VSIX for the same Extension Host, then repeat **Install from VSIX...**. VS Code replaces the extension while preserving its local VS Code SecretStorage and the Codex Home data on that host. To uninstall, use the extension's gear menu and choose **Uninstall** in the same local or Remote SSH window where it was installed. Uninstalling the extension does not delete Codex profiles, backups, sessions, or credentials; remove those separately only when you explicitly intend to do so.

## Profiles and Credentials

Create a named Profile with non-secret TOML configuration. Custom provider API keys are stored separately in VS Code SecretStorage; the TOML must not contain credentials.

Official Profiles use native Codex authentication. When switching to an official Profile, the extension runs native `codex login` in the current Extension Host terminal and then checks `codex login status`. If login fails, is cancelled, or status cannot be verified, the switch finishes its rollback before the command ends. OAuth credentials remain managed by Codex; the extension does not read, copy, or write them to Profiles, logs, backups, or SecretStorage.

## Switching and Recovery

Switching materializes the selected Profile, updates provider metadata for local sessions, and reports progress. A cancellation waits for rollback to finish before another command runs. The switch process creates backups, and **Codex: Restore Backup** can recover an interrupted operation. Session synchronization remains local to the current Extension Host and Codex Home; cross-device and cloud session synchronization are not supported.

On Windows volumes that report no inode data, protected file mutations use the native Windows file identity from an open handle. If that identity or the native helper is unavailable, the extension disables the unsafe operation instead of falling back to timestamps or path-only checks.

**Codex: Continue Session** starts native Codex resume only. Session content can be encrypted or otherwise unavailable, so there is no automatic transcript transfer or readable-content fallback without explicit caller confirmation.

After a Profile switch commits, the extension may offer local source session IDs for native Codex continuation. It uses native Codex app-server fork or reuse only; it never displays, extracts, replays, or falls back to readable transcript content. The local mapping store retains at most three active branches for each source session and target Profile, using local native archive and unarchive operations as needed. Manual **Codex: Continue Session** remains native resume.

## Commands

- **Codex: Create Profile**
- **Codex: Edit Profile**
- **Codex: Switch Profile**
- **Codex: Sync Sessions**
- **Codex: Continue Session**
- **Codex: Restore Backup**

The status bar shows the active Profile name when it is available. Select it to switch Profiles.

## Development

```powershell
npm run build
npm run check
npm test
npm run test:integration
npm run package
npm run package:win32-x64
npm run package:linux-x64
```

Native continuation requires a native Codex installation with app-server support. Focused continuation checks are:

```powershell
npx tsx --test test/unit/app-server-fork.test.ts
npx tsx --test test/unit/native-continuation-terminal.test.ts
npx tsx --test test/integration/continuation.test.ts
```

Keep secrets out of configuration, tests, documentation, commits, and logs. This README intentionally contains no API-key example or real credential.
