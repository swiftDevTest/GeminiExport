import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";

function readText(path) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

function readJson(path) {
  return JSON.parse(readText(path));
}

function placeholders(message) {
  return Array.from(new Set(String(message).match(/\$[1-9]/g) || [])).sort();
}

test("all locale catalogs contain the same keys and placeholders as English", () => {
  const localeRoot = new URL("../_locales/", import.meta.url);
  const locales = readdirSync(localeRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const english = readJson("../_locales/en/messages.json");
  const englishKeys = Object.keys(english).sort();

  for (const locale of locales) {
    const catalog = readJson(`../_locales/${locale}/messages.json`);
    assert.deepEqual(
      Object.keys(catalog).sort(),
      englishKeys,
      `${locale} locale keys must match English`
    );

    for (const key of englishKeys) {
      assert.equal(
        typeof catalog[key]?.message,
        "string",
        `${locale}.${key} must contain a message`
      );
      assert.notEqual(
        catalog[key].message.trim(),
        "",
        `${locale}.${key} must not be empty`
      );
      assert.deepEqual(
        placeholders(catalog[key].message),
        placeholders(english[key].message),
        `${locale}.${key} must preserve positional placeholders`
      );
    }
  }
});

test("Pro benefit copy is keyed by feature instead of list position", () => {
  const popupHtml = readText("../src/popup.html");
  const popupSource = readText("../src/popup.js");
  const benefitKeys = Array.from(
    popupHtml.matchAll(/data-benefit-key="([^"]+)"/g),
    (match) => match[1]
  );

  assert.deepEqual(benefitKeys, [
    "popup_benefit_batch_export",
    "popup_benefit_notion_obsidian",
    "popup_benefit_unlimited_exports",
    "popup_benefit_report_themes",
    "popup_benefit_hide_watermark"
  ]);
  assert.match(popupSource, /getAttribute\("data-benefit-key"\)/);
  assert.doesNotMatch(popupSource, /featureTexts\s*=\s*\[/);
});

test("selected-message retry and re-export preserve the original message scope", () => {
  const contentSource = readText("../src/content.js");

  assert.doesNotMatch(contentSource, /exportSingleSidebarConversation/);
  assert.match(contentSource, /const isSelectedExport = settingsForExport\.mode === "selected"/);
  assert.match(contentSource, /messagesForExport: isSelectedExport \? rawMessagesForExport : null/);
  assert.match(contentSource, /messages: mode === "selected" \? cloneExportMessages\(rawMessages\) : null/);
  assert.match(contentSource, /requestedMessages\s*\|\|\s*\(isSelectedExport/);
  assert.match(contentSource, /if \(!requestedMessages && !isSelectedExport && platformForExport\)/);
});

test("export result dialog keeps the shared confetti and re-export layout styles", () => {
  const contentStyles = readText("../src/content.css");

  assert.match(contentStyles, /\.cv-batch-result-confetti\s*\{[\s\S]*?display:\s*flex/);
  assert.match(contentStyles, /\.cv-batch-result-confetti strong\s*\{[\s\S]*?font-size:\s*30px/);
  assert.match(contentStyles, /\.cv-batch-result-confetti\[hidden\][\s\S]*?display:\s*none/);
  assert.match(contentStyles, /\.cv-export-result-meta\s*\{/);
  assert.match(contentStyles, /\.cv-export-failure-info\s*\{/);
  assert.match(contentStyles, /\.cv-re-export-label\s*\{[\s\S]*?grid-column:\s*1\s*\/\s*-1/);
});

test("batch result rows use per-file save outcomes", () => {
  const contentSource = readText("../src/content.js");
  const resultBlock = contentSource.match(
    /const batchResultItems = \[[\s\S]*?\n\s*\];/
  )?.[0] || "";

  assert.match(resultBlock, /saveResult\.items/);
  assert.match(resultBlock, /preparationFailures/);
  assert.doesNotMatch(resultBlock, /preparedFiles\.map/);
  assert.match(contentSource, /status: "saved"/);
  assert.match(contentSource, /status: "failed"/);
});

test("server-verified Pro fallback is bound to the current entitlement fingerprint", () => {
  const contentSource = readText("../src/content.js");

  assert.match(contentSource, /lastVerifiedEntitlementFingerprint/);
  assert.match(contentSource, /fingerprint === lastVerifiedEntitlementFingerprint/);
  assert.match(contentSource, /isProUser && hasFreshEntitlementServerVerification\(\)/);
  assert.match(contentSource, /if \(!isProUser \|\| !hasFreshEntitlementServerVerification\(\)\)/);
  assert.match(
    contentSource,
    /function canUseBatchExportLocally\(\) \{\s*return Boolean\(isProUser && hasFreshEntitlementServerVerification\(\)\)/
  );
  assert.doesNotMatch(contentSource, /allowing export based on cached state/);

  for (const functionName of [
    "runInPageBatchExport",
    "runInPageBatchNotionSync",
    "runInPageBatchObsidianSync"
  ]) {
    const start = contentSource.indexOf(`async function ${functionName}`);
    const nextFunction = contentSource.indexOf("\n  async function ", start + 1);
    const source = contentSource.slice(start, nextFunction === -1 ? undefined : nextFunction);
    assert.notEqual(start, -1, `${functionName} must exist`);
    assert.match(source, /verifySignedInExportAccess\(/, `${functionName} must verify server entitlement`);
    assert.match(source, /canUseBatchExportLocally\(\)/, `${functionName} must require verified Pro`);
  }
});

test("disabled analytics implementation and callers are fully removed", () => {
  const manifest = readJson("../manifest.json");
  const packageJson = readJson("../package.json");
  const contentSource = readText("../src/content.js");
  const backgroundSource = readText("../src/background.js");
  const contentScripts = (manifest.content_scripts || []).flatMap((entry) => entry.js || []);

  assert.equal(contentScripts.includes("src/modules/analytics.js"), false);
  assert.equal(
    existsSync(new URL("../src/modules/analytics.js", import.meta.url)),
    false
  );
  assert.doesNotMatch(packageJson.scripts.check, /modules\/analytics\.js/);
  assert.doesNotMatch(contentSource, /CHATVAULT_ANALYTICS/);
  assert.doesNotMatch(backgroundSource, /CHATVAULT_ANALYTICS/);
});

test("Obsidian settings and background keep the stable ChatVault key in sync", () => {
  const backgroundSource = readText("../src/obsidian-background.js");
  const settingsHtml = readText("../src/obsidian-settings.html");
  const settingsSource = readText("../src/obsidian-settings.js");

  assert.match(backgroundSource, /const CONFIG_KEY = "chatvault_obsidian_config_v1"/);
  assert.match(backgroundSource, /const PRODUCT_CONFIG_KEY = storageKey\("obsidian_config\.v1"\)/);
  assert.match(backgroundSource, /async function getObsidianConfig\(\)/);
  assert.match(settingsHtml, /<script src="product-config\.js"><\/script>/);
  assert.match(settingsSource, /const CONFIG_KEY = "chatvault_obsidian_config_v1"/);
  assert.match(settingsSource, /const PRODUCT_CONFIG_KEY = storageKey\("obsidian_config\.v1"\)/);
  assert.match(settingsSource, /\[CONFIG_KEY\]: savedConfig/);
  assert.match(settingsSource, /\[PRODUCT_CONFIG_KEY\]: savedConfig/);
  assert.match(settingsSource, /let directoryPickerInFlight = false/);
});

test("background hardening keeps OAuth errors observable and host fallback product-scoped", () => {
  const backgroundSource = readText("../src/background.js");
  const manifest = readJson("../manifest.json");
  const firstResources = manifest.web_accessible_resources?.[0]?.resources || [];

  assert.match(backgroundSource, /async function startGoogleOAuthSessionInternal/);
  assert.doesNotMatch(backgroundSource, /new Promise\s*\(\s*async/);
  assert.match(backgroundSource, /Failed to import product-config\.js/);
  assert.match(backgroundSource, /Failed to import supabase-config\.js/);
  assert.match(backgroundSource, /: \["gemini\.google\.com"\]/);
  assert.doesNotMatch(backgroundSource, /chatgpt\.com|chat\.openai\.com|claude\.ai|oaiusercontent|anthropic\.com/);
  assert.match(backgroundSource, /\[ENTITLEMENT_STATE_CACHE_KEY\]: null/);
  assert.equal(firstResources.includes("images/*"), true);
  assert.equal(firstResources.includes("images/*.png"), false);
});
