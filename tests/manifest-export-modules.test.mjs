import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, posix, join } from "node:path";

function readText(path) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

function readJson(path) {
  return JSON.parse(readText(path));
}

function resolveDiskPath(relativePath) {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", relativePath);
}

function getRuntimeModuleRoots() {
  const exportSource = readText("../src/modules/export.js");
  return Array.from(
    exportSource.matchAll(/resolveModulePath\("([^"]+)"\)/g),
    (match) => match[1]
  );
}

function getStaticModuleImports(modulePath) {
  const source = readText(`../${modulePath}`);
  return Array.from(
    source.matchAll(/(?:import|export)\s+(?:[^'"()]*?\s+from\s+)?["']([^"']+\.js)["']/g),
    (match) => match[1]
  )
    .filter((specifier) => specifier.startsWith("."))
    .map((specifier) => posix.normalize(posix.join(dirname(modulePath), specifier)));
}

function collectRuntimeModuleGraph() {
  const pending = getRuntimeModuleRoots();
  const seen = new Set();

  while (pending.length) {
    const modulePath = pending.pop();
    if (!modulePath || seen.has(modulePath)) continue;
    seen.add(modulePath);
    getStaticModuleImports(modulePath).forEach((dependencyPath) => {
      if (!seen.has(dependencyPath)) {
        pending.push(dependencyPath);
      }
    });
  }

  return Array.from(seen).sort();
}

function getExposedExtractorResources(manifest) {
  return (manifest.web_accessible_resources || [])
    .flatMap((entry) => entry.resources || [])
    .filter((resource) => /^src\/modules\/export\/platforms\/[^/]+\/extractor\.js$/.test(resource))
    .sort();
}

function getRegistryExtractorImports() {
  const registrySource = readText("../src/modules/export/platforms/registry.js");
  return Array.from(
    registrySource.matchAll(/from\s+["']\.\/([^/]+)\/extractor\.js["']/g),
    (match) => `src/modules/export/platforms/${match[1]}/extractor.js`
  ).sort();
}

test("manifest exposes every export module loaded at runtime", () => {
  const manifest = readJson("../manifest.json");
  const runtimeModules = collectRuntimeModuleGraph();
  const exposedResources = new Set(
    (manifest.web_accessible_resources || []).flatMap((entry) => entry.resources || [])
  );

  assert.notEqual(runtimeModules.length, 0, "expected export.js to declare runtime-loaded modules");
  assert.deepEqual(
    runtimeModules.filter((modulePath) => !exposedResources.has(modulePath)),
    []
  );
});

test("manifest exposes only the registered platform extractor", () => {
  const manifest = readJson("../manifest.json");
  const registryExtractors = getRegistryExtractorImports();

  assert.notEqual(registryExtractors.length, 0, "expected registry.js to import a platform extractor");
  assert.deepEqual(getExposedExtractorResources(manifest), registryExtractors);
});

test("every content_scripts entry and web_accessible_resource exists on disk", () => {
  const manifest = readJson("../manifest.json");

  // 验证 content_scripts 中每个 js 文件存在
  const contentScripts = (manifest.content_scripts || []).flatMap((entry) => entry.js || []);
  for (const scriptPath of contentScripts) {
    const diskPath = resolveDiskPath(scriptPath);
    assert.ok(
      existsSync(diskPath),
      `content_scripts entry does not exist on disk: ${scriptPath}`
    );
  }

  // 验证 web_accessible_resources 中每个非通配符资源存在
  const resources = (manifest.web_accessible_resources || []).flatMap((entry) => entry.resources || []);
  for (const resourcePath of resources) {
    // 跳过通配符路径（如 images/*.png、images/*）
    if (resourcePath.includes("*")) continue;
    const diskPath = resolveDiskPath(resourcePath);
    assert.ok(
      existsSync(diskPath),
      `web_accessible_resource does not exist on disk: ${resourcePath}`
    );
  }
});
