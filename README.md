# Harness Noting

Harness Noting is an Obsidian plugin for checking note structure against scoped rules.

It is designed for AI-assisted note maintenance: rules can be edited in Obsidian, and the same rules can be checked from the command line so an AI agent can read failures and fix notes before finishing.

## Features

- Match notes by exact file, folder, tag, filename text, and frontmatter property conditions
- Combine scope conditions with `all` or `any`
- Exclude files, folders, or tags from a rule
- Check required frontmatter properties
- Check property values, including `equals`, `contains`, and `regex`
- Check required headings and heading order
- Check filename patterns with regular expressions
- Check direct child folder structures, including required subfolders and file patterns
- Check vault root entries against a configurable whitelist
- Run all checks from an Obsidian ribbon button
- Copy a readable check conclusion from the results modal
- Show Obsidian notices after file changes
- Run checks from the command line with failure exit codes

## CLI

Run from the vault root:

```bash
node .obsidian/plugins/harness-noting/harness-noting-cli.js
```

Check a single note:

```bash
node .obsidian/plugins/harness-noting/harness-noting-cli.js --file "path/to/note.md"
```

Print JSON:

```bash
node .obsidian/plugins/harness-noting/harness-noting-cli.js --json
```

Exit codes:

- `0`: all matched notes passed
- `1`: at least one matched note failed
- `2`: the checker itself failed

## Rule Syntax

Property conditions and property checks use one rule per line:

```txt
type equals project
tags contains planning
tags regex ^project/[A-Za-z0-9-]+$
updated exists
```

Supported operators:

- `exists`
- `notExists`
- `equals`
- `notEquals`
- `contains`
- `regex`

## Folder Structure Rules

Folder structure rules check every direct child folder under a configured root folder.

Example:

```json
{
  "name": "Project folder structure",
  "rootFolder": "Projects",
  "requiredSubfolders": "Assets",
  "requiredFiles": "Overview.md\n* Plan.md"
}
```

Required file patterns support:

- `*` wildcards
- `regex:` regular expressions
- `{{folderName}}` as the current folder name

## Root Whitelist Rules

Root whitelist rules check only direct children of the vault root.

Example:

```json
{
  "name": "Vault root whitelist",
  "allowedEntries": "Inbox\nProjects\nResources\nArchive\nHome.md",
  "ignoredEntries": ".git\n.obsidian\n.trash\n.DS_Store",
  "ignoreDotEntries": true
}
```

## Installation

Install from Obsidian community plugins after approval, or install manually:

Copy this folder to:

```txt
<vault>/.obsidian/plugins/harness-noting
```

Then enable `Harness Noting` in Obsidian community plugins.

## Release

Create a GitHub release with the same tag as `manifest.json`'s `version`.
Attach these files:

- `main.js`
- `manifest.json`
- `styles.css`
