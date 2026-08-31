# Marketplace Publishing

This guide is for the repository owner. Complete it only when the repository branch and both native CI jobs are green. Never paste a Marketplace PAT into chat, an issue, a pull request, a terminal command, documentation, or logs.

## 1. Create the Publisher

1. Sign in with the Microsoft account that will own the extension at <https://marketplace.visualstudio.com/manage>.
2. Choose **Create publisher**.
3. Set the Publisher ID to `Li-changwu`. This value must match `package.json`; changing it creates a different extension identity.
4. Enter the intended display name and a monitored contact address, accept the Marketplace agreement, and finish creation.
5. Confirm that the management page shows Publisher `Li-changwu`. If the ID is unavailable, stop: do not choose a substitute without first changing and reviewing the permanent extension identity in the repository.

The Marketplace identity for this repository is `Li-changwu.codex-provider-switcher`.

## 2. Create a Least-Privilege PAT

1. Open Azure DevOps user settings and select **Personal access tokens (PAT)**.
2. Choose **New Token** and use a descriptive release-only name.
3. Select **All accessible organizations**. The Marketplace publisher API requires this organization choice even though the extension is published through the Marketplace portal.
4. Choose a short expiration, such as 7 or 30 days.
5. Under scopes, select only **Marketplace: Manage**. Do not grant Code, Build, Release, Packaging, or full-access scopes.
6. Create the token and keep the one-time value visible only long enough to enter it directly into the GitHub secret form in the next section.

Do not test the PAT by placing it on a command line. For any authorized local Marketplace command, first restore normal TLS validation in the current PowerShell process:

```powershell
Remove-Item Env:NODE_TLS_REJECT_UNAUTHORIZED -ErrorAction SilentlyContinue
```

The repository workflow does not require a local Marketplace command.

## 3. Protect the GitHub Environment

1. In the GitHub repository, open **Settings**, then **Environments**.
2. Create a GitHub Environment named `marketplace`.
3. Add a required reviewer when the repository plan supports it. This keeps the publish job waiting after both packages have passed validation.
4. Under **Environment secrets**, choose **Add secret**.
5. Set the Environment Secret name to `VSCE_PAT` and enter the PAT value directly in GitHub's secret-value field.
6. Save the secret. Confirm only that the secret name is listed; GitHub will not show its value again.

Use an Environment Secret, not a repository or organization secret. Only the final publish step references it.

## 4. Run the First Publication

1. Confirm that the existing tag is `v0.1.1` and that `package.json` contains version `0.1.1`.
2. Open the repository's **Actions** tab and select **Marketplace Publish**.
3. Choose **Run workflow**, enter `v0.1.1` in the `tag` field, and start the run.
4. Wait for both `win32-x64` and `linux-x64` package jobs to pass.
5. Review the pending `marketplace` Environment deployment and approve it only after the tag and package jobs are correct.
6. Wait for artifact validation and both Marketplace uploads to finish. A missing secret, invalid Publisher, tag mismatch, package mismatch, or Marketplace rejection must leave the run failed.

The workflow uses `--skip-duplicate` so rerunning the same successful version is idempotent. It does not create a tag or GitHub Release.

## 5. Verify and Rotate

1. Open the public Marketplace item and verify the name, Publisher, icon, README, changelog, repository, and issue links.
2. Confirm that both Windows x64 and Linux x64 target variants are present.
3. Install from the Marketplace on native Windows x64 and in a Remote SSH window backed by glibc Linux x64. Confirm that VS Code selects the compatible package and the extension activates on that Extension Host.
4. After the first publication, either revoke the short-lived PAT or keep its expiration short. For a later release, create a replacement with the same single scope and rotate the `VSCE_PAT` Environment Secret.
5. Revoke a PAT immediately if its value may have entered a command history, log, message, issue, or file.

PAT rotation or revocation does not remove a published extension. It only prevents later publication until a valid Environment Secret is stored.
