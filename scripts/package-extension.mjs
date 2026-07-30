import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, "..");
const distRoot = join(repoRoot, "dist");
const stagingRoot = join(distRoot, "extension");
const REPRODUCIBLE_MTIME = new Date("2000-01-01T00:00:00.000Z");

const includePaths = [
  "_locales",
  "images",
  "src",
  "manifest.json",
  "welcome.html"
];

const excludedNames = new Set([
  ".DS_Store",
  // 已废弃的图片资源（项目记忆硬约束）：即使被误重新加入 images/ 也不打包进 Web Store zip
  "chatvault-exporter-logo-1024.png",
  "chatvault-exporter-logo.svg",
  "platform-chatgpt.png",
  "platform-claude.svg",
  // subscribe.* 属于远端 Website 项目页面，扩展代码零引用，不应打包进扩展包
  "subscribe.html",
  "subscribe.js",
  "subscribe.css"
]);

// 文件名后缀黑名单：临时文件、日志、备份、IDE 配置等不应打包进 Web Store zip
const forbiddenSuffixes = [".tmp", ".log", ".bak", ".swp", ".orig"];
const forbiddenNamePatterns = [/^test-(?:write|dd|tmp)/i];

function isForbiddenFileName(name) {
  if (excludedNames.has(name)) return true;
  const lower = name.toLowerCase();
  if (forbiddenSuffixes.some((suffix) => lower.endsWith(suffix))) return true;
  if (forbiddenNamePatterns.some((pattern) => pattern.test(name))) return true;
  return false;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function assertVersionsMatch() {
  const manifest = readJson(join(repoRoot, "manifest.json"));
  const pkg = readJson(join(repoRoot, "package.json"));
  if (manifest.version !== pkg.version) {
    throw new Error(`manifest.json version ${manifest.version} does not match package.json version ${pkg.version}`);
  }
  return { version: manifest.version, name: pkg.name };
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function copyRecursive(src, dest) {
  const name = src.split(/[\\/]/).pop();
  if (isForbiddenFileName(name)) {
    return;
  }

  const stats = statSync(src);
  if (stats.isDirectory()) {
    ensureDir(dest);
    // 排序后遍历，保证打包文件顺序确定性（便于 CI 产物比对）
    for (const entry of readdirSync(src).sort()) {
      copyRecursive(join(src, entry), join(dest, entry));
    }
    return;
  }

  if (!stats.isFile()) {
    return;
  }

  ensureDir(dirname(dest));
  copyFileSync(src, dest);
}

function listPackagedFiles(dir, root = dir) {
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      return listPackagedFiles(fullPath, root);
    }
    return relative(root, fullPath).replace(/\\/g, "/");
  });
}

function prepareReleaseManifest() {
  const manifestPath = join(stagingRoot, "manifest.json");
  const manifest = readJson(manifestPath);
  // Chrome Web Store 包不允许包含 key 字段（会与商店分配的 key 冲突）
  if (Object.hasOwn(manifest, "key")) {
    delete manifest.key;
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
}

// 校验 staging 目录中的 manifest.json 引用的所有文件均存在，避免打包缺失资源
function assertManifestReferencesExist() {
  const manifest = readJson(join(stagingRoot, "manifest.json"));
  const missing = [];

  function check(relativePath) {
    // 跳过通配符路径（如 images/*.png、images/*）
    if (typeof relativePath !== "string" || relativePath.includes("*")) return;
    const target = join(stagingRoot, relativePath);
    if (!existsSync(target)) {
      missing.push(relativePath);
    }
  }

  // icons
  if (manifest.icons && typeof manifest.icons === "object") {
    Object.values(manifest.icons).forEach(check);
  }

  // action.default_icon & action.default_popup
  if (manifest.action) {
    if (manifest.action.default_icon && typeof manifest.action.default_icon === "object") {
      Object.values(manifest.action.default_icon).forEach(check);
    }
    if (typeof manifest.action.default_popup === "string") {
      check(manifest.action.default_popup);
    }
  }

  // background.service_worker
  if (manifest.background && typeof manifest.background.service_worker === "string") {
    check(manifest.background.service_worker);
  }

  // content_scripts[].js[]
  (manifest.content_scripts || []).forEach((entry) => {
    (entry.js || []).forEach(check);
  });

  // web_accessible_resources[].resources[]
  (manifest.web_accessible_resources || []).forEach((entry) => {
    (entry.resources || []).forEach(check);
  });

  if (missing.length > 0) {
    throw new Error(`Manifest references missing files in package:\n${missing.join("\n")}`);
  }
}

function normalizePackagedTimestamps(files) {
  files.forEach((file) => {
    utimesSync(join(stagingRoot, file), REPRODUCIBLE_MTIME, REPRODUCIBLE_MTIME);
  });
}

function createZip(version, name, files) {
  const zipPath = join(distRoot, `${name}-${version}.zip`);
  rmSync(zipPath, { force: true });
  // 固定文件顺序、时间戳和时区；-X 再剥离 uid/gid 等 extra fields。
  const result = spawnSync("zip", ["-qX", zipPath, ...files], {
    cwd: stagingRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      TZ: "UTC"
    }
  });
  if (result.status !== 0) {
    throw new Error(`zip failed: ${result.stderr || result.stdout || "unknown error"}`);
  }
  return zipPath;
}

function main() {
  const { version, name } = assertVersionsMatch();
  rmSync(stagingRoot, { recursive: true, force: true });
  ensureDir(stagingRoot);

  for (const item of includePaths) {
    const src = join(repoRoot, item);
    if (!existsSync(src)) {
      throw new Error(`Required package path is missing: ${item}`);
    }
    copyRecursive(src, join(stagingRoot, item));
  }
  prepareReleaseManifest();
  assertManifestReferencesExist();

  const files = listPackagedFiles(stagingRoot);
  const forbiddenPrefixes = ["site/", "supabase/", "tests/", "node_modules/", "dist/", ".git/"];
  const forbidden = files.filter((file) =>
    forbiddenPrefixes.some((prefix) => file.startsWith(prefix))
    || isForbiddenFileName(file.split("/").pop())
  );
  if (forbidden.length > 0) {
    throw new Error(`Forbidden files were packaged:\n${forbidden.join("\n")}`);
  }

  normalizePackagedTimestamps(files);
  const zipPath = createZip(version, name, files);
  console.log(`Packaged ${files.length} files`);
  console.log(`Staging directory: ${relative(repoRoot, stagingRoot)}`);
  console.log(`ZIP: ${relative(repoRoot, zipPath)}`);
}

main();
