const {
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
} = require("obsidian");

const DEFAULT_SETTINGS = {
  checkOnModify: true,
  showNoticeOnViolation: true,
  rules: [],
  folderStructureRules: [],
  rootWhitelistRules: [],
};

function lines(value) {
  return String(value || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function normalizeTag(tag) {
  return String(tag || "").replace(/^#/, "").trim();
}

function arrayContainsValue(value, expected) {
  if (Array.isArray(value)) {
    return value.some((item) => String(item) === expected);
  }
  return String(value ?? "") === expected;
}

function valueContains(value, expected) {
  if (Array.isArray(value)) {
    return value.some((item) => String(item).includes(expected));
  }
  return String(value ?? "").includes(expected);
}

function parsePropertyCondition(line) {
  const match = String(line).match(/^([^\s]+)\s+(exists|notExists|equals|notEquals|contains|regex)\s*(.*)$/);
  if (!match) {
    return null;
  }
  return {
    key: match[1],
    operator: match[2],
    value: match[3].trim(),
  };
}

function readFrontmatterTags(frontmatter) {
  const tags = frontmatter?.tags;
  if (!tags) return [];
  if (Array.isArray(tags)) return tags.map(normalizeTag);
  return String(tags)
    .split(/[,\s]+/)
    .map(normalizeTag)
    .filter(Boolean);
}

function normalizePath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/\/+$/, "");
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
    } catch (error) {
      return false;
    }
  }
  const regex = new RegExp(`^${trimmed.split("*").map(escapeRegExp).join(".*")}$`);
  return regex.test(value);
}

class HarnessNotingPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign(cloneRule(DEFAULT_SETTINGS), await this.loadData());
    this.settings.rules = this.settings.rules || [];
    this.settings.folderStructureRules = this.settings.folderStructureRules || [];
    this.settings.rootWhitelistRules = this.settings.rootWhitelistRules || [];
    this.modifyTimers = new Map();
    this.statusBar = this.addStatusBarItem();
    this.statusBar.setText("Harness Noting");

    this.addSettingTab(new HarnessNotingSettingTab(this.app, this));

    this.addRibbonIcon("shield-check", "运行 Harness Noting 检查", async () => {
      await this.openAllResults();
    });

    this.addCommand({
      id: "check-current-file",
      name: "Check current file",
      callback: async () => {
        const file = this.app.workspace.getActiveFile();
        if (!file) {
          new Notice("没有打开的笔记");
          return;
        }
        const result = await this.checkFile(file);
        this.showFileResult(result);
      },
    });

    this.addCommand({
      id: "check-all-rules",
      name: "Check all schema rules",
      callback: async () => {
        await this.openAllResults();
      },
    });

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (!this.settings.checkOnModify || !(file instanceof TFile) || file.extension !== "md") {
          return;
        }
        window.clearTimeout(this.modifyTimers.get(file.path));
        this.modifyTimers.set(
          file.path,
          window.setTimeout(async () => {
            const result = await this.checkFile(file);
            const issueCount = result.issues.length;
            this.statusBar.setText(issueCount ? `Harness Noting: ${issueCount}` : "Harness Noting");
            const active = this.app.workspace.getActiveFile();
            if (
              issueCount &&
              this.settings.showNoticeOnViolation &&
              active &&
              active.path === file.path
            ) {
              new Notice(`Harness Noting: ${file.basename} 有 ${issueCount} 个格式问题`, 5000);
            }
          }, 700)
        );
      })
    );
  }

  onunload() {
    for (const timer of this.modifyTimers.values()) {
      window.clearTimeout(timer);
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async checkAll() {
    const files = this.app.vault.getMarkdownFiles();
    const results = [];
    for (const file of files) {
      const result = await this.checkFile(file);
      if (result.rules.length || result.issues.length) {
        results.push(result);
      }
    }
    results.push(...(await this.checkFolderStructureRules()));
    results.push(...(await this.checkRootWhitelistRules()));
    return results;
  }

  async openAllResults() {
    const results = await this.checkAll();
    new ResultsModal(this.app, results).open();
  }

  async checkFile(file) {
    const cache = this.app.metadataCache.getFileCache(file) || {};
    const frontmatter = cache.frontmatter || {};
    const text = await this.app.vault.cachedRead(file);
    const matchedRules = this.settings.rules.filter((rule) => this.ruleMatches(rule, file, frontmatter, cache));
    const issues = [];

    for (const rule of matchedRules) {
      issues.push(...this.checkRule(rule, file, frontmatter, text));
    }

    return {
      file,
      rules: matchedRules.map((rule) => rule.name),
      issues,
    };
  }

  ruleMatches(rule, file, frontmatter, cache) {
    if (!rule.enabled) return false;

    const tests = [];
    const fileRules = lines(rule.files);
    const folderRules = lines(rule.folders);
    const excludedFileRules = lines(rule.excludedFiles);
    const excludedFolderRules = lines(rule.excludedFolders);
    const excludedTagRules = lines(rule.excludedTags).map(normalizeTag);
    const tagRules = lines(rule.tags).map(normalizeTag);
    const filenameRules = lines(rule.filenameIncludes);
    const propertyRules = lines(rule.propertyConditions)
      .map(parsePropertyCondition)
      .filter(Boolean);

    if (excludedFileRules.some((path) => file.path === path || file.basename === path.replace(/\.md$/, ""))) {
      return false;
    }
    if (
      excludedFolderRules.some((folder) => {
        const normalized = folder.replace(/\/$/, "");
        return file.path.includes(`/${normalized}/`) || file.path.startsWith(`${normalized}/`);
      })
    ) {
      return false;
    }
    if (excludedTagRules.length) {
      const cacheTags = (cache.tags || []).map((tag) => normalizeTag(tag.tag));
      const frontmatterTags = readFrontmatterTags(frontmatter);
      const allTags = new Set([...cacheTags, ...frontmatterTags]);
      if (excludedTagRules.some((tag) => allTags.has(tag))) return false;
    }

    if (fileRules.length) {
      tests.push(fileRules.some((path) => file.path === path || file.basename === path.replace(/\.md$/, "")));
    }
    if (folderRules.length) {
      tests.push(folderRules.some((folder) => file.path.startsWith(folder.replace(/\/$/, "") + "/")));
    }
    if (tagRules.length) {
      const cacheTags = (cache.tags || []).map((tag) => normalizeTag(tag.tag));
      const frontmatterTags = readFrontmatterTags(frontmatter);
      const allTags = new Set([...cacheTags, ...frontmatterTags]);
      tests.push(tagRules.every((tag) => allTags.has(tag)));
    }
    if (filenameRules.length) {
      tests.push(filenameRules.every((part) => file.basename.includes(part)));
    }
    if (propertyRules.length) {
      tests.push(propertyRules.every((condition) => this.propertyConditionMatches(condition, frontmatter)));
    }

    if (!tests.length) return false;
    return rule.matchLogic === "any" ? tests.some(Boolean) : tests.every(Boolean);
  }

  propertyConditionMatches(condition, frontmatter) {
    const value = frontmatter[condition.key];
    if (condition.operator === "exists") return value !== undefined && value !== null;
    if (condition.operator === "notExists") return value === undefined || value === null;
    if (condition.operator === "equals") return arrayContainsValue(value, condition.value);
    if (condition.operator === "notEquals") return !arrayContainsValue(value, condition.value);
    if (condition.operator === "contains") return valueContains(value, condition.value);
    if (condition.operator === "regex") {
      try {
        return new RegExp(condition.value).test(String(value ?? ""));
      } catch (error) {
        return false;
      }
    }
    return false;
  }

  checkRule(rule, file, frontmatter, text) {
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
      if (!this.propertyConditionMatches(condition, frontmatter)) {
        issues.push({ rule: rule.name, message: `属性检查未通过：${line}` });
      }
    }

    const headings = lines(rule.requiredHeadings);
    let lastIndex = -1;
    for (const heading of headings) {
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
        if (!regex.test(file.basename)) {
          issues.push({ rule: rule.name, message: `文件名不符合规则：${rule.filenameRegex}` });
        }
      } catch (error) {
        issues.push({ rule: rule.name, message: `文件名正则无效：${rule.filenameRegex}` });
      }
    }

    return issues;
  }

  showFileResult(result) {
    if (!result.rules.length) {
      new Notice("当前笔记没有匹配任何 Harness Noting 规则");
      return;
    }
    new ResultsModal(this.app, [result]).open();
  }

  async checkFolderStructureRules() {
    const results = [];
    for (const rule of this.settings.folderStructureRules || []) {
      if (!rule.enabled || !rule.rootFolder) continue;
      const rootFolder = normalizePath(rule.rootFolder);
      const exists = await this.app.vault.adapter.exists(rootFolder);
      if (!exists) {
        results.push({
          path: rootFolder,
          rules: [rule.name],
          issues: [{ rule: rule.name, message: "根文件夹不存在" }],
        });
        continue;
      }

      const listing = await this.app.vault.adapter.list(rootFolder);
      for (const folder of listing.folders || []) {
        const folderName = folder.split("/").pop();
        if (!this.folderStructureRuleMatches(rule, folderName)) continue;
        const issues = await this.checkOneFolderStructure(rule, normalizePath(folder), folderName);
        results.push({
          path: normalizePath(folder),
          rules: [rule.name],
          issues,
        });
      }
    }
    return results;
  }

  folderStructureRuleMatches(rule, folderName) {
    if (rule.includeFolderRegex) {
      try {
        if (!new RegExp(rule.includeFolderRegex).test(folderName)) return false;
      } catch (error) {
        return true;
      }
    }
    if (rule.excludeFolderRegex) {
      try {
        if (new RegExp(rule.excludeFolderRegex).test(folderName)) return false;
      } catch (error) {
        return true;
      }
    }
    return true;
  }

  async checkOneFolderStructure(rule, folderPath, folderName) {
    const issues = [];
    const listing = await this.app.vault.adapter.list(folderPath);
    const directFiles = (listing.files || []).map((file) => file.split("/").pop());
    const directFolders = (listing.folders || []).map((folder) => folder.split("/").pop());

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

  async checkRootWhitelistRules() {
    const results = [];
    for (const rule of this.settings.rootWhitelistRules || []) {
      if (!rule.enabled) continue;
      const listing = await this.app.vault.adapter.list("");
      const allowedEntries = new Set(lines(rule.allowedEntries));
      const ignoredEntries = new Set(lines(rule.ignoredEntries));
      const entries = [
        ...(listing.folders || []).map((entry) => entry.split("/").pop()),
        ...(listing.files || []).map((entry) => entry.split("/").pop()),
      ].filter(Boolean);
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
}

class HarnessNotingSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Harness Noting" });
    containerEl.createEl("p", {
      text: "为特定笔记、文件夹、标签和属性组合设置格式规则，并检查必需属性、标题和文件名模式。",
    });

    new Setting(containerEl)
      .setName("保存后自动检查")
      .setDesc("Obsidian 没有真正的保存前拦截。开启后，文件变化后会检查并提示问题。")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.checkOnModify).onChange(async (value) => {
          this.plugin.settings.checkOnModify = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("发现问题时弹出提示")
      .setDesc("只对当前打开的文件弹出提示，避免批量同步时打扰。")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showNoticeOnViolation).onChange(async (value) => {
          this.plugin.settings.showNoticeOnViolation = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("检查全部规则")
      .setDesc("扫描整个库，列出所有匹配规则的笔记和问题。")
      .addButton((button) =>
        button.setButtonText("运行检查").onClick(async () => {
          const results = await this.plugin.checkAll();
          new ResultsModal(this.app, results).open();
        })
      )
      .addButton((button) =>
        button.setButtonText("新增规则").setCta().onClick(() => {
          const rule = createEmptyRule();
          new RuleModal(this.app, this.plugin, rule, async (savedRule) => {
            this.plugin.settings.rules.push(savedRule);
            await this.plugin.saveSettings();
            this.display();
          }).open();
        })
      );

    containerEl.createEl("h3", { text: "笔记格式规则" });
    for (const rule of this.plugin.settings.rules) {
      this.renderRule(containerEl, rule);
    }

    new Setting(containerEl)
      .setName("文件夹结构规则")
      .setDesc("检查某个根目录下，每个直接子文件夹是否包含指定子文件夹和文件。")
      .addButton((button) =>
        button.setButtonText("新增文件夹规则").setCta().onClick(() => {
          const rule = createEmptyFolderStructureRule();
          new FolderStructureRuleModal(this.app, this.plugin, rule, async (savedRule) => {
            this.plugin.settings.folderStructureRules.push(savedRule);
            await this.plugin.saveSettings();
            this.display();
          }).open();
        })
      );

    for (const rule of this.plugin.settings.folderStructureRules || []) {
      this.renderFolderStructureRule(containerEl, rule);
    }

    new Setting(containerEl)
      .setName("一级目录白名单")
      .setDesc("检查库根目录的直接子项，只允许白名单中的文件和文件夹。")
      .addButton((button) =>
        button.setButtonText("新增白名单规则").setCta().onClick(() => {
          const rule = createEmptyRootWhitelistRule();
          new RootWhitelistRuleModal(this.app, this.plugin, rule, async (savedRule) => {
            this.plugin.settings.rootWhitelistRules.push(savedRule);
            await this.plugin.saveSettings();
            this.display();
          }).open();
        })
      );

    for (const rule of this.plugin.settings.rootWhitelistRules || []) {
      this.renderRootWhitelistRule(containerEl, rule);
    }
  }

  renderRule(containerEl, rule) {
    const wrapper = containerEl.createDiv({ cls: "harness-noting-rule" });
    wrapper.createDiv({ cls: "harness-noting-rule-title", text: rule.name });
    wrapper.createDiv({
      cls: "harness-noting-rule-meta",
      text: `${rule.enabled ? "启用" : "停用"} · ${rule.matchLogic === "any" ? "任一条件匹配" : "全部条件匹配"}`,
    });

    new Setting(wrapper)
      .setName("规则操作")
      .addToggle((toggle) =>
        toggle.setValue(rule.enabled).onChange(async (value) => {
          rule.enabled = value;
          await this.plugin.saveSettings();
          this.display();
        })
      )
      .addButton((button) =>
        button.setButtonText("编辑").onClick(() => {
          new RuleModal(this.app, this.plugin, cloneRule(rule), async (savedRule) => {
            Object.assign(rule, savedRule);
            await this.plugin.saveSettings();
            this.display();
          }).open();
        })
      )
      .addButton((button) =>
        button.setButtonText("复制").onClick(async () => {
          const copy = cloneRule(rule);
          copy.id = `${copy.id}-copy-${Date.now()}`;
          copy.name = `${copy.name} 副本`;
          this.plugin.settings.rules.push(copy);
          await this.plugin.saveSettings();
          this.display();
        })
      )
      .addButton((button) =>
        button.setButtonText("删除").onClick(async () => {
          this.plugin.settings.rules = this.plugin.settings.rules.filter((item) => item.id !== rule.id);
          await this.plugin.saveSettings();
          this.display();
        })
      );
  }

  renderFolderStructureRule(containerEl, rule) {
    const wrapper = containerEl.createDiv({ cls: "harness-noting-rule" });
    wrapper.createDiv({ cls: "harness-noting-rule-title", text: rule.name });
    wrapper.createDiv({
      cls: "harness-noting-rule-meta",
      text: `${rule.enabled ? "启用" : "停用"} · ${rule.rootFolder || "未设置根目录"}`,
    });

    new Setting(wrapper)
      .setName("规则操作")
      .addToggle((toggle) =>
        toggle.setValue(rule.enabled).onChange(async (value) => {
          rule.enabled = value;
          await this.plugin.saveSettings();
          this.display();
        })
      )
      .addButton((button) =>
        button.setButtonText("编辑").onClick(() => {
          new FolderStructureRuleModal(this.app, this.plugin, cloneRule(rule), async (savedRule) => {
            Object.assign(rule, savedRule);
            await this.plugin.saveSettings();
            this.display();
          }).open();
        })
      )
      .addButton((button) =>
        button.setButtonText("复制").onClick(async () => {
          const copy = cloneRule(rule);
          copy.id = `${copy.id}-copy-${Date.now()}`;
          copy.name = `${copy.name} 副本`;
          this.plugin.settings.folderStructureRules.push(copy);
          await this.plugin.saveSettings();
          this.display();
        })
      )
      .addButton((button) =>
        button.setButtonText("删除").onClick(async () => {
          this.plugin.settings.folderStructureRules = this.plugin.settings.folderStructureRules.filter((item) => item.id !== rule.id);
          await this.plugin.saveSettings();
          this.display();
        })
      );
  }

  renderRootWhitelistRule(containerEl, rule) {
    const wrapper = containerEl.createDiv({ cls: "harness-noting-rule" });
    wrapper.createDiv({ cls: "harness-noting-rule-title", text: rule.name });
    wrapper.createDiv({
      cls: "harness-noting-rule-meta",
      text: `${rule.enabled ? "启用" : "停用"} · ${lines(rule.allowedEntries).length} 个允许项`,
    });

    new Setting(wrapper)
      .setName("规则操作")
      .addToggle((toggle) =>
        toggle.setValue(rule.enabled).onChange(async (value) => {
          rule.enabled = value;
          await this.plugin.saveSettings();
          this.display();
        })
      )
      .addButton((button) =>
        button.setButtonText("编辑").onClick(() => {
          new RootWhitelistRuleModal(this.app, this.plugin, cloneRule(rule), async (savedRule) => {
            Object.assign(rule, savedRule);
            await this.plugin.saveSettings();
            this.display();
          }).open();
        })
      )
      .addButton((button) =>
        button.setButtonText("复制").onClick(async () => {
          const copy = cloneRule(rule);
          copy.id = `${copy.id}-copy-${Date.now()}`;
          copy.name = `${copy.name} 副本`;
          this.plugin.settings.rootWhitelistRules.push(copy);
          await this.plugin.saveSettings();
          this.display();
        })
      )
      .addButton((button) =>
        button.setButtonText("删除").onClick(async () => {
          this.plugin.settings.rootWhitelistRules = this.plugin.settings.rootWhitelistRules.filter((item) => item.id !== rule.id);
          await this.plugin.saveSettings();
          this.display();
        })
      );
  }
}

class RuleModal extends Modal {
  constructor(app, plugin, rule, onSave) {
    super(app);
    this.plugin = plugin;
    this.rule = rule;
    this.onSave = onSave;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("harness-noting-modal");
    contentEl.createEl("h2", { text: "编辑规则" });

    new Setting(contentEl)
      .setName("规则名称")
      .addText((text) => text.setValue(this.rule.name).onChange((value) => (this.rule.name = value)));

    new Setting(contentEl)
      .setName("启用")
      .addToggle((toggle) => toggle.setValue(this.rule.enabled).onChange((value) => (this.rule.enabled = value)));

    new Setting(contentEl)
      .setName("匹配逻辑")
      .setDesc("全部条件匹配适合精确规则；任一条件匹配适合临时巡检。")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("all", "全部条件匹配")
          .addOption("any", "任一条件匹配")
          .setValue(this.rule.matchLogic)
          .onChange((value) => (this.rule.matchLogic = value))
      );

    contentEl.createEl("h3", { text: "适用范围" });
    addTextarea(contentEl, "特定笔记", "每行一个完整路径，或一个文件名。", this.rule.files, (value) => {
      this.rule.files = value;
    });
    addTextarea(contentEl, "特定文件夹", "每行一个文件夹路径。", this.rule.folders, (value) => {
      this.rule.folders = value;
    });
    addTextarea(contentEl, "排除笔记", "每行一个完整路径，或一个文件名。", this.rule.excludedFiles, (value) => {
      this.rule.excludedFiles = value;
    });
    addTextarea(contentEl, "排除文件夹", "每行一个文件夹路径或路径片段。", this.rule.excludedFolders, (value) => {
      this.rule.excludedFolders = value;
    });
    addTextarea(contentEl, "排除标签", "每行一个标签，可写 #tag 或 tag。", this.rule.excludedTags, (value) => {
      this.rule.excludedTags = value;
    });
    addTextarea(contentEl, "特定标签", "每行一个标签，可写 #tag 或 tag。", this.rule.tags, (value) => {
      this.rule.tags = value;
    });
    addTextarea(contentEl, "文件名包含", "每行一个必须包含的片段。", this.rule.filenameIncludes, (value) => {
      this.rule.filenameIncludes = value;
    });
    addTextarea(
      contentEl,
      "属性条件",
      "每行一条：属性名 操作 值。操作支持 exists、notExists、equals、notEquals、contains、regex。",
      this.rule.propertyConditions,
      (value) => {
        this.rule.propertyConditions = value;
      }
    );

    contentEl.createEl("h3", { text: "格式规则" });
    addTextarea(contentEl, "必需属性", "每行一个 frontmatter 属性。", this.rule.requiredProperties, (value) => {
      this.rule.requiredProperties = value;
    });
    addTextarea(
      contentEl,
      "属性检查",
      "每行一条：属性名 操作 值。操作支持 exists、notExists、equals、notEquals、contains、regex。",
      this.rule.propertyChecks,
      (value) => {
        this.rule.propertyChecks = value;
      }
    );
    addTextarea(contentEl, "必需标题", "每行一个完整标题，例如 ## 资料来源。", this.rule.requiredHeadings, (value) => {
      this.rule.requiredHeadings = value;
    });
    new Setting(contentEl)
      .setName("检查标题顺序")
      .addToggle((toggle) =>
        toggle.setValue(this.rule.requireHeadingOrder).onChange((value) => (this.rule.requireHeadingOrder = value))
      );
    new Setting(contentEl)
      .setName("文件名正则")
      .setDesc("匹配不含 .md 的文件名。留空则不检查。")
      .addText((text) => text.setValue(this.rule.filenameRegex || "").onChange((value) => (this.rule.filenameRegex = value)));

    new Setting(contentEl)
      .addButton((button) =>
        button.setButtonText("保存").setCta().onClick(async () => {
          if (!this.rule.id) this.rule.id = `rule-${Date.now()}`;
          await this.onSave(this.rule);
          this.close();
        })
      )
      .addButton((button) => button.setButtonText("取消").onClick(() => this.close()));
  }

  onClose() {
    this.contentEl.empty();
  }
}

class FolderStructureRuleModal extends Modal {
  constructor(app, plugin, rule, onSave) {
    super(app);
    this.plugin = plugin;
    this.rule = rule;
    this.onSave = onSave;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("harness-noting-modal");
    contentEl.createEl("h2", { text: "编辑文件夹结构规则" });

    new Setting(contentEl)
      .setName("规则名称")
      .addText((text) => text.setValue(this.rule.name).onChange((value) => (this.rule.name = value)));

    new Setting(contentEl)
      .setName("启用")
      .addToggle((toggle) => toggle.setValue(this.rule.enabled).onChange((value) => (this.rule.enabled = value)));

    new Setting(contentEl)
      .setName("根文件夹")
      .setDesc("检查这个目录下的每个直接子文件夹。")
      .addText((text) => text.setValue(this.rule.rootFolder || "").onChange((value) => (this.rule.rootFolder = value)));

    new Setting(contentEl)
      .setName("包含文件夹正则")
      .setDesc("只检查名称匹配这个正则的子文件夹。留空表示全部检查。")
      .addText((text) => text.setValue(this.rule.includeFolderRegex || "").onChange((value) => (this.rule.includeFolderRegex = value)));

    new Setting(contentEl)
      .setName("排除文件夹正则")
      .setDesc("名称匹配这个正则的子文件夹不会检查。")
      .addText((text) => text.setValue(this.rule.excludeFolderRegex || "").onChange((value) => (this.rule.excludeFolderRegex = value)));

    addTextarea(contentEl, "必需子文件夹", "每行一个子文件夹名称。", this.rule.requiredSubfolders, (value) => {
      this.rule.requiredSubfolders = value;
    });

    addTextarea(
      contentEl,
      "必需文件",
      "每行一个文件名模式。支持 * 通配符、regex: 正则、{{folderName}} 占位符。",
      this.rule.requiredFiles,
      (value) => {
        this.rule.requiredFiles = value;
      }
    );

    new Setting(contentEl)
      .addButton((button) =>
        button.setButtonText("保存").setCta().onClick(async () => {
          if (!this.rule.id) this.rule.id = `folder-rule-${Date.now()}`;
          await this.onSave(this.rule);
          this.close();
        })
      )
      .addButton((button) => button.setButtonText("取消").onClick(() => this.close()));
  }

  onClose() {
    this.contentEl.empty();
  }
}

class RootWhitelistRuleModal extends Modal {
  constructor(app, plugin, rule, onSave) {
    super(app);
    this.plugin = plugin;
    this.rule = rule;
    this.onSave = onSave;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("harness-noting-modal");
    contentEl.createEl("h2", { text: "编辑一级目录白名单" });

    new Setting(contentEl)
      .setName("规则名称")
      .addText((text) => text.setValue(this.rule.name).onChange((value) => (this.rule.name = value)));

    new Setting(contentEl)
      .setName("启用")
      .addToggle((toggle) => toggle.setValue(this.rule.enabled).onChange((value) => (this.rule.enabled = value)));

    addTextarea(contentEl, "允许的根目录子项", "每行一个文件夹名或文件名。", this.rule.allowedEntries, (value) => {
      this.rule.allowedEntries = value;
    });

    addTextarea(contentEl, "忽略的根目录子项", "系统目录、缓存目录或本机文件可以放这里。", this.rule.ignoredEntries, (value) => {
      this.rule.ignoredEntries = value;
    });

    new Setting(contentEl)
      .setName("忽略点号开头的项目")
      .setDesc("例如 .git、.obsidian、.DS_Store。")
      .addToggle((toggle) =>
        toggle.setValue(this.rule.ignoreDotEntries).onChange((value) => (this.rule.ignoreDotEntries = value))
      );

    new Setting(contentEl)
      .addButton((button) =>
        button.setButtonText("保存").setCta().onClick(async () => {
          if (!this.rule.id) this.rule.id = `root-whitelist-${Date.now()}`;
          await this.onSave(this.rule);
          this.close();
        })
      )
      .addButton((button) => button.setButtonText("取消").onClick(() => this.close()));
  }

  onClose() {
    this.contentEl.empty();
  }
}

class ResultsModal extends Modal {
  constructor(app, results) {
    super(app);
    this.results = results;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Harness Noting 检查结果" });

    const checked = this.results.filter((result) => result.rules.length).length;
    const failed = this.results.filter((result) => result.issues.length).length;
    const report = buildResultsReport(this.results);
    contentEl.createEl("p", {
      text: `已匹配 ${checked} 个项目，其中 ${failed} 个存在问题。`,
    });

    new Setting(contentEl)
      .addButton((button) =>
        button.setButtonText("复制结论").setCta().onClick(async () => {
          await copyText(report);
          new Notice("检查结论已复制");
        })
      );

    const reportEl = contentEl.createEl("textarea", {
      cls: "harness-noting-report",
    });
    reportEl.value = report;
    reportEl.readOnly = true;

    const issueResults = this.results.filter((result) => result.issues.length);
    if (!issueResults.length) {
      contentEl.createEl("p", { cls: "harness-noting-ok", text: "全部通过。" });
      return;
    }

    for (const result of issueResults) {
      const block = contentEl.createDiv({ cls: "harness-noting-rule" });
      block.createDiv({ cls: "harness-noting-rule-title", text: result.path || result.file.path });
      block.createDiv({
        cls: "harness-noting-rule-meta",
        text: `匹配规则：${result.rules.join("、")}`,
      });
      const list = block.createEl("ul", { cls: "harness-noting-issue-list" });
      for (const issue of result.issues) {
        list.createEl("li", { text: `[${issue.rule}] ${issue.message}` });
      }
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

function addTextarea(containerEl, name, desc, value, onChange) {
  new Setting(containerEl)
    .setName(name)
    .setDesc(desc)
    .addTextArea((text) => {
      text.setValue(value || "");
      text.inputEl.rows = 4;
      text.onChange(onChange);
    });
}

function buildResultsReport(results) {
  const checked = results.filter((result) => result.rules.length).length;
  const failedResults = results.filter((result) => result.issues.length);
  const lines = [`Harness Noting: checked ${checked} matched item(s), ${failedResults.length} failed.`];

  if (!failedResults.length) {
    lines.push("All matched notes passed.");
    return lines.join("\n");
  }

  for (const result of failedResults) {
    lines.push("");
    lines.push(`FAIL ${result.path || result.file.path}`);
    lines.push(`Rules: ${result.rules.join(", ")}`);
    for (const issue of result.issues) {
      lines.push(`- [${issue.rule}] ${issue.message}`);
    }
  }

  return lines.join("\n");
}

async function copyText(text) {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

function createEmptyRule() {
  return {
    id: `rule-${Date.now()}`,
    name: "新规则",
    enabled: true,
    matchLogic: "all",
    files: "",
    folders: "",
    excludedFiles: "",
    excludedFolders: "",
    excludedTags: "",
    tags: "",
    filenameIncludes: "",
    propertyConditions: "",
    requiredProperties: "",
    propertyChecks: "",
    requiredHeadings: "",
    requireHeadingOrder: true,
    filenameRegex: "",
  };
}

function createEmptyFolderStructureRule() {
  return {
    id: `folder-rule-${Date.now()}`,
    name: "新文件夹结构规则",
    enabled: true,
    rootFolder: "",
    includeFolderRegex: "",
    excludeFolderRegex: "",
    requiredSubfolders: "",
    requiredFiles: "",
  };
}

function createEmptyRootWhitelistRule() {
  return {
    id: `root-whitelist-${Date.now()}`,
    name: "新一级目录白名单",
    enabled: true,
    allowedEntries: "",
    ignoredEntries: ".git\n.obsidian\n.trash\n.DS_Store",
    ignoreDotEntries: true,
  };
}

function cloneRule(rule) {
  return JSON.parse(JSON.stringify(rule));
}

module.exports = HarnessNotingPlugin;
