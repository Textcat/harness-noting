#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const DEFAULT_SETTINGS = {
  rules: [],
  folderStructureRules: [],
  rootWhitelistRules: [],
};

function usage() {
  console.log(`Harness Noting CLI

Usage:
  node .obsidian/plugins/harness-noting/harness-noting-cli.js [--vault <path>] [--file <path>] [--json]

Options:
  --vault <path>  Vault root. Defaults to current directory.
  --file <path>   Check one markdown file instead of the whole vault.
  --json          Print JSON instead of a readable report.
  --help          Show this help.
`);
}

function parseArgs(argv) {
  const args = { vault: process.cwd(), file: "", json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--vault") {
      args.vault = argv[++i];
    } else if (arg === "--file") {
      args.file = argv[++i];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function lines(value) {
  return String(value || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function normalizePath(value) {
  return value.split(path.sep).join("/");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function patternMatches(pattern, value) {
  const trimmed = String(pattern || "").trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("regex:")) {
    try {
      return new RegExp(trimmed.slice(6)).test(value);
    } catch {
      return false;
    }
  }
  const regex = new RegExp(`^${trimmed.split("*").map(escapeRegExp).join(".*")}$`);
  return regex.test(value);
}

function normalizeTag(tag) {
  return String(tag || "").replace(/^#/, "").trim();
}

function parseFrontmatter(text) {
  if (!text.startsWith("---\n")) return {};
  const end = text.indexOf("\n---", 4);
  if (end === -1) return {};
  const yaml = text.slice(4, end).split("\n");
  const result = {};
  let currentKey = null;

  for (const rawLine of yaml) {
    const line = rawLine.replace(/\r$/, "");
    const listItem = line.match(/^\s*-\s+(.*)$/);
    if (listItem && currentKey) {
      if (!Array.isArray(result[currentKey])) result[currentKey] = [];
      result[currentKey].push(cleanScalar(listItem[1]));
      continue;
    }

    const pair = line.match(/^([^:#][^:]*):\s*(.*)$/);
    if (!pair) continue;
    currentKey = pair[1].trim();
    const value = pair[2].trim();
    if (value === "") {
      result[currentKey] = [];
    } else if (value.startsWith("[") && value.endsWith("]")) {
      result[currentKey] = value
        .slice(1, -1)
        .split(",")
        .map((item) => cleanScalar(item.trim()))
        .filter(Boolean);
    } else {
      result[currentKey] = cleanScalar(value);
    }
  }

  return result;
}

function cleanScalar(value) {
  return String(value).replace(/^["']|["']$/g, "");
}

function readFrontmatterTags(frontmatter) {
  const tags = frontmatter.tags;
  if (!tags) return [];
  if (Array.isArray(tags)) return tags.map(normalizeTag);
  return String(tags)
    .split(/[,\s]+/)
    .map(normalizeTag)
    .filter(Boolean);
}

function parsePropertyCondition(line) {
  const match = String(line).match(/^([^\s]+)\s+(exists|notExists|equals|notEquals|contains|regex)\s*(.*)$/);
  if (!match) return null;
  return {
    key: match[1],
    operator: match[2],
    value: match[3].trim(),
  };
}

function arrayContainsValue(value, expected) {
  if (Array.isArray(value)) return value.some((item) => String(item) === expected);
  return String(value ?? "") === expected;
}

function valueContains(value, expected) {
  if (Array.isArray(value)) return value.some((item) => String(item).includes(expected));
  return String(value ?? "").includes(expected);
}

function propertyConditionMatches(condition, frontmatter) {
  const value = frontmatter[condition.key];
  if (condition.operator === "exists") return value !== undefined && value !== null;
  if (condition.operator === "notExists") return value === undefined || value === null;
  if (condition.operator === "equals") return arrayContainsValue(value, condition.value);
  if (condition.operator === "notEquals") return !arrayContainsValue(value, condition.value);
  if (condition.operator === "contains") return valueContains(value, condition.value);
  if (condition.operator === "regex") {
    try {
      return new RegExp(condition.value).test(String(value ?? ""));
    } catch {
      return false;
    }
  }
  return false;
}

function loadSettings(vaultRoot) {
  const settingsPath = path.join(vaultRoot, ".obsidian/plugins/harness-noting/data.json");
  if (!fs.existsSync(settingsPath)) return DEFAULT_SETTINGS;
  const loaded = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  return {
    ...DEFAULT_SETTINGS,
    ...loaded,
    rules: loaded.rules || DEFAULT_SETTINGS.rules,
    folderStructureRules: loaded.folderStructureRules || DEFAULT_SETTINGS.folderStructureRules,
    rootWhitelistRules: loaded.rootWhitelistRules || DEFAULT_SETTINGS.rootWhitelistRules,
  };
}

function collectMarkdownFiles(vaultRoot, singleFile) {
  if (singleFile) {
    const fullPath = path.isAbsolute(singleFile) ? singleFile : path.join(vaultRoot, singleFile);
    return [fullPath];
  }

  const ignored = new Set([".git", ".obsidian", ".trash", "node_modules"]);
  const files = [];
  const stack = [vaultRoot];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push(fullPath);
      }
    }
  }
  return files.sort();
}

function ruleMatches(rule, fileInfo, frontmatter) {
  if (!rule.enabled) return false;

  const tests = [];
  const fileRules = lines(rule.files);
  const folderRules = lines(rule.folders);
  const excludedFileRules = lines(rule.excludedFiles);
  const excludedFolderRules = lines(rule.excludedFolders);
  const excludedTagRules = lines(rule.excludedTags).map(normalizeTag);
  const tagRules = lines(rule.tags).map(normalizeTag);
  const filenameRules = lines(rule.filenameIncludes);
  const propertyRules = lines(rule.propertyConditions).map(parsePropertyCondition).filter(Boolean);

  if (excludedFileRules.some((rulePath) => fileInfo.relativePath === rulePath || fileInfo.basename === rulePath.replace(/\.md$/, ""))) {
    return false;
  }
  if (
    excludedFolderRules.some((folder) => {
      const normalized = folder.replace(/\/$/, "");
      return fileInfo.relativePath.includes(`/${normalized}/`) || fileInfo.relativePath.startsWith(`${normalized}/`);
    })
  ) {
    return false;
  }
  if (excludedTagRules.length) {
    const tags = new Set(readFrontmatterTags(frontmatter));
    if (excludedTagRules.some((tag) => tags.has(tag))) return false;
  }

  if (fileRules.length) {
    tests.push(fileRules.some((rulePath) => fileInfo.relativePath === rulePath || fileInfo.basename === rulePath.replace(/\.md$/, "")));
  }
  if (folderRules.length) {
    tests.push(folderRules.some((folder) => fileInfo.relativePath.startsWith(folder.replace(/\/$/, "") + "/")));
  }
  if (tagRules.length) {
    const tags = new Set(readFrontmatterTags(frontmatter));
    tests.push(tagRules.every((tag) => tags.has(tag)));
  }
  if (filenameRules.length) {
    tests.push(filenameRules.every((part) => fileInfo.basename.includes(part)));
  }
  if (propertyRules.length) {
    tests.push(propertyRules.every((condition) => propertyConditionMatches(condition, frontmatter)));
  }

  if (!tests.length) return false;
  return rule.matchLogic === "any" ? tests.some(Boolean) : tests.every(Boolean);
}

function checkRule(rule, fileInfo, frontmatter, text) {
  const issues = [];

  for (const key of lines(rule.requiredProperties)) {
    const value = frontmatter[key];
    if (value === undefined || value === null || value === "") {
      issues.push({ rule: rule.name, message: `缺少属性：${key}` });
    }
  }

  for (const line of lines(rule.propertyChecks)) {
    const condition = parsePropertyCondition(line);
    if (!condition) {
      issues.push({ rule: rule.name, message: `属性检查写法无效：${line}` });
      continue;
    }
    if (!propertyConditionMatches(condition, frontmatter)) {
      issues.push({ rule: rule.name, message: `属性检查未通过：${line}` });
    }
  }

  let lastIndex = -1;
  for (const heading of lines(rule.requiredHeadings)) {
    const index = text.indexOf(heading);
    if (index === -1) {
      issues.push({ rule: rule.name, message: `缺少标题：${heading}` });
      continue;
    }
    if (rule.requireHeadingOrder && index < lastIndex) {
      issues.push({ rule: rule.name, message: `标题顺序不正确：${heading}` });
    }
    lastIndex = Math.max(lastIndex, index);
  }

  if (rule.filenameRegex) {
    try {
      const regex = new RegExp(rule.filenameRegex);
      if (!regex.test(fileInfo.basename)) {
        issues.push({ rule: rule.name, message: `文件名不符合规则：${rule.filenameRegex}` });
      }
    } catch {
      issues.push({ rule: rule.name, message: `文件名正则无效：${rule.filenameRegex}` });
    }
  }

  return issues;
}

function checkFile(vaultRoot, fullPath, rules) {
  const text = fs.readFileSync(fullPath, "utf8");
  const relativePath = normalizePath(path.relative(vaultRoot, fullPath));
  const basename = path.basename(fullPath, ".md");
  const fileInfo = { fullPath, relativePath, basename };
  const frontmatter = parseFrontmatter(text);
  const matchedRules = rules.filter((rule) => ruleMatches(rule, fileInfo, frontmatter));
  const issues = matchedRules.flatMap((rule) => checkRule(rule, fileInfo, frontmatter, text));

  return {
    path: relativePath,
    rules: matchedRules.map((rule) => rule.name),
    issues,
  };
}

function folderStructureRuleMatches(rule, folderName) {
  if (rule.includeFolderRegex) {
    try {
      if (!new RegExp(rule.includeFolderRegex).test(folderName)) return false;
    } catch {
      return true;
    }
  }
  if (rule.excludeFolderRegex) {
    try {
      if (new RegExp(rule.excludeFolderRegex).test(folderName)) return false;
    } catch {
      return true;
    }
  }
  return true;
}

function checkFolderStructureRules(vaultRoot, rules) {
  const results = [];
  for (const rule of rules || []) {
    if (!rule.enabled || !rule.rootFolder) continue;
    const rootFolder = normalizePath(rule.rootFolder).replace(/\/+$/, "");
    const rootPath = path.join(vaultRoot, rootFolder);
    if (!fs.existsSync(rootPath) || !fs.statSync(rootPath).isDirectory()) {
      results.push({
        path: rootFolder,
        rules: [rule.name],
        issues: [{ rule: rule.name, message: "根文件夹不存在" }],
      });
      continue;
    }

    const entries = fs.readdirSync(rootPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!folderStructureRuleMatches(rule, entry.name)) continue;
      const folderPath = path.join(rootPath, entry.name);
      const relativePath = normalizePath(path.relative(vaultRoot, folderPath));
      const issues = checkOneFolderStructure(rule, folderPath, entry.name);
      results.push({
        path: relativePath,
        rules: [rule.name],
        issues,
      });
    }
  }
  return results;
}

function checkRootWhitelistRules(vaultRoot, rules) {
  const results = [];
  for (const rule of rules || []) {
    if (!rule.enabled) continue;
    const allowedEntries = new Set(lines(rule.allowedEntries));
    const ignoredEntries = new Set(lines(rule.ignoredEntries));
    const entries = fs.readdirSync(vaultRoot, { withFileTypes: true }).map((entry) => entry.name);
    const issues = [];

    for (const entry of entries) {
      if (rule.ignoreDotEntries && entry.startsWith(".")) continue;
      if (ignoredEntries.has(entry)) continue;
      if (!allowedEntries.has(entry)) {
        issues.push({ rule: rule.name, message: `根目录不在白名单：${entry}` });
      }
    }

    results.push({
      path: "/",
      rules: [rule.name],
      issues,
    });
  }
  return results;
}

function checkOneFolderStructure(rule, folderPath, folderName) {
  const issues = [];
  const entries = fs.readdirSync(folderPath, { withFileTypes: true });
  const directFiles = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  const directFolders = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);

  for (const requiredFolder of lines(rule.requiredSubfolders)) {
    if (!directFolders.includes(requiredFolder)) {
      issues.push({ rule: rule.name, message: `缺少子文件夹：${requiredFolder}` });
    }
  }

  for (const requiredFile of lines(rule.requiredFiles)) {
    const pattern = requiredFile.replaceAll("{{folderName}}", folderName);
    if (!directFiles.some((file) => patternMatches(pattern, file))) {
      issues.push({ rule: rule.name, message: `缺少文件：${requiredFile}` });
    }
  }

  return issues;
}

function printReadable(results) {
  const checked = results.filter((result) => result.rules.length).length;
  const failed = results.filter((result) => result.issues.length).length;
  console.log(`Harness Noting: checked ${checked} matched item(s), ${failed} failed.`);

  for (const result of results.filter((item) => item.issues.length)) {
    console.log(`\nFAIL ${result.path}`);
    console.log(`Rules: ${result.rules.join(", ")}`);
    for (const issue of result.issues) {
      console.log(`- [${issue.rule}] ${issue.message}`);
    }
  }

  if (!failed) {
    console.log("All matched notes passed.");
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }

  const vaultRoot = path.resolve(args.vault);
  const settings = loadSettings(vaultRoot);
  const files = collectMarkdownFiles(vaultRoot, args.file);
  const results = files
    .map((file) => checkFile(vaultRoot, file, settings.rules || []))
    .filter((result) => result.rules.length || result.issues.length);
  if (!args.file) {
    results.push(...checkFolderStructureRules(vaultRoot, settings.folderStructureRules || []));
    results.push(...checkRootWhitelistRules(vaultRoot, settings.rootWhitelistRules || []));
  }

  if (args.json) {
    console.log(JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2));
  } else {
    printReadable(results);
  }

  const failed = results.some((result) => result.issues.length);
  process.exitCode = failed ? 1 : 0;
}

try {
  main();
} catch (error) {
  console.error(`Harness Noting failed: ${error.message}`);
  process.exitCode = 2;
}
