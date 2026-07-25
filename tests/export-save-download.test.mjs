import test from "node:test";
import assert from "node:assert/strict";

// 验证配额扣减时序的关键前提：saveBlob 必须在下载真正完成后才 resolve。
// save.js 在模块加载时挂载 chrome.runtime.onMessage 监听器（用于接收
// CHATVAULT_DOWNLOAD_STATUS 消息），因此必须在 import 之前就设置完整的
// chrome mock，否则监听器不会挂载，waitForDownloadCompletion 会永久等待。

const messageListeners = [];
let downloadIdCounter = 0;
let resolveDownload = null;
let triggerCancel = null;

globalThis.URL.createObjectURL = () => "blob:https://gemini.google.com/test-blob";
globalThis.URL.revokeObjectURL = () => {};
globalThis.chrome = {
  runtime: {
    lastError: null,
    id: "test-extension-id",
    onMessage: {
      addListener(fn) { messageListeners.push(fn); },
      removeListener(fn) {
        const idx = messageListeners.indexOf(fn);
        if (idx >= 0) messageListeners.splice(idx, 1);
      }
    },
    sendMessage(message, callback) {
      // 模拟 background 返回 in_progress（saveAs 对话框打开中）
      const downloadId = ++downloadIdCounter;
      callback({
        ok: true,
        downloadId: downloadId,
        state: "in_progress",
        filename: message.filename
      });
      // 提供触发下载完成/取消的句柄，供测试用例调用
      // 传入 sender 以模拟真实扩展环境（save.js 会校验 sender.id === chrome.runtime.id）
      const trustedSender = { id: "test-extension-id" };
      resolveDownload = (overrides) => {
        messageListeners.forEach((fn) => fn({
          type: "CHATVAULT_DOWNLOAD_STATUS",
          downloadId: downloadId,
          state: "complete",
          filename: message.filename,
          cancelled: false,
          ...overrides
        }, trustedSender));
      };
      triggerCancel = () => {
        messageListeners.forEach((fn) => fn({
          type: "CHATVAULT_DOWNLOAD_STATUS",
          downloadId: downloadId,
          state: "interrupted",
          cancelled: true
        }, trustedSender));
      };
    }
  }
};

const { saveBlob } = await import("../src/modules/export/save.js");

test("saveBlob does not resolve until CHATVAULT_DOWNLOAD_STATUS complete arrives", async () => {
  // 当 background 返回 state="in_progress" + downloadId 时，saveBlob 应等待
  // 下载完成消息到达后才 resolve。这确保配额扣减（在 saveBlob 成功后执行）
  // 不会在用户尚未确认保存对话框时就发生。
  const savePromise = saveBlob(new Blob(["test"], { type: "text/plain" }), "Export.pdf", { saveAs: true });

  // saveBlob 不应在此刻 resolve（下载尚未完成）
  let resolvedEarly = false;
  await Promise.race([
    savePromise.then(() => { resolvedEarly = true; }),
    new Promise((r) => setTimeout(r, 50))
  ]);
  assert.equal(resolvedEarly, false, "saveBlob must not resolve before download completes");

  // 触发下载完成
  resolveDownload({ state: "complete", filename: "Exported.pdf" });
  const result = await savePromise;

  assert.equal(result.ok, true);
  assert.equal(result.filename, "Exported.pdf");
});

test("saveBlob returns cancelled=true when user cancels download", async () => {
  // 用户取消下载时 saveBlob 返回 cancelled=true，
  // 调用方据此跳过配额扣减（recordSuccessfulExportUsage 不应被调用）。
  const savePromise = saveBlob(new Blob(["test"], { type: "text/plain" }), "Cancel.pdf", { saveAs: true });

  triggerCancel();
  const result = await savePromise;

  assert.equal(result.ok, false);
  assert.equal(result.cancelled, true);
});
