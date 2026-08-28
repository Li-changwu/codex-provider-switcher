# Codex Provider Switcher

VS Code extension for maintaining named local Codex provider profiles and switching the active profile safely.

## Supported Hosts

- Windows native extension host.
- Linux native extension host.
- VS Code Remote SSH when the extension host is Linux.

macOS, WSL, cross-device switching, and cloud profile/session synchronization are not supported.

## Profiles and Credentials

Create a named Profile with non-secret TOML configuration. Custom provider API keys are stored separately in VS Code SecretStorage; the TOML must not contain credentials.

Official Profiles use native Codex authentication. Run `codex login` yourself in a native terminal when it is needed. The extension does not read, copy, or store native login credentials.

## Switching and Recovery

Switching materializes the selected Profile, updates provider metadata for local sessions, and reports progress. A cancellation waits for rollback to finish before another command runs. The switch process creates backups, and **Codex: Restore Backup** can recover an interrupted operation.

**Codex: Continue Session** starts native Codex resume only. Session content can be encrypted or otherwise unavailable, so there is no automatic transcript transfer or readable-content fallback without explicit caller confirmation.

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

Keep secrets out of configuration, tests, documentation, commits, and logs. This README intentionally contains no API-key example or real credential.
