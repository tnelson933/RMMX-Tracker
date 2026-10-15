---
name: GitHub authentication diagnosis
description: Avoid repeating misleading reconnection guidance when Git writes fail.
---

Do not treat successful public repository reads or a healthy integration status as proof of Git write authentication.

**Why:** Reconnecting through Integrations produced a new source-control connection, yet CLI pushes still rejected authentication. A read with token environment variables unset succeeded while a push using the same environment failed; that does not establish that the saved token caused the problem.

**How to apply:** Verify actual write access before claiming authentication is repaired. Do not repeatedly send the user to “Git Providers” or “Connected Services”: their settings UI did not contain these menus, and Advanced → Source control settings only contained workspace policies. Use their visible UI and current documentation, and distinguish connection status from Git CLI access.

An explicitly selected fine-grained personal access token supplied through Replit Secrets successfully authenticated a push when the managed Git connection did not.

**Why:** Repeated reconnections did not repair CLI writes. A command-scoped credential helper using the dedicated secret did succeed; this does not prove the original authentication failure's root cause.

**How to apply:** If authorized, use a repository-scoped token with Contents and Workflows write permissions, sourced from the environment only inside the Git credential helper. Clear inherited credential helpers for that command, disable interactive prompts, and never put token values in URLs, logs, files or persistent Git configuration. Verify the remote branch with ls-remote: a workspace restriction can prevent the local remote-tracking ref update even after GitHub has accepted the push.
