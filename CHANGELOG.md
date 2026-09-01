# Changelog

All notable changes to Codex Provider Switcher are documented in this file.

## 0.1.3

- Add the Codex Providers Activity Bar workbench with TreeView navigation and a
  VS Code-native details panel.
- Add structured and raw custom Provider editing, write-only SecretStorage API
  key handling, named official-login aliases, and an explicit re-login action.
- Make session synchronization manual, show progress and no-op status, and gate
  continuation until the selected Provider has been synchronized.
- Require confirmation before capability-unavailable continuation falls back to
  a fork, while refusing to downgrade encrypted or unreadable content errors.

## 0.1.2

- Publish under the permanent Marketplace identity
  `Li-changwu.codex-provider-switcher-vscode` after the original package name
  was found to be globally unavailable.
- Preserve the runtime behavior and supported Windows x64, Linux x64, and
  Remote SSH Extension Host boundaries from 0.1.1.

## 0.1.1

- Publish the Marketplace-ready extension metadata, icon, documentation, and
  protected two-platform Marketplace delivery workflow.
- Preserve the existing provider switching behavior and supported Windows x64,
  Linux x64, and Remote SSH Extension Host boundaries from 0.1.0.

## 0.1.0

- Create, edit, switch, and restore local Codex provider profiles.
- Preserve profile credentials in VS Code SecretStorage while writing active Codex configuration files locally.
- Synchronize local Codex sessions and continue a selected session with the active profile.
- Support Windows x64, Linux x64, and Linux x64 Remote SSH Extension Hosts.
- Package platform-specific VSIX files with verified native SQLite dependencies.
