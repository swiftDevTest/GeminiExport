import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

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
