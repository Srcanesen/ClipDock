# Security policy

## Supported versions

Security fixes target ClipDock **0.1.x**.
Use the latest available patch in that series when reporting an issue.

## Report a vulnerability

Report vulnerabilities privately through **Report a vulnerability** on the
repository's [Security tab](https://github.com/Srcanesen/ClipDock/security).
Do not open public issues for vulnerabilities or post exploit details there.

Include the affected version, operating system, reproduction steps and impact.
Use a minimal example when possible. Remove API keys, credentials and private
media or URLs from the report.

You can expect a first response within **7 days**. Further updates will follow
as the report is investigated and a fix is prepared.

## Scope

Security-sensitive areas include:

- File handling, path validation and deletion of downloaded media.
- Credential storage, including Pexels API keys.
- Process spawning with untrusted URLs or filenames.
- The plugin install script and the files it copies into Resolve.

Third-party tools keep their own security policies. If a report involves one,
explain how it is reached through ClipDock so the integration can be assessed.
