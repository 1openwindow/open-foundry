# Artifact publishing

`pi-foundry` can publish generated files to an Azure Storage Static Website so users can open HTML reports, MP3 narration, MP4 videos, images, and ZIP bundles from a normal HTTPS URL.

## Deployment shape

Configure an Azure Storage Static Website endpoint for your deployment:

```text
https://<storage-account>.<zone>.web.core.windows.net/
```

Published artifact URLs use this prefix:

```text
https://<storage-account>.<zone>.web.core.windows.net/<ARTIFACT_BLOB_PREFIX>/<yyyy-mm-dd>/<request-id>/...
```

Example:

```text
https://<storage-account>.<zone>.web.core.windows.net/my-pi-agent/2026-05-28/<request-id>/index.html
```

## Security model

The storage account is configured without storage account key access:

```text
allowSharedKeyAccess = false
```

The storage account also keeps blob public container access disabled:

```text
allowBlobPublicAccess = false
```

Uploads use Microsoft Entra ID / Managed Identity through `DefaultAzureCredential`. No storage account keys or shared-key connection strings are used.

The static website endpoint is still anonymously readable. Treat published artifact URLs as public-by-link. Use random request-id paths, do not publish sensitive material, and configure lifecycle cleanup for generated artifacts.

If artifacts need authenticated access, replace this static website approach with a private Blob container plus an authenticated artifact gateway.

## Runtime configuration

`pi-foundry` reads these environment variables:

| Variable | Purpose |
|---|---|
| `ARTIFACT_PUBLISH_MODE` | Set to `static-web` to enable static website publishing |
| `ARTIFACT_STORAGE_ACCOUNT` | Storage account name |
| `ARTIFACT_STATIC_WEB_ENDPOINT` | Static website endpoint, no trailing slash required |
| `ARTIFACT_STATIC_WEB_CONTAINER` | Static website container, normally `$web` |
| `ARTIFACT_BLOB_PREFIX` | Blob prefix under `$web`, normally `pi-foundry` |
| `ARTIFACT_MAX_PUBLISH_BYTES` | Maximum bytes to publish per invocation, default 100 MiB |
| `ARTIFACT_PROMPT_HINTS` | Set to `0` or `false` to disable prompt hints |

Example values:

```text
ARTIFACT_PUBLISH_MODE=static-web
ARTIFACT_STORAGE_ACCOUNT=<storage-account>
ARTIFACT_STATIC_WEB_ENDPOINT=https://<storage-account>.<zone>.web.core.windows.net
ARTIFACT_STATIC_WEB_CONTAINER=$web
ARTIFACT_BLOB_PREFIX=<agent-name>
```

## How publishing works

For each invocation, `pi-foundry` creates an artifact directory:

```text
/files/<yyyy-mm-dd>/<request-id>/
```

When a prompt looks like it may generate downloadable files, the runtime adds a short instruction asking Pi to write generated files into that directory.

After Pi finishes, the runtime:

1. scans the artifact directory,
2. optionally reads `artifact-manifest.json`,
3. uploads files to `$web/<ARTIFACT_BLOB_PREFIX>/<yyyy-mm-dd>/<request-id>/`,
4. appends markdown links to the assistant output, and
5. returns an `artifacts` array in JSON responses and SSE `done` events.

Example response snippet:

```json
{
  "output": "Done.\n\nArtifacts:\n\n- [index.html](https://.../index.html)",
  "artifacts": [
    {
      "name": "index.html",
      "path": "index.html",
      "contentType": "text/html; charset=utf-8",
      "size": 83,
      "url": "https://<storage-account>.<zone>.web.core.windows.net/<agent-name>/2026-05-28/<request-id>/index.html"
    }
  ]
}
```

## Recommended prompt pattern

Ask the agent to create downloadable artifacts, but do not hard-code the request id:

```text
Create a downloadable static HTML artifact named index.html with an embedded audio player.
Save it under the artifact directory you were instructed to use.
Reply with a concise summary.
```

For richer metadata, ask the agent to write `artifact-manifest.json` next to the generated files:

```json
{
  "artifacts": [
    {
      "path": "index.html",
      "name": "Report",
      "description": "Main HTML report",
      "contentType": "text/html; charset=utf-8"
    },
    {
      "path": "narration.mp3",
      "name": "Narration",
      "contentType": "audio/mpeg"
    }
  ]
}
```

When a manifest exists, only manifest-listed files are published.

## RBAC

Grant the hosted agent identities access to upload to the storage account or `$web` container:

```text
Storage Blob Data Contributor
```

For a newly deployed Hosted Agent, run:

```bash
npm run grant:artifact-rbac -- <agent-name> <storage-account>
```

The script grants this role to the deployed agent instance and blueprint identities. The local deployment user also needs storage data-plane access if you want to smoke test publishing locally.

## Smoke test

Remote invocation:

```bash
azd ai agent invoke <agent-name> \
  --protocol invocations \
  --version <version> \
  --new-session \
  --timeout 600 \
  'Create a downloadable static HTML artifact named index.html. The page should contain exactly: <h1>Foundry artifact ok</h1>. Save it under the artifact directory you were instructed to use. Reply concisely.'
```

Expected response includes an `Artifacts:` markdown link and an `artifacts` JSON array. The returned URL should respond with HTTP 200.
