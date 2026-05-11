// ==UserScript==
// @name         ChatGPT 對話 JSON 與交接檔匯出工具
// @name:en      ChatGPT Conversation Handoff Exporter
// @namespace    https://github.com/SunnyLeu/ChatGPT-Conversation-Handoff-Exporter
// @version      1.1.13
// @description  在 ChatGPT 對話頁新增按鈕，可下載目前對話的格式化原始 JSON，或直接產出精簡交接用 handoff JSON。
// @description:en Export the current ChatGPT conversation as formatted raw JSON or compact handoff JSON.
// @author       SunnyLeu
// @license      MIT
// @homepageURL  https://github.com/SunnyLeu/ChatGPT-Conversation-Handoff-Exporter
// @supportURL   https://github.com/SunnyLeu/ChatGPT-Conversation-Handoff-Exporter/issues
// @updateURL    https://raw.githubusercontent.com/SunnyLeu/ChatGPT-Conversation-Handoff-Exporter/main/chatgpt-conversation-handoff-exporter.user.js
// @downloadURL  https://raw.githubusercontent.com/SunnyLeu/ChatGPT-Conversation-Handoff-Exporter/main/chatgpt-conversation-handoff-exporter.user.js
// @match        https://chatgpt.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==
/*
 * ChatGPT 對話 JSON 與交接檔匯出工具
 * ============================================================
 *
 * 這是一個 Tampermonkey / Userscript 腳本。
 *
 * 主要用途：
 *   1. 在 ChatGPT 對話頁右上角新增兩個按鈕：
 *      -「下載原始 JSON」
 *      -「下載交接 JSON」
 *
 *   2.「下載原始 JSON」會匯出目前對話的 raw conversation JSON。
 *
 *   3.「下載交接 JSON」會把 raw conversation JSON 轉成較精簡、
 *      適合上傳到新 ChatGPT 對話接續前情的 handoff JSON。
 *
 * 設計原則：
 *   - 只處理目前使用者正在看的單一對話。
 *   - 不批次掃描所有對話。
 *   - 不上傳任何資料到第三方伺服器。
 *   - 不把 token、cookie、header、raw JSON 印到 Console。
 *   - 不把驗證資訊寫死在程式碼。
 *   - 所有暫存資料只放在瀏覽器頁面的記憶體中。
 *
 * 注意事項：
 *   - 本腳本依賴 ChatGPT 網頁版目前的內部請求與 DOM 結構。
 *   - ChatGPT 前端或內部 endpoint 若改版，腳本可能需要更新。
 *   - 本腳本不是 OpenAI 官方 API，也不是官方匯出功能。
 */
(function () {
  'use strict';
  // ============================================================
  // 一、全域常數與狀態
  // ============================================================
  /*
   * INSTALL_FLAG 用來避免腳本在同一頁面被重複安裝。
   *
   * ChatGPT 是 SPA（Single Page Application），頁面可能不完整重新載入，
   * Tampermonkey 或瀏覽器也可能因為導航行為導致腳本重複初始化。
   *
   * 若不防重，可能會出現：
   *   - 多個相同按鈕
   *   - 多次包裝 window.fetch
   *   - 重複的 timer / listener
   */
  const INSTALL_FLAG = '__chatgptConversationHandoffExporterInstalled_v1113';
  /*
   * 兩個按鈕的 DOM id。
   *
   * raw button：
   *   下載 ChatGPT 原始 conversation JSON。
   *
   * handoff button：
   *   將原始 conversation JSON 轉換成 handoff JSON 後下載。
   */
  const RAW_BUTTON_ID = 'cgpt-export-raw-json-button';
  const HANDOFF_BUTTON_ID = 'cgpt-export-handoff-json-button';
  /*
   * 若目前頁面已經安裝過本腳本，就直接結束。
   */
  if (window[INSTALL_FLAG]) {
    return;
  }
  window[INSTALL_FLAG] = true;
  /*
   * capturedRawByConversationId：
   *   暫存已捕捉到的 raw conversation JSON。
   *
   *   key：conversation_id
   *   value：
   *     {
   *       rawText: string,     // 原始 JSON 字串
   *       capturedAt: number   // 捕捉時間，Date.now()
   *     }
   *
   * 注意：
   *   這些資料只存在目前頁面的記憶體中，不會寫入 localStorage、
   *   IndexedDB、cookie 或任何永久儲存區。
   */
  const capturedRawByConversationId = new Map();
  /*
   * replayRequestByConversationId：
   *   暫存可重新抓取目前對話 JSON 的請求資訊。
   *
   * 目的：
   *   使用者可能新增訊息、編輯訊息、重新產生回答。
   *   若只下載一開始捕捉到的 raw JSON，可能不是最新狀態。
   *
   *   因此腳本會在 ChatGPT 自己成功請求 conversation JSON 時，
   *   記住必要且安全可重用的請求資訊。
   *
   * 注意：
   *   - 不主動讀取 document.cookie。
   *   - 不把 cookie 寫進 headers。
   *   - 不把 headers 印到 Console。
   *   - 實際重抓時使用 credentials: 'include'，讓瀏覽器自行處理同源驗證。
   */
  const replayRequestByConversationId = new Map();
  /*
   * latestReplayRequestTemplate：
   *   保存最近一次可用的 ChatGPT backend API 請求樣板。
   *
   * 用途：
   *   新對話剛建立完成時，ChatGPT 不一定會立刻發出
   *   /backend-api/conversation/{conversation_id} 這個完整對話 JSON 請求。
   *
   *   但新對話送出訊息或接收回覆時，通常仍會呼叫其他 /backend-api/...
   *   endpoint。這些同源請求可提供匯出時重新抓取 JSON 所需的安全
   *   headers 樣板。
   *
   * 注意：
   *   - 這不是背景補抓。
   *   - 不會主動定時打 API。
   *   - 只有使用者按下匯出按鈕時才會用它抓最新 JSON。
   *   - 不保存 cookie。
   *   - 不輸出 headers。
   */
  let latestReplayRequestTemplate = null;
  /*
   * SPA 導航與 UI 插入控制用狀態。
   *
   * lastPathname：記錄上一個路徑，用來偵測 ChatGPT SPA 內部換頁。
   * ensureTimer：避免短時間內重複排程 UI 插入。
   * uiStarted：避免重複啟動 UI 觀察與輪詢。
   * activeExportState：匯出進行中時保留目前進度文字，避免被週期性 UI refresh 覆蓋。
   */
  let lastPathname = location.pathname;
  let ensureTimer = null;
  let uiStarted = false;
  let activeExportState = null;
  /*
   * ChatGPT 回覆中的內嵌引用標記，例如：
   *   citeturn0search0
   *   fileciteturn1file3
   *
   * handoff JSON 主要要給新對話閱讀，因此這類 UI 內嵌標記會移除。
   */
  const INLINE_MARK_PATTERN = /.*?/gs;
  /*
   * handoff JSON 只保留 user / assistant。
   *
   * system、tool 等內部訊息通常會讓新對話失焦，因此不輸出。
   */
  const ALLOWED_ROLES = new Set(['user', 'assistant']);
  /*
   * 這些 content_type 不輸出到 handoff：
   *
   * thoughts：
   *   模型思考過程。
   *
   * reasoning_recap：
   *   推理摘要或內部推理資訊。
   *
   * user_editable_context：
   *   使用者設定 / 個人化上下文，不屬於實際對話訊息。
   */
  const EXCLUDED_CONTENT_TYPES = new Set([
    'thoughts',
    'reasoning_recap',
    'user_editable_context'
  ]);
  /*
   * 某些 assistant 訊息其實是工具操作內容，而不是一般可讀回覆。
   *
   * 這裡先處理較明顯的非 canmore 工具 payload，例如 web 搜尋、
   * 商品查詢、天氣、計算器等工具呼叫。畫布 / textdocs 相關工具
   * 會另外透過 recipient 與 JSON payload 結構判斷。
   */
  const ASSISTANT_TOOL_OPERATION_PATTERN =
    /(^|\n)\s*\{?\s*\"?(search_query|open|find|click|image_query|product_query|sports|finance|weather|calculator|time)\"?\s*:/i;
  /*
   * 兩個按鈕使用的 inline SVG。
   *
   * 使用 inline SVG 的理由：
   *   - 不需要額外載入圖片。
   *   - 不依賴外部 CDN。
   *   - 顏色會跟著 currentColor，自動配合 ChatGPT UI 主題。
   */
  const RAW_JSON_ICON_SVG = `
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" class="-ms-0.5 icon" fill="none">
          <path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
          <path d="M14 2v5h5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M10 12l-2 2 2 2M14 12l2 2-2 2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
  `;
  const HANDOFF_ICON_SVG = `
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" class="-ms-0.5 icon" fill="none">
          <path d="M5 4h9l5 5v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
          <path d="M14 4v5h5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M8 15h8M8 18h5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
        </svg>
  `;
  // ============================================================
  // 二、安全 Log 與錯誤處理輔助函式
  // ============================================================
  /*
   * 本腳本會處理對話 JSON 與請求上下文。
   *
   * 為了避免使用者不小心截圖或複製 Console 時外洩敏感資訊，
   * log 設計採取「最小揭露」原則：
   *
   *   - 不輸出 raw JSON。
   *   - 不輸出 headers。
   *   - 不輸出 cookie。
   *   - 不輸出 bearer token。
   *   - 不輸出完整 response body。
   *
   * 只輸出事件名稱、conversation ID、狀態碼、訊息摘要。
   */
  const LOG_PREFIX = '[ChatGPT 對話匯出工具]';
  /*
   * 建立 Console log 使用的本機時間戳記。
   *
   * 格式：
   *   [yyyy/MM/dd HH:mm:ss]
   *
   * 這裡使用瀏覽器本機時間，方便使用者直接對照操作時間與頁面事件。
   */
  function getLogTimestampPrefix(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hour = String(date.getHours()).padStart(2, '0');
    const minute = String(date.getMinutes()).padStart(2, '0');
    const second = String(date.getSeconds()).padStart(2, '0');

    return `[${year}/${month}/${day} ${hour}:${minute}:${second}]`;
  }
  /*
   * 建立 Console log 前綴。
   *
   * 每次輸出時即時計算時間，避免長時間頁面停留後仍使用舊時間。
   */
  function getLogPrefix() {
    return `${getLogTimestampPrefix()} ${LOG_PREFIX}`;
  }
  /*
   * 輸出一般狀態訊息。
   *
   * 只允許輸出安全摘要，不應傳入 raw JSON、headers、cookie 或 token。
   */
  function logInfo(message, data = null) {
    const prefix = getLogPrefix();

    if (data === null || data === undefined) {
      console.info(prefix, message);
      return;
    }
    console.info(prefix, message, data);
  }
  /*
   * 輸出可恢復的警告訊息。
   *
   * 例如 textdocs 取得失敗但主要匯出仍可繼續時，使用 warning 而不是 error。
   */
  function logWarn(message, data = null) {
    const prefix = getLogPrefix();

    if (data === null || data === undefined) {
      console.warn(prefix, message);
      return;
    }
    console.warn(prefix, message, data);
  }
  /*
   * 輸出需要使用者注意的錯誤摘要。
   *
   * 只保留錯誤名稱與訊息，避免把 response body 或請求內容印到 Console。
   */
  function logError(message, error = null) {
    const prefix = getLogPrefix();

    if (!error) {
      console.error(prefix, message);
      return;
    }
    console.error(prefix, message, {
      name: error.name || 'Error',
      message: error.message || String(error)
    });
  }
  /*
   * 將任意錯誤值轉成可顯示文字。
   *
   * JavaScript throw 的值不一定是 Error 物件，因此這裡統一轉字串。
   */
  function toErrorMessage(error) {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }
  /*
   * 依 HTTP 狀態碼補上使用者可採取的處理建議。
   *
   * 這些訊息只顯示在錯誤提示中，不會改變匯出流程本身。
   */
  function getHttpStatusSuggestion(status) {
    if (status === 401 || status === 403) {
      return '建議：重新整理頁面確認登入狀態仍有效；若仍失敗，請重新登入 ChatGPT 後再試。';
    }
    if (status === 404) {
      return '建議：確認目前頁面仍是同一個對話，或重新整理此對話頁後再試。';
    }
    if (status === 408 || status === 425 || status === 429) {
      return '建議：稍候片刻再試，避免在短時間內連續重複匯出。';
    }
    if (status >= 500) {
      return '建議：ChatGPT 後端可能暫時異常，請稍後再試。';
    }
    return '建議：重新整理頁面，等待對話內容載入完成後再試。';
  }
  /*
   * 建立缺少 request context 時的錯誤訊息。
   *
   * 常見原因是腳本尚未攔截到 ChatGPT 自己發出的 backend API 請求。
   */
  function buildMissingRequestContextMessage(dataName) {
    return (
      `目前無法取得此對話的 ${dataName} 請求資訊。\n\n` +
      '建議：先等待對話內容完全載入，再按一次匯出按鈕。\n' +
      '如果仍然失敗，請重新整理頁面，或重新進入這段對話後再試。'
    );
  }
  /*
   * 顯示使用者可理解的錯誤訊息。
   *
   * 使用 alert 的好處是簡單、明確，而且不需要額外建立提示元件。
   */
  function showErrorAlert(error) {
    alert(toErrorMessage(error));
  }
  // ============================================================
  // 三、網址、標題、時間與檔名處理
  // ============================================================
  /*
   * 判斷目前頁面是否是 ChatGPT 對話頁。
   *
   * 支援：
   *   https://chatgpt.com/c/{conversation_id}
   *   https://chatgpt.com/g/.../c/{conversation_id}
   */
  function isConversationPage() {
    return /\/c\/[^/?#]+/.test(location.pathname);
  }
  /*
   * 從目前網址取得 conversation ID。
   */
  function getConversationIdFromUrl() {
    const match = location.pathname.match(/\/c\/([^/?#]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  }
  /*
   * 檢查字串是否符合 ChatGPT conversation ID 常見的 UUID 格式。
   *
   * 這只是格式檢查，不代表該 ID 一定存在或可存取。
   */
  function looksLikeUuid(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      String(value || '')
    );
  }
  /*
   * 從 ChatGPT 原始 conversation endpoint 取得 conversation ID。
   *
   * 只接受精確 endpoint：
   *   /backend-api/conversation/{conversation_id}
   *
   * 不接受：
   *   /backend-api/conversation/{conversation_id}/...
   *
   * 這樣可以避免把 stream_status、textdocs 等子路徑回應誤認為 raw conversation JSON。
   */
  function getConversationIdFromExactApiUrl(url) {
    try {
      const parsedUrl = new URL(url, location.origin);
      const match = parsedUrl.pathname.match(/^\/backend-api\/conversation\/([^/]+)\/?$/);
      if (!match) {
        return null;
      }
      const conversationId = decodeURIComponent(match[1]);
      return looksLikeUuid(conversationId) ? conversationId : null;
    } catch {
      return null;
    }
  }
  /*
   * 從 conversation 相關子路徑取得 conversation ID。
   *
   * 新對話完成後，ChatGPT 常見請求可能是：
   *   /backend-api/conversation/{conversation_id}/stream_status
   *   /backend-api/conversation/{conversation_id}/textdocs
   *
   * 這些不是 raw conversation JSON，但它們帶有目前 conversation ID，
   * 可以作為重新抓取 raw JSON 時的 request context 來源。
   */
  function getConversationIdFromScopedApiUrl(url) {
    try {
      const parsedUrl = new URL(url, location.origin);
      const match = parsedUrl.pathname.match(/^\/backend-api\/conversation\/([^/]+)(?:\/|$)/);
      if (!match) {
        return null;
      }
      const conversationId = decodeURIComponent(match[1]);
      return looksLikeUuid(conversationId) ? conversationId : null;
    } catch {
      return null;
    }
  }
  /*
   * 判斷是否為可用來建立請求樣板的 ChatGPT backend API 請求。
   *
   * 這個判斷刻意比 conversation endpoint 寬：
   *   - 新對話送出訊息時，不一定會打完整 conversation JSON endpoint。
   *   - 但只要有其他 /backend-api/... 請求，就可能帶有重新抓取 JSON 需要的 headers。
   *
   * 這裡只保存安全篩選後的 headers，不保存 body、cookie 或回應內容。
   */
  function isReusableBackendApiRequest(url) {
    try {
      const parsedUrl = new URL(url, location.origin);
      if (parsedUrl.origin !== location.origin) {
        return false;
      }
      if (!parsedUrl.pathname.startsWith('/backend-api/')) {
        return false;
      }
      /*
       * estuary/public_content 之類資產請求與匯出 conversation JSON 關聯較低，
       * 不拿來當 request template。
       */
      if (parsedUrl.pathname.includes('/public_content/')) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }
  /*
   * 從 fetch 的 input 參數中取出 URL。
   *
   * fetch 可能被呼叫成：
   *   fetch("...")
   *   fetch(new URL(...))
   *   fetch(new Request(...))
   */
  function getRequestUrl(input) {
    if (typeof input === 'string') {
      return input;
    }
    if (input instanceof URL) {
      return input.href;
    }
    if (input && typeof input.url === 'string') {
      return input.url;
    }
    return '';
  }
  /*
   * 將日期時間欄位補成兩位數。
   *
   * 主要用於檔名時間戳與 tooltip 顯示時間。
   */
  function pad2(value) {
    return String(value).padStart(2, '0');
  }
  /*
   * 產生檔名用時間戳。
   *
   * 格式：
   *   yyyyMMddHHmmss
   */
  function getTimestampString(date = new Date()) {
    return [
      date.getFullYear(),
      pad2(date.getMonth() + 1),
      pad2(date.getDate()),
      pad2(date.getHours()),
      pad2(date.getMinutes()),
      pad2(date.getSeconds())
    ].join('');
  }
  /*
   * tooltip 顯示用時間。
   */
  function getDisplayDateTime(date = new Date()) {
    return [
      `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`,
      `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
    ].join(' ');
  }
  /*
   * 將 Unix timestamp 轉成 UTC ISO 字串。
   *
   * 輸出使用 +00:00 後綴，讓時間格式更直觀。
   */
  function toUtcIsoString(date) {
    return date.toISOString().replace('Z', '+00:00');
  }
  /*
   * 正規化 ISO 時間字串。
   *
   * 目標是統一輸出毫秒 3 位與明確的 UTC offset，讓 handoff JSON 的時間格式穩定。
   */
  function normalizeIsoTimeString(value) {
    const stripped = String(value || '').trim();
    const match = stripped.match(
      /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/i
    );
    if (!match) {
      return stripped;
    }
    const base = match[1];
    const milliseconds = String(match[2] || '000').slice(0, 3).padEnd(3, '0');
    const offset = match[3].toUpperCase() === 'Z' ? '+00:00' : match[3];
    return `${base}.${milliseconds}${offset}`;
  }
  /*
   * 取得可排序的時間數值。
   *
   * 無法解析的時間會排到最後，避免影響已知建立時間的 textdocs 排序。
   */
  function getTimeSortValue(value) {
    const normalized = toReadableTime(value);
    if (!normalized) {
      return Number.POSITIVE_INFINITY;
    }
    const timestamp = Date.parse(normalized);
    return Number.isFinite(timestamp) ? timestamp : Number.POSITIVE_INFINITY;
  }
  /*
   * 將 conversation JSON 裡的時間值轉成可讀字串。
   *
   * 支援：
   *   - number：視為 Unix timestamp 秒數。
   *   - numeric string：同上。
   *   - 一般 string：原樣保留。
   */
  function toReadableTime(value) {
    if (value === null || value === undefined) {
      return null;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return toUtcIsoString(new Date(value * 1000));
    }
    if (typeof value === 'string') {
      const stripped = value.trim();
      if (!stripped) {
        return null;
      }
      if (/^[+-]?\d+(?:\.\d+)?$/.test(stripped)) {
        const numeric = Number(stripped);
        if (Number.isFinite(numeric)) {
          return toUtcIsoString(new Date(numeric * 1000));
        }
      }
      return normalizeIsoTimeString(stripped);
    }
    return null;
  }
  /*
   * 清理檔名片段。
   *
   * Windows 不允許的字元：
   *   \ / : * ? " < > |
   *
   * 另外也會移除控制字元、尾端句點與空白。
   */
  function sanitizeFilenamePart(value) {
    const sanitized = String(value || '')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, ' ')
      .replace(/[. ]+$/g, '')
      .trim()
      .slice(0, 120);
    return sanitized || 'chatgpt-conversation';
  }
  /*
   * 從 conversation 物件取得標題。
   */
  function getConversationTitle(conversation, fallback = 'chatgpt-conversation') {
    if (conversation && typeof conversation.title === 'string' && conversation.title.trim()) {
      return conversation.title.trim();
    }
    return fallback;
  }
  /*
   * 清理瀏覽器 document.title。
   *
   * 僅移除明確以空白分隔的 ChatGPT 品牌前綴或後綴，例如：
   *   ChatGPT - My Title
   *   ChatGPT | My Title
   *   My Title - ChatGPT
   *
   * 不移除沒有空白分隔的標題，例如：
   *   ChatGPT-Conversation-Handoff-Exporter
   */
  function cleanBrowserTitle(value) {
    let title = String(value || '').trim();
    if (!title || /^chatgpt$/i.test(title)) {
      return '';
    }
    title = title
      .replace(/^ChatGPT\s+[-–—|]\s+/i, '')
      .replace(/\s+[-–—|]\s+ChatGPT$/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!title || /^chatgpt$/i.test(title)) {
      return '';
    }
    return title;
  }
  /*
   * CSS attribute selector 簡易跳脫。
   *
   * 用於查找目前對話在側邊欄中的連結文字。
   */
  function cssAttributeEscape(value) {
    return String(value || '')
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"');
  }
  /*
   * 從側邊欄或目前頁面連結取得 conversation 標題。
   *
   * 專案對話中 document.title 可能是專案名稱，而不是目前對話名稱；
   * 因此 tooltip 標題會優先使用連到目前 conversation ID 的頁面連結文字。
   */
  function getTitleFromConversationLink(conversationId) {
    if (!conversationId) {
      return '';
    }
    try {
      const escapedId = cssAttributeEscape(conversationId);
      const links = document.querySelectorAll(`a[href*="/c/${escapedId}"]`);
      for (const link of links) {
        const text = String(link.textContent || '')
          .replace(/\s+/g, ' ')
          .trim();
        if (
          text &&
          text.length <= 160 &&
          !/^ChatGPT$/i.test(text) &&
          !text.includes('下載原始 JSON') &&
          !text.includes('下載交接 JSON')
        ) {
          return text;
        }
      }
    } catch {
      // DOM 查找只是輔助，不成功也不影響匯出。
    }
    return '';
  }
  /*
   * 從已捕捉的 raw conversation JSON 取得對話標題。
   *
   * 這個來源通常比 document.title 更準，尤其是在 project 對話頁中。
   */
  function getTitleFromCapturedRawJson(conversationId) {
    const capture = capturedRawByConversationId.get(conversationId);
    if (!capture || !capture.rawText) {
      return '';
    }
    if (typeof capture.title === 'string' && capture.title.trim()) {
      return capture.title.trim();
    }
    try {
      const conversation = JSON.parse(capture.rawText);
      const title = getConversationTitle(conversation, '');
      capture.title = title;
      return title;
    } catch {
      return '';
    }
  }
  /*
   * tooltip 顯示用標題。
   *
   * 取值順序：
   *   1. 連到目前 conversation ID 的頁面連結文字
   *   2. 已捕捉 raw JSON 中的 title
   *   3. document.title
   *
   * 這樣可避免專案對話中 tooltip 誤顯示專案名稱。
   */
  function getKnownConversationTitle(conversationId) {
    const linkTitle = getTitleFromConversationLink(conversationId);
    if (linkTitle) {
      return linkTitle;
    }
    const capturedTitle = getTitleFromCapturedRawJson(conversationId);
    if (capturedTitle) {
      return capturedTitle;
    }
    return cleanBrowserTitle(document.title);
  }
  /*
   * 從 raw JSON 取得下載檔名用標題。
   *
   * 若 raw JSON 無法解析，退回 conversation ID，避免檔名產生流程中斷。
   */
  function tryGetTitleFromRawJson(rawText, conversationId) {
    try {
      const data = JSON.parse(rawText);
      return getConversationTitle(data, conversationId || 'chatgpt-conversation');
    } catch {
      return conversationId || 'chatgpt-conversation';
    }
  }
  /*
   * 建立 raw conversation JSON 的下載檔名。
   */
  function buildRawFilename(rawText, conversationId, timestamp = getTimestampString()) {
    const title = sanitizeFilenamePart(tryGetTitleFromRawJson(rawText, conversationId));
    return `${title}-${timestamp}.json`;
  }
  /*
   * 建立 textdocs 原始 JSON 的下載檔名。
   */
  function buildTextdocsFilename(rawText, conversationId, timestamp = getTimestampString()) {
    const title = sanitizeFilenamePart(tryGetTitleFromRawJson(rawText, conversationId));
    return `${title}-${timestamp}.textdocs.json`;
  }
  /*
   * 建立 handoff JSON 的下載檔名。
   */
  function buildHandoffFilename(rawText, conversationId, timestamp = getTimestampString()) {
    const title = sanitizeFilenamePart(tryGetTitleFromRawJson(rawText, conversationId));
    return `${title}-${timestamp}.handoff.json`;
  }
  /*
   * 下載文字檔。
   */
  function downloadTextFile(text, filename, mimeType = 'application/json;charset=utf-8') {
    const blob = new Blob([text], {
      type: mimeType
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }
  // ============================================================
  // 四、捕捉與重新抓取 ChatGPT 原始 conversation JSON
  // ============================================================
  /*
   * 不適合手動重用的 request headers。
   *
   * 這個集合固定不變，放在函式外可避免每次複製 headers 時重複建立 Set。
   */
  const FORBIDDEN_REPLAY_HEADERS = new Set([
    'accept-encoding',
    'access-control-request-headers',
    'access-control-request-method',
    'connection',
    'content-length',
    'cookie',
    'cookie2',
    'date',
    'expect',
    'host',
    'keep-alive',
    'origin',
    'permissions-policy',
    'priority',
    'referer',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    'user-agent',
    'via'
  ]);
  /*
   * 判斷哪些 header 適合重用。
   *
   * 不重用的 header 類型：
   *   - 瀏覽器禁止手動設定的 header。
   *   - cookie / user-agent / referer 等敏感或不必要 header。
   *   - sec-* 系列瀏覽器安全 header。
   *
   * cookie 不需要也不應該手動複製。
   * 重抓時會使用 credentials: 'include'，讓瀏覽器自行處理同源 cookie。
   */
  function shouldReplayHeader(name) {
    const lowerName = String(name || '').toLowerCase();
    if (!lowerName) {
      return false;
    }
    if (lowerName.startsWith('sec-')) {
      return false;
    }
    return !FORBIDDEN_REPLAY_HEADERS.has(lowerName);
  }
  /*
   * 複製可安全重用的 request headers。
   *
   * 這裡會套用 shouldReplayHeader()，避免手動保存 cookie 或瀏覽器管理的安全 headers。
   */
  function copyHeadersFrom(headersLike, targetHeaders) {
    if (!headersLike) {
      return;
    }
    try {
      const sourceHeaders = new Headers(headersLike);
      sourceHeaders.forEach((value, key) => {
        if (shouldReplayHeader(key)) {
          targetHeaders.set(key, value);
        }
      });
    } catch {
      // 某些非標準 headers 物件可能無法被 Headers 建構式處理，忽略即可。
    }
  }
  /*
   * 從原始 fetch 呼叫中取出可安全重用的 headers。
   */
  function getReplayHeaders(input, init) {
    const headers = new Headers();
    if (input && typeof input === 'object' && 'headers' in input) {
      copyHeadersFrom(input.headers, headers);
    }
    if (init && init.headers) {
      copyHeadersFrom(init.headers, headers);
    }
    if (!headers.has('accept')) {
      headers.set('accept', 'application/json');
    }
    return headers;
  }
  /*
   * 判斷 headers 是否足以作為重新抓取 ChatGPT backend API 的樣板。
   *
   * 缺少必要驗證資訊時不保存，避免之後用不完整的 request context 發出無效請求。
   */
  function hasReusableAuthHeaders(headers) {
    return headers.has('authorization') && headers.has('x-oai-is');
  }
  /*
   * 保存最近一次 backend API 請求樣板。
   *
   * 這個樣板只在使用者按下匯出按鈕時使用，
   * 用來補足目前對話尚未產生專屬 raw JSON request context 的情況。
   */
  function captureReplayTemplate(input, init) {
    const headers = getReplayHeaders(input, init);
    if (!hasReusableAuthHeaders(headers)) {
      return;
    }
    latestReplayRequestTemplate = {
      headers,
      capturedAt: Date.now()
    };
  }
  /*
   * 記住某個 conversation_id 的重抓請求資訊。
   */
  function captureReplayRequest(conversationId, input, init) {
    if (!conversationId) {
      return;
    }
    const requestUrl = getRequestUrl(input);
    if (!requestUrl) {
      return;
    }
    const headers = getReplayHeaders(input, init);
    if (!hasReusableAuthHeaders(headers)) {
      return;
    }
    const replayRequest = {
      url: new URL(requestUrl, location.origin).href,
      headers,
      capturedAt: Date.now()
    };
    replayRequestByConversationId.set(conversationId, replayRequest);
    latestReplayRequestTemplate = {
      headers: new Headers(replayRequest.headers),
      capturedAt: replayRequest.capturedAt
    };
  }
  /*
   * 把 raw JSON 暫存到記憶體。
   *
   * title 會一併快取，避免 tooltip 更新時重複解析大型 raw JSON。
   */
  function rememberRawConversation(conversationId, rawText, conversation = null) {
    const title = conversation ? getConversationTitle(conversation, '') : '';
    capturedRawByConversationId.set(conversationId, {
      rawText,
      capturedAt: Date.now(),
      title
    });
    logInfo('已捕捉 conversation JSON。', {
      conversationId,
      length: rawText.length
    });
    ensureButtonsSoon();
  }
  /*
   * 快速判斷一段文字是否像完整 conversation JSON。
   *
   * 只接受包含：
   *   - mapping
   *   - current_node
   *
   * 的 JSON 物件。
   */
  function looksLikeConversationObject(rawText) {
    const trimmed = String(rawText || '').trim();
    if (!trimmed.startsWith('{')) {
      return false;
    }
    try {
      const data = JSON.parse(trimmed);
      return Boolean(
        data &&
        typeof data === 'object' &&
        typeof data.mapping === 'object' &&
        typeof data.current_node === 'string'
      );
    } catch {
      return false;
    }
  }
  /*
   * 解析並驗證 raw conversation JSON。
   *
   * 這裡會比對：
   *   目前網址上的 conversation ID
   *   raw JSON 內的 conversation_id
   *
   * 若不一致就停止下載，避免 SPA 切換對話時誤抓上一個對話。
   */
  function parseAndValidateRawConversation(rawText, expectedConversationId) {
    let conversation;
    try {
      conversation = JSON.parse(rawText);
    } catch (error) {
      throw new Error(`raw JSON 解析失敗：${toErrorMessage(error)}`);
    }
    if (!conversation || typeof conversation !== 'object' || Array.isArray(conversation)) {
      throw new Error('raw JSON 不是有效的 conversation 物件。');
    }
    if (!conversation.mapping || typeof conversation.mapping !== 'object' || Array.isArray(conversation.mapping)) {
      throw new Error('raw JSON 不包含有效的 mapping 物件。');
    }
    if (typeof conversation.current_node !== 'string' || !conversation.current_node) {
      throw new Error('raw JSON 不包含有效的 current_node。');
    }
    if (typeof conversation.conversation_id !== 'string' || !conversation.conversation_id) {
      throw new Error('raw JSON 不包含有效的 conversation_id。');
    }
    if (expectedConversationId && conversation.conversation_id !== expectedConversationId) {
      throw new Error(
        '下載中止：目前網址的 conversation ID 與 raw JSON 內的 conversation_id 不一致。\n\n' +
        `目前網址 ID：${expectedConversationId}\n` +
        `raw JSON ID：${conversation.conversation_id}\n\n` +
        '這通常表示頁面剛切換對話，或捕捉到上一段對話資料。\n' +
        '建議：確認目前仍停留在要匯出的對話，等待內容載入完成後再按一次。'
      );
    }
    return conversation;
  }
  /*
   * 從 ChatGPT 自己成功取得的 response 複製一份 raw JSON。
   *
   * 使用 response.clone() 的理由：
   *   原頁面仍要使用原本 response。
   *   clone 後讀取副本，不會破壞 ChatGPT 本身的流程。
   */
  function captureConversationResponse(conversationId, response) {
    if (!conversationId || !response || !response.ok) {
      return;
    }
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      return;
    }
    const clonedResponse = response.clone();
    window.setTimeout(() => {
      clonedResponse
        .text()
        .then((rawText) => {
          if (!looksLikeConversationObject(rawText)) {
            return;
          }
          let conversation;
          try {
            conversation = parseAndValidateRawConversation(rawText, conversationId);
          } catch {
            return;
          }
          rememberRawConversation(conversationId, rawText, conversation);
        })
        .catch((error) => {
          logWarn('捕捉 conversation JSON 失敗。', {
            message: toErrorMessage(error)
          });
        });
    }, 0);
  }
  /*
   * 包裝 window.fetch。
   *
   * 用途：
   *   - 觀察 ChatGPT 頁面自己發出的 conversation JSON 請求。
   *   - 記住可重抓的請求資訊。
   *   - 捕捉成功回應的 raw JSON。
   *
   * 這裡不會：
   *   - 修改 ChatGPT 的請求內容。
   *   - 阻擋原始請求。
   *   - 把敏感資訊印出來。
   */
  function installFetchInterceptor() {
    const originalFetch = window.fetch;
    if (typeof originalFetch !== 'function') {
      return;
    }
    if (originalFetch.__chatgptConversationHandoffExporterWrapped) {
      return;
    }
    function interceptedFetch(input, init) {
      const requestUrl = getRequestUrl(input);
      const exactConversationId = getConversationIdFromExactApiUrl(requestUrl);
      const scopedConversationId = getConversationIdFromScopedApiUrl(requestUrl);
      if (isReusableBackendApiRequest(requestUrl)) {
        captureReplayTemplate(input, init);
      }
      if (scopedConversationId) {
        captureReplayRequest(scopedConversationId, input, init);
      }
      return originalFetch.apply(this, arguments).then((response) => {
        if (exactConversationId) {
          captureConversationResponse(exactConversationId, response);
        }
        return response;
      });
    }
    interceptedFetch.__chatgptConversationHandoffExporterWrapped = true;
    window.fetch = interceptedFetch;
  }
  /*
   * 建立目前 conversation ID 專用的 conversation endpoint。
   *
   * 只負責組出同源 URL；驗證資訊由先前捕捉到的 request context 與瀏覽器 cookie 處理。
   */
  function buildConversationApiUrl(conversationId) {
    return new URL(
      `/backend-api/conversation/${encodeURIComponent(conversationId)}`,
      location.origin
    ).href;
  }
  /*
   * 建立目前 conversation ID 專用的 textdocs endpoint。
   */
  function buildTextdocsApiUrl(conversationId) {
    return new URL(
      `/backend-api/conversation/${encodeURIComponent(conversationId)}/textdocs`,
      location.origin
    ).href;
  }
  /*
   * 將可重用 headers 調整成指定 ChatGPT backend endpoint 專用。
   *
   * 某些 ChatGPT backend 請求會帶有 x-openai-target-path /
   * x-openai-target-route 這類路由提示 header。
   *
   * 若直接重用其他 endpoint 的 request template，這些 header 可能仍指向
   * 原本的 API 路徑，導致實際請求 URL 與 target headers 不一致。
   *
   * 因此在按下匯出按鈕、準備抓目前資料時，需要把它們改成目標 endpoint。
   */
  function applyTargetHeaders(headers, targetPath, targetRoute) {
    headers.set('accept', 'application/json');
    headers.set('x-openai-target-path', targetPath);
    headers.set('x-openai-target-route', targetRoute);
    /*
     * GET 請求不需要 content-type。
     * 若 request template 來自 POST endpoint，留下 content-type 可能造成誤導。
     */
    headers.delete('content-type');
    return headers;
  }
  /*
   * 將重用 headers 調整為 conversation JSON endpoint 使用。
   */
  function applyConversationTargetHeaders(headers, conversationId) {
    const targetPath = `/backend-api/conversation/${encodeURIComponent(conversationId)}`;
    return applyTargetHeaders(
      headers,
      targetPath,
      '/backend-api/conversation/{conversation_id}'
    );
  }
  /*
   * 將重用 headers 調整為 textdocs endpoint 使用。
   */
  function applyTextdocsTargetHeaders(headers, conversationId) {
    const targetPath = `/backend-api/conversation/${encodeURIComponent(conversationId)}/textdocs`;
    return applyTargetHeaders(
      headers,
      targetPath,
      '/backend-api/conversation/{conversation_id}/textdocs'
    );
  }
  /*
   * 取得目前 conversation ID 可用的重抓請求資訊。
   *
   * 優先使用此 conversation ID 專屬 request context。
   * 若沒有，改用最近一次 ChatGPT backend API 請求樣板。
   *
   * 回傳的 headers 會被調整為 conversation endpoint 專用，避免重用其他 API 的 target headers。
   * 這個函式只在使用者按下匯出按鈕後的抓取流程中使用。
   */
  function getReplayRequestForConversation(conversationId) {
    const replayRequest = replayRequestByConversationId.get(conversationId);
    if (replayRequest) {
      return {
        url: buildConversationApiUrl(conversationId),
        headers: applyConversationTargetHeaders(new Headers(replayRequest.headers), conversationId),
        capturedAt: replayRequest.capturedAt
      };
    }
    if (!latestReplayRequestTemplate) {
      return null;
    }
    return {
      url: buildConversationApiUrl(conversationId),
      headers: applyConversationTargetHeaders(new Headers(latestReplayRequestTemplate.headers), conversationId),
      capturedAt: latestReplayRequestTemplate.capturedAt
    };
  }
  /*
   * 取得目前 conversation ID 的 textdocs endpoint 請求資訊。
   *
   * textdocs 使用同一套 request context，但 target path / route 必須改成
   * /backend-api/conversation/{conversation_id}/textdocs。
   *
   * 如果沒有可重用 context，呼叫端會把 textdocs 視為不可取得，而不是中斷主要匯出。
   */
  function getReplayRequestForTextdocs(conversationId) {
    const replayRequest = replayRequestByConversationId.get(conversationId);
    if (replayRequest) {
      return {
        url: buildTextdocsApiUrl(conversationId),
        headers: applyTextdocsTargetHeaders(new Headers(replayRequest.headers), conversationId),
        capturedAt: replayRequest.capturedAt
      };
    }
    if (!latestReplayRequestTemplate) {
      return null;
    }
    return {
      url: buildTextdocsApiUrl(conversationId),
      headers: applyTextdocsTargetHeaders(new Headers(latestReplayRequestTemplate.headers), conversationId),
      capturedAt: latestReplayRequestTemplate.capturedAt
    };
  }
  /*
   * 使用先前捕捉的 request context 即時重新抓最新 raw JSON。
   *
   * 這可避免使用者新增 / 編輯訊息後必須手動重新整理頁面。
   */
  async function refetchLatestConversationRaw(conversationId) {
    const replayRequest = getReplayRequestForConversation(conversationId);
    if (!replayRequest) {
      throw new Error(buildMissingRequestContextMessage('conversation JSON'));
    }
    replayRequestByConversationId.set(conversationId, replayRequest);
    const response = await fetch(replayRequest.url, {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
      headers: new Headers(replayRequest.headers)
    });
    if (!response.ok) {
      throw new Error(
        `即時重新抓取 conversation JSON 失敗：HTTP ${response.status} ${response.statusText || ''}\n\n` +
        getHttpStatusSuggestion(response.status)
      );
    }
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      throw new Error(
        '即時重新抓取 conversation JSON 失敗：回應不是 JSON。\n\n' +
        `Content-Type: ${contentType || '未知'}\n\n` +
        '建議：重新整理頁面並確認對話已正常載入。若仍持續發生，可能是 ChatGPT 前端或內部 endpoint 格式已變更。'
      );
    }
    const rawText = await response.text();
    if (!looksLikeConversationObject(rawText)) {
      throw new Error(
        '即時重新抓取 conversation JSON 失敗：回應不是完整 conversation JSON 物件。\n\n' +
        `內容長度：${rawText ? rawText.length : 0}\n\n` +
        '建議：確認目前頁面是完整對話頁，等待載入完成後再試；若仍失敗，請重新整理或稍後再試。'
      );
    }
    const conversation = parseAndValidateRawConversation(rawText, conversationId);
    rememberRawConversation(conversationId, rawText, conversation);
    return rawText;
  }
  /*
   * 判斷值是否為一般物件。
   *
   * textdocs endpoint 可能回傳不同外層格式，因此需要先排除 null 與陣列。
   */
  function isObjectRecord(value) {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
  }
  /*
   * 從 textdocs endpoint 回應中取出 textdocs 陣列。
   *
   * 目前支援直接回傳陣列，也支援包在 textdocs、items、data、documents 欄位中的陣列。
   */
  function getTextdocsArrayFromParsedJson(parsed) {
    if (Array.isArray(parsed)) {
      return parsed;
    }
    if (!isObjectRecord(parsed)) {
      return [];
    }
    const candidateKeys = ['textdocs', 'items', 'data', 'documents'];
    for (const key of candidateKeys) {
      if (Array.isArray(parsed[key])) {
        return parsed[key];
      }
    }
    return [];
  }
  /*
   * 正規化單一 textdoc comment。
   *
   * 缺少位置或內容時使用 null / 空字串，避免因部分欄位缺失導致整體匯出失敗。
   */
  function normalizeTextdocComment(comment) {
    if (!isObjectRecord(comment)) {
      return null;
    }
    return {
      ...comment,
      content: typeof comment.content === 'string' ? comment.content : ''
    };
  }
  /*
   * 正規化單一 textdoc。
   *
   * textdocs endpoint 格式若有小幅變動，這裡會盡量轉成 handoff builder 可處理的穩定形狀。
   */
  function normalizeTextdoc(textdoc, index) {
    if (!isObjectRecord(textdoc)) {
      logWarn('略過格式不支援的 textdoc 項目。', {
        index: index + 1
      });
      return null;
    }
    const normalized = {
      ...textdoc,
      id: typeof textdoc.id === 'string' && textdoc.id.trim() ? textdoc.id : null,
      content: typeof textdoc.content === 'string' ? textdoc.content : ''
    };
    if (!Array.isArray(textdoc.comments)) {
      normalized.comments = [];
      return normalized;
    }
    normalized.comments = textdoc.comments
      .map(normalizeTextdocComment)
      .filter(Boolean);
    return normalized;
  }
  /*
   * 解析 textdocs 原始 JSON，並轉成可用的 textdocs 陣列。
   *
   * 這裡採寬鬆策略：能保留的項目盡量保留，無法辨識的項目略過。
   */
  function parseAndValidateTextdocsRaw(rawText) {
    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (error) {
      throw new Error(`textdocs JSON 解析失敗：${toErrorMessage(error)}`);
    }
    const textdocs = getTextdocsArrayFromParsedJson(parsed);
    return textdocs
      .map(normalizeTextdoc)
      .filter(Boolean);
  }
  /*
   * textdocs 取得或解析失敗時的共同退路。
   *
   * textdocs 是附加資料；失敗時改用空陣列，避免阻斷主要對話匯出。
   */
  function warnAndReturnEmptyTextdocs(message, data = null) {
    logWarn(message, data);
    return '[]';
  }
  /*
   * 即時抓取目前對話的 textdocs JSON。
   *
   * textdocs 是附加資料，不應阻斷主要對話匯出。
   * 因此 204、205、404、空回應、非 JSON 或解析失敗都會轉成空陣列。
   */
  async function refetchTextdocsRaw(conversationId) {
    const replayRequest = getReplayRequestForTextdocs(conversationId);
    if (!replayRequest) {
      return warnAndReturnEmptyTextdocs(
        '目前無法取得此對話的 textdocs 請求資訊，改以空 textdocs 繼續。',
        { conversationId }
      );
    }
    let response;
    try {
      response = await fetch(replayRequest.url, {
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
        headers: new Headers(replayRequest.headers)
      });
    } catch (error) {
      return warnAndReturnEmptyTextdocs('即時重新抓取 textdocs 失敗，改以空 textdocs 繼續。', {
        conversationId,
        message: toErrorMessage(error)
      });
    }
    if (response.status === 204 || response.status === 205 || response.status === 404) {
      return '[]';
    }
    if (!response.ok) {
      return warnAndReturnEmptyTextdocs('textdocs endpoint 回應非成功狀態，改以空 textdocs 繼續。', {
        conversationId,
        status: response.status,
        statusText: response.statusText || ''
      });
    }
    const rawText = await response.text();
    if (!rawText.trim()) {
      return '[]';
    }
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      return warnAndReturnEmptyTextdocs('textdocs endpoint 回應不是 JSON，改以空 textdocs 繼續。', {
        conversationId,
        contentType: contentType || '未知'
      });
    }
    try {
      parseAndValidateTextdocsRaw(rawText);
    } catch (error) {
      return warnAndReturnEmptyTextdocs('textdocs JSON 格式無法使用，改以空 textdocs 繼續。', {
        conversationId,
        message: toErrorMessage(error)
      });
    }
    return rawText;
  }
  /*
   * 取得最新 raw JSON。
   *
   * 優先順序：
   *   1. 若已捕捉到可重抓 request context，直接重新抓取最新資料。
   *   2. 否則使用已捕捉的 raw JSON。
   */
  async function getLatestRawText(conversationId) {
    const replayRequest = replayRequestByConversationId.get(conversationId);
    const capture = capturedRawByConversationId.get(conversationId);
    if (replayRequest) {
      return refetchLatestConversationRaw(conversationId);
    }
    if (capture) {
      parseAndValidateRawConversation(capture.rawText, conversationId);
      return capture.rawText;
    }
    throw new Error(
      '目前無法取得此對話的 JSON 請求資訊。\n\n' +
      '請確認對話內容已載入完成，或重新進入此對話頁後再試一次。'
    );
  }
  /*
   * 取得目前對話的 raw JSON 與已驗證 conversation 物件。
   *
   * 匯出流程會先通過這個 helper，避免 raw JSON 取得、解析與 ID 驗證邏輯
   * 分散在不同 click handler 中。
   */
  async function getLatestConversationSnapshot(conversationId) {
    const rawText = await getLatestRawText(conversationId);
    const conversation = parseAndValidateRawConversation(rawText, conversationId);

    return {
      rawText,
      conversation
    };
  }
  /*
   * 取得目前對話的 textdocs 陣列。
   *
   * textdocs 是附加資料，因此這個 helper 採容錯策略：
   * 若 endpoint 無法取得、回應格式異常或解析失敗，會回傳空陣列，
   * 讓 raw JSON 與 handoff 主體仍可完成匯出。
   */
  async function getLatestTextdocs(conversationId) {
    try {
      const textdocsRawText = await refetchTextdocsRaw(conversationId);
      return parseAndValidateTextdocsRaw(textdocsRawText);
    } catch (error) {
      logWarn('textdocs 解析失敗，改以空 textdocs 繼續。', {
        conversationId,
        message: toErrorMessage(error)
      });
      return [];
    }
  }
  /*
   * 下載已驗證的 raw conversation JSON。
   *
   * 這裡只負責格式化與下載，不重新解析或重抓資料。
   */
  function downloadRawConversation({ rawText, conversation }, conversationId, exportTimestamp) {
    const prettyRawText = JSON.stringify(conversation, null, 4);
    const filename = buildRawFilename(rawText, conversationId, exportTimestamp);

    downloadTextFile(prettyRawText, filename);
  }
  /*
   * 若目前對話有 textdocs，下載正規化後的 textdocs JSON。
   *
   * 沒有 textdocs 時不下載額外檔案，避免產生無意義的空 JSON 檔。
   */
  function downloadTextdocsIfPresent(textdocs, rawText, conversationId, exportTimestamp) {
    if (!Array.isArray(textdocs) || textdocs.length === 0) {
      return;
    }

    const prettyTextdocsText = JSON.stringify(textdocs, null, 4);
    const textdocsFilename = buildTextdocsFilename(rawText, conversationId, exportTimestamp);

    downloadTextFile(prettyTextdocsText, textdocsFilename);
  }
  /*
   * 建立 handoff JSON 下載內容。
   *
   * 這個 helper 只處理 handoff 轉換、結果檢查與序列化，
   * 實際下載由上層流程負責，方便在下載前更新 UI 進度文字。
   */
  function buildHandoffDownloadPayload({ rawText, conversation }, textdocs, conversationId, exportTimestamp) {
    const handoff = buildHandoff(conversation, textdocs);
    validateHandoffOrThrow(handoff, conversation);

    return {
      text: JSON.stringify(handoff, null, 4),
      filename: buildHandoffFilename(rawText, conversationId, exportTimestamp)
    };
  }
  /*
   * 下載已建立好的 handoff JSON。
   */
  function downloadHandoffPayload({ text, filename }) {
    downloadTextFile(text, filename);
  }
  /*
   * 取得目前頁面的 conversation 狀態。
   */
  function getCurrentState() {
    const conversationId = getConversationIdFromUrl();
    if (!conversationId) {
      return {
        conversationId: null,
        capture: null,
        replayRequest: null
      };
    }
    return {
      conversationId,
      capture: capturedRawByConversationId.get(conversationId) || null,
      replayRequest: replayRequestByConversationId.get(conversationId) || null
    };
  }
  // ============================================================
  // 五、handoff JSON 轉換邏輯
  // ============================================================
  /*
   * 將 ChatGPT content.parts 中的文字片段合併。
   *
   * 會排除：
   *   - image_asset_pointer
   *   - asset_pointer
   *
   * 避免把圖片 / 檔案資產指標塞進 handoff content。
   */
  function flattenTextLikeParts(parts) {
    if (!Array.isArray(parts)) {
      return '';
    }
    const texts = [];
    for (const part of parts) {
      if (typeof part === 'string') {
        if (part.trim()) {
          texts.push(part);
        }
        continue;
      }
      if (!part || typeof part !== 'object') {
        continue;
      }
      const partContentType = part.content_type;
      if (partContentType === 'image_asset_pointer' || partContentType === 'asset_pointer') {
        continue;
      }
      if (typeof part.text === 'string' && part.text.trim()) {
        texts.push(part.text);
        continue;
      }
      if (typeof part.content === 'string' && part.content.trim()) {
        texts.push(part.content);
        continue;
      }
    }
    return texts.join('\n');
  }
  /*
   * 將 ChatGPT message.content 正規化成純文字。
   */
  function normalizeContentToText(content, role) {
    if (!content || typeof content !== 'object') {
      if (typeof content === 'string' && content.trim()) {
        return content.trim();
      }
      return null;
    }
    const contentType = content.content_type;
    if (EXCLUDED_CONTENT_TYPES.has(contentType)) {
      return null;
    }
    /*
     * assistant 的 code / execution_output / tether_browsing_display
     * 通常是工具呼叫、中間輸出或瀏覽工具顯示資料。
     */
    if (
      role === 'assistant' &&
      ['code', 'execution_output', 'tether_browsing_display'].includes(contentType)
    ) {
      return null;
    }
    if (contentType === 'text' || contentType === 'multimodal_text') {
      const text = flattenTextLikeParts(content.parts);
      return text.trim() || null;
    }
    if (contentType === 'code' || contentType === 'execution_output') {
      if (typeof content.text === 'string' && content.text.trim()) {
        return content.text.trim();
      }
      return null;
    }
    if (contentType === 'tether_browsing_display') {
      if (typeof content.summary === 'string' && content.summary.trim()) {
        return content.summary.trim();
      }
      return null;
    }
    return null;
  }
  /*
   * 移除 ChatGPT 內嵌引用標記。
   */
  function removeInlineMarks(text) {
    return String(text || '')
      .replace(INLINE_MARK_PATTERN, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
  /*
   * 判斷 assistant 訊息是否送往工具 recipient。
   *
   * 真正顯示給使用者看的 assistant 訊息通常會送往 all；
   * canmore.create_textdoc、canmore.update_textdoc、web.run 等 recipient
   * 代表這則訊息是工具呼叫，不應輸出到 handoff messages。
   */
  function hasAssistantToolRecipient(message) {
    const recipient = message && typeof message.recipient === 'string'
      ? message.recipient.trim()
      : '';

    return Boolean(recipient && recipient !== 'all');
  }

  /*
   * 判斷 JSON 物件是否像 canmore / textdoc 工具 payload。
   *
   * 這裡只檢查整段 assistant 內容能被解析成 JSON 物件的情況，
   * 避免誤刪一般回覆中夾帶的 JSON 範例。
   */
  function looksLikeCanmoreToolPayloadObject(value) {
    if (!isObjectRecord(value)) {
      return false;
    }

    if (Array.isArray(value.updates) || Array.isArray(value.comments)) {
      return true;
    }

    if (
      typeof value.name === 'string' &&
      typeof value.type === 'string' &&
      typeof value.content === 'string'
    ) {
      return value.type === 'document' || value.type.startsWith('code/');
    }

    return false;
  }

  /*
   * 判斷 assistant 文字內容是否像工具操作 payload。
   *
   * 這類內容不是給使用者閱讀的自然語言回覆，因此不輸出到 handoff。
   */
  function looksLikeAssistantToolOperation(text) {
    const stripped = String(text || '').trim();

    if (!stripped) {
      return false;
    }

    if (ASSISTANT_TOOL_OPERATION_PATTERN.test(stripped)) {
      return true;
    }

    if (!stripped.startsWith('{') || !stripped.endsWith('}')) {
      return false;
    }

    try {
      return looksLikeCanmoreToolPayloadObject(JSON.parse(stripped));
    } catch {
      return false;
    }
  }
  /*
   * 引用來源 attribution 可能是字串，也可能是物件。
   */
  function normalizeAttribution(attribution) {
    if (attribution && typeof attribution === 'object') {
      return attribution.name || attribution.display_name || attribution.url || null;
    }
    return typeof attribution === 'string' && attribution.trim() ? attribution : null;
  }
  /*
   * 從 citation metadata 建立 handoff 用的引用來源物件。
   *
   * 僅保留 URL、標題、摘要、發布時間與歸屬資訊。
   */
  function buildCiteSource(source) {
    const rawPubDate =
      typeof source.pub_date === 'string' && source.pub_date.trim()
        ? source.pub_date
        : typeof source.published_at === 'string' && source.published_at.trim()
          ? source.published_at
          : source.time;
    return {
      url: typeof source.url === 'string' ? source.url : null,
      title: typeof source.title === 'string' ? source.title : null,
      snippet: typeof source.snippet === 'string' ? source.snippet : null,
      pub_date: toReadableTime(rawPubDate),
      attribution: normalizeAttribution(source.attribution)
    };
  }
  /*
   * 建立引用來源去重用 key。
   *
   * 優先用 URL；若沒有 URL，改用其他欄位組合降低重複輸出。
   */
  function citeSourceKey(source) {
    return JSON.stringify([
      source.url,
      source.title,
      source.snippet,
      source.pub_date,
      source.attribution
    ]);
  }
  /*
   * 去除重複引用來源。
   */
  function dedupeCiteSources(values) {
    const result = [];
    const seen = new Set();
    for (const value of values) {
      if (!value || typeof value !== 'object') {
        continue;
      }
      const normalized = {
        url: typeof value.url === 'string' && value.url.trim() ? value.url : null,
        title: typeof value.title === 'string' && value.title.trim() ? value.title : null,
        snippet: typeof value.snippet === 'string' && value.snippet.trim() ? value.snippet : null,
        pub_date: toReadableTime(value.pub_date),
        attribution:
          typeof value.attribution === 'string' && value.attribution.trim()
            ? value.attribution
            : null
      };
      if (
        normalized.url === null &&
        normalized.title === null &&
        normalized.snippet === null &&
        normalized.pub_date === null &&
        normalized.attribution === null
      ) {
        continue;
      }
      const key = citeSourceKey(normalized);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      result.push(normalized);
    }
    return result;
  }
  /*
   * 從 assistant 訊息 metadata 中抽出引用來源。
   *
   * 支援多種可能位置：
   *   - metadata.content_references[].items
   *   - metadata.content_references[].safe_urls
   *   - metadata.search_result_groups[].entries
   *   - metadata.citations
   *   - metadata.safe_urls
   */
  function extractAssistantCiteSources(message) {
    const metadata = message && typeof message.metadata === 'object' ? message.metadata : null;
    if (!metadata) {
      return [];
    }
    const sources = [];
    if (Array.isArray(metadata.content_references)) {
      for (const ref of metadata.content_references) {
        if (!ref || typeof ref !== 'object') {
          continue;
        }
        if (Array.isArray(ref.items)) {
          for (const item of ref.items) {
            if (item && typeof item === 'object') {
              sources.push(buildCiteSource(item));
            }
          }
        }
        if (Array.isArray(ref.safe_urls)) {
          for (const url of ref.safe_urls) {
            if (typeof url === 'string') {
              sources.push(buildCiteSource({ url }));
            }
          }
        }
      }
    }
    if (Array.isArray(metadata.search_result_groups)) {
      for (const group of metadata.search_result_groups) {
        if (!group || typeof group !== 'object' || !Array.isArray(group.entries)) {
          continue;
        }
        for (const entry of group.entries) {
          if (entry && typeof entry === 'object') {
            sources.push(buildCiteSource(entry));
          }
        }
      }
    }
    if (Array.isArray(metadata.citations)) {
      for (const citation of metadata.citations) {
        if (citation && typeof citation === 'object') {
          sources.push(buildCiteSource(citation));
        }
      }
    }
    if (Array.isArray(metadata.safe_urls)) {
      for (const url of metadata.safe_urls) {
        if (typeof url === 'string') {
          sources.push(buildCiteSource({ url }));
        }
      }
    }
    return dedupeCiteSources(sources);
  }
  /*
   * 取得 conversation mapping。
   *
   * mapping 是 ChatGPT 對話樹的核心資料，後續會用 current_node 回推主分支。
   */
  function getMapping(conversation) {
    const mapping = conversation.mapping;
    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
      throw new Error('conversation JSON 不包含有效的 mapping 物件。');
    }
    return mapping;
  }
  /*
   * ChatGPT 原始 conversation JSON 是樹狀結構。
   *
   * current_node 表示目前 UI 採用的最後節點。
   * 沿 parent 一路往上追，即可取得目前主分支。
   */
  function resolveMainPath(mapping, currentNode) {
    if (!currentNode) {
      return [];
    }
    const path = [];
    const seen = new Set();
    let nodeId = currentNode;
    while (nodeId) {
      if (seen.has(nodeId)) {
        throw new Error(`偵測到循環 parent chain：${nodeId}`);
      }
      seen.add(nodeId);
      path.push(nodeId);
      const node = mapping[nodeId];
      if (!node || typeof node !== 'object') {
        break;
      }
      nodeId = typeof node.parent === 'string' && node.parent ? node.parent : null;
    }
    path.reverse();
    return path;
  }
  /*
   * 從一個 mapping node 中抽出 handoff message。
   */
  function extractMessageItem(node) {
    const message = node && typeof node.message === 'object' ? node.message : null;
    if (!message) {
      return null;
    }
    const author = message.author && typeof message.author === 'object' ? message.author : null;
    if (!author) {
      return null;
    }
    const role = author.role;
    if (!ALLOWED_ROLES.has(role)) {
      return null;
    }
    if (role === 'assistant' && hasAssistantToolRecipient(message)) {
      return null;
    }
    const metadata = message.metadata && typeof message.metadata === 'object' ? message.metadata : null;
    if (metadata && metadata.is_visually_hidden_from_conversation === true) {
      return null;
    }
    const text = normalizeContentToText(message.content, role);
    if (!text) {
      return null;
    }
    const item = {
      role,
      content: text
    };
    if (role === 'assistant') {
      item.content = removeInlineMarks(text);
      if (!item.content) {
        return null;
      }
      if (looksLikeAssistantToolOperation(item.content)) {
        return null;
      }
      const citeSources = extractAssistantCiteSources(message);
      if (citeSources.length > 0) {
        item.cite_sources = citeSources;
      }
    }
    return item;
  }
  /*
   * 根據 comment start / end 取出對應的畫布文字片段。
   *
   * 如果位置資訊無效，回傳 null，避免產生錯誤的 target_text。
   */
  function getTextdocCommentTargetText(textdocContent, start, end) {
    if (
      typeof textdocContent !== 'string' ||
      typeof start !== 'number' ||
      typeof end !== 'number' ||
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      end < start ||
      end > textdocContent.length
    ) {
      return null;
    }
    return textdocContent.slice(start, end);
  }
  /*
   * 從 canvas tool message 判斷 canmore 指令名稱。
   *
   * 優先讀 metadata.command；若沒有，再從 author.name 的 canmore.* 格式推得。
   */
  function getCanvasCommand(message) {
    const metadata = message && typeof message.metadata === 'object' ? message.metadata : null;
    if (metadata && typeof metadata.command === 'string' && metadata.command.trim()) {
      return metadata.command.trim();
    }
    const author = message && typeof message.author === 'object' ? message.author : null;
    if (author && typeof author.name === 'string' && author.name.startsWith('canmore.')) {
      return author.name.slice('canmore.'.length);
    }
    return null;
  }
  /*
   * 從 raw conversation JSON 中整理畫布生命週期資訊。
   *
   * 這裡只整理對 handoff 有幫助的摘要：
   *   - 建立時間
   *   - 建立來源
   *   - 建立版本
   *   - 更新次數
   *   - 加註解事件次數
   *   - 最後一次 canvas tool event 時間
   *
   * 不輸出 request_id、turn_exchange_id、async_source 等內部追蹤欄位。
   */
  function extractTextdocLifecycle(conversation, pathNodeIds) {
    const mapping = getMapping(conversation);
    const lifecycleById = new Map();
    for (const nodeId of pathNodeIds) {
      const node = mapping[nodeId];
      if (!node || typeof node !== 'object') {
        continue;
      }
      const message = node.message && typeof node.message === 'object' ? node.message : null;
      const metadata = message && typeof message.metadata === 'object' ? message.metadata : null;
      const canvas = metadata && typeof metadata.canvas === 'object' ? metadata.canvas : null;
      if (!canvas || typeof canvas.textdoc_id !== 'string' || !canvas.textdoc_id) {
        continue;
      }
      const textdocId = canvas.textdoc_id;
      const command = getCanvasCommand(message);
      const eventTime = toReadableTime(message.create_time);
      const eventTimeValue =
        typeof message.create_time === 'number' && Number.isFinite(message.create_time)
          ? message.create_time
          : null;
      let lifecycle = lifecycleById.get(textdocId);
      if (!lifecycle) {
        lifecycle = {
          created_at: null,
          create_source: null,
          created_version: null,
          latest_observed_version: null,
          update_count: 0,
          comment_event_count: 0,
          last_canvas_event_at: null,
          last_canvas_event_time_value: null
        };
        lifecycleById.set(textdocId, lifecycle);
      }
      if (Number.isFinite(canvas.version)) {
        lifecycle.latest_observed_version =
          lifecycle.latest_observed_version === null
            ? canvas.version
            : Math.max(lifecycle.latest_observed_version, canvas.version);
      }
      if (
        eventTime &&
        (
          lifecycle.last_canvas_event_time_value === null ||
          eventTimeValue === null ||
          eventTimeValue >= lifecycle.last_canvas_event_time_value
        )
      ) {
        lifecycle.last_canvas_event_at = eventTime;
        if (eventTimeValue !== null) {
          lifecycle.last_canvas_event_time_value = eventTimeValue;
        }
      }
      if (command === 'create_textdoc') {
        if (!lifecycle.created_at && eventTime) {
          lifecycle.created_at = eventTime;
        }
        if (typeof canvas.create_source === 'string' && canvas.create_source.trim()) {
          lifecycle.create_source = canvas.create_source;
        }
        if (Number.isFinite(canvas.version)) {
          lifecycle.created_version = canvas.version;
        }
      } else if (command === 'update_textdoc') {
        lifecycle.update_count += 1;
      } else if (command === 'comment_textdoc') {
        lifecycle.comment_event_count += 1;
      }
    }
    return lifecycleById;
  }
  /*
   * 建立單一 textdoc 的生命週期摘要。
   *
   * 只輸出對接續對話有幫助的統計資訊，不輸出內部追蹤欄位。
   */
  function buildTextdocLifecycleSummary(textdoc, lifecycle) {
    const summary = {};
    if (Number.isFinite(textdoc.version)) {
      summary.latest_version = textdoc.version;
    } else if (lifecycle && Number.isFinite(lifecycle.latest_observed_version)) {
      summary.latest_version = lifecycle.latest_observed_version;
    }
    if (lifecycle && Number.isFinite(lifecycle.created_version)) {
      summary.created_version = lifecycle.created_version;
    }
    if (lifecycle && lifecycle.update_count > 0) {
      summary.update_count = lifecycle.update_count;
    }
    if (lifecycle && lifecycle.comment_event_count > 0) {
      summary.comment_event_count = lifecycle.comment_event_count;
    }
    if (lifecycle && lifecycle.last_canvas_event_at) {
      summary.last_canvas_event_at = lifecycle.last_canvas_event_at;
    }
    return summary;
  }
  /*
   * 判斷是否為非空的一般物件。
   *
   * 用於 metadata 等選填欄位，避免在 handoff JSON 中輸出沒有資訊量的空物件。
   */
  function isNonEmptyObject(value) {
    return Boolean(
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).length > 0
    );
  }
  /*
   * 建立 handoff JSON 中的 textdocs 陣列。
   *
   * 會依建立時間排序、重新編號，並整合 textdocs endpoint 與 conversation canvas event 的資訊。
   */
  function buildHandoffTextdocs(textdocs, lifecycleById = new Map()) {
    if (!Array.isArray(textdocs)) {
      return [];
    }
    const orderedTextdocs = textdocs
      .map((textdoc, originalIndex) => {
        const sourceId = typeof textdoc.id === 'string' ? textdoc.id : null;
        const lifecycle = sourceId ? lifecycleById.get(sourceId) : null;
        const sortValue =
          lifecycle && lifecycle.created_at
            ? getTimeSortValue(lifecycle.created_at)
            : getTimeSortValue(textdoc && textdoc.updated_at);
        return {
          textdoc,
          originalIndex,
          sortValue
        };
      })
      .sort((left, right) => {
        if (left.sortValue !== right.sortValue) {
          return left.sortValue - right.sortValue;
        }
        return left.originalIndex - right.originalIndex;
      });
    return orderedTextdocs.map(({ textdoc }, index) => {
      const sourceId = typeof textdoc.id === 'string' ? textdoc.id : null;
      const lifecycle = sourceId ? lifecycleById.get(sourceId) : null;
      const result = {
        id: `td${String(index + 1).padStart(2, '0')}`,
        version: Number.isFinite(textdoc.version) ? textdoc.version : null,
        title: typeof textdoc.title === 'string' ? textdoc.title : null,
        textdoc_type: typeof textdoc.textdoc_type === 'string' ? textdoc.textdoc_type : null
      };
      if (lifecycle && lifecycle.created_at) {
        result.created_at = lifecycle.created_at;
      }
      if (typeof textdoc.updated_at === 'string' && textdoc.updated_at.trim()) {
        result.updated_at = toReadableTime(textdoc.updated_at);
      }
      if (lifecycle && lifecycle.create_source) {
        result.create_source = lifecycle.create_source;
      }
      const lifecycleSummary = buildTextdocLifecycleSummary(textdoc, lifecycle);
      if (Object.keys(lifecycleSummary).length > 0) {
        result.lifecycle = lifecycleSummary;
      }
      result.content = typeof textdoc.content === 'string' ? textdoc.content : '';
      if (isNonEmptyObject(textdoc.metadata)) {
        result.metadata = textdoc.metadata;
      }
      const comments = Array.isArray(textdoc.comments) ? textdoc.comments : [];
      result.comments = comments.map((comment, commentIndex) => {
        const start = Number.isInteger(comment && comment.start) ? comment.start : null;
        const end = Number.isInteger(comment && comment.end) ? comment.end : null;
        return {
          id: `tdc${String(commentIndex + 1).padStart(2, '0')}`,
          start,
          end,
          target_text: getTextdocCommentTargetText(result.content, start, end),
          content: comment && typeof comment.content === 'string' ? comment.content : ''
        };
      });
      return result;
    });
  }
  /*
   * 建立 handoff JSON。
   *
   * 輸出格式：
   *   {
   *     title,
   *     create_time,
   *     update_time,
   *     conversation_id,
   *     messages: [
   *       { id: "u01", role: "user", content: "..." },
   *       { id: "a01", role: "assistant", content: "...", cite_sources: [...] }
   *     ]
   *   }
   */
  function buildHandoff(conversation, textdocs = []) {
    const mapping = getMapping(conversation);
    const currentNode = conversation.current_node;
    const pathNodeIds = resolveMainPath(mapping, currentNode);
    const textdocLifecycleById = extractTextdocLifecycle(conversation, pathNodeIds);
    const messages = [];
    let userIndex = 0;
    let assistantIndex = 0;
    for (const nodeId of pathNodeIds) {
      const node = mapping[nodeId];
      if (!node || typeof node !== 'object') {
        continue;
      }
      const item = extractMessageItem(node);
      if (!item) {
        continue;
      }
      let messageId;
      if (item.role === 'user') {
        userIndex += 1;
        messageId = `u${String(userIndex).padStart(2, '0')}`;
      } else if (item.role === 'assistant') {
        assistantIndex += 1;
        messageId = `a${String(assistantIndex).padStart(2, '0')}`;
      } else {
        continue;
      }
      messages.push({
        id: messageId,
        ...item
      });
    }
    return {
      title: conversation.title ?? null,
      create_time: toReadableTime(conversation.create_time),
      update_time: toReadableTime(conversation.update_time),
      conversation_id: conversation.conversation_id ?? null,
      messages,
      textdocs: buildHandoffTextdocs(textdocs, textdocLifecycleById)
    };
  }
  /*
   * 檢查 handoff 轉換結果是否合理。
   *
   * 若檢查失敗，代表不應該下載，避免使用者拿到空或錯誤的 handoff。
   */
  function validateHandoffOrThrow(handoff, sourceConversation) {
    const problems = [];
    if (!handoff || typeof handoff !== 'object') {
      problems.push('handoff 不是有效物件。');
    }
    if (!Array.isArray(handoff.messages)) {
      problems.push('handoff.messages 不是陣列。');
    } else {
      if (handoff.messages.length === 0) {
        problems.push('handoff.messages 為空。');
      }
      if (!handoff.messages.some((message) => message && message.role === 'user')) {
        problems.push('handoff.messages 不包含任何 user 訊息。');
      }
      for (const [index, message] of handoff.messages.entries()) {
        if (!message || typeof message !== 'object') {
          problems.push(`第 ${index + 1} 則訊息不是有效物件。`);
          continue;
        }
        if (typeof message.id !== 'string' || !message.id) {
          problems.push(`第 ${index + 1} 則訊息缺少 id。`);
        }
        if (message.role !== 'user' && message.role !== 'assistant') {
          problems.push(`第 ${index + 1} 則訊息 role 不合法：${String(message.role)}`);
        }
        if (typeof message.content !== 'string' || !message.content.trim()) {
          problems.push(`第 ${index + 1} 則訊息 content 為空。`);
        }
      }
    }
    if (!Array.isArray(handoff.textdocs)) {
      problems.push('handoff.textdocs 不是陣列。');
    }
    if (!handoff.conversation_id) {
      problems.push('handoff 缺少 conversation_id。');
    }
    if (
      sourceConversation &&
      sourceConversation.conversation_id &&
      handoff.conversation_id !== sourceConversation.conversation_id
    ) {
      problems.push(
        `handoff.conversation_id 與 raw JSON 不一致：${handoff.conversation_id} !== ${sourceConversation.conversation_id}`
      );
    }
    if (problems.length > 0) {
      throw new Error(`交接 JSON 轉換結果檢查失敗：\n\n- ${problems.join('\n- ')}`);
    }
  }
  // ============================================================
  // 六、按鈕 UI、tooltip 與頁面導航處理
  // ============================================================
  /*
   * 更新指定匯出按鈕上的可見文字。
   */
  function setButtonText(buttonId, text) {
    const button = document.querySelector(`#${buttonId}`);
    if (!button) {
      return;
    }
    const label = button.querySelector('[data-export-label]');
    if (label && label.textContent !== text) {
      label.textContent = text;
    }
  }
  /*
   * 更新指定匯出按鈕的 title tooltip。
   */
  function setButtonTooltip(buttonId, text) {
    const button = document.querySelector(`#${buttonId}`);
    if (!button) {
      return;
    }
    if (button.title !== text) {
      button.title = text;
    }
  }
  /*
   * 設定單一按鈕的 busy 狀態。
   *
   * busy 時會停用點擊並調整外觀，避免使用者重複觸發同一個匯出流程。
   */
  function setButtonBusy(buttonId, isBusy) {
    const button = document.querySelector(`#${buttonId}`);
    if (!button) {
      return;
    }
    const opacity = isBusy ? '0.65' : '';
    const cursor = isBusy ? 'wait' : '';
    if (button.disabled !== isBusy) {
      button.disabled = isBusy;
    }
    if (button.style.opacity !== opacity) {
      button.style.opacity = opacity;
    }
    if (button.style.cursor !== cursor) {
      button.style.cursor = cursor;
    }
  }
  /*
   * 同步設定兩個匯出按鈕的 busy 狀態。
   */
  function setAllButtonsBusy(isBusy) {
    setButtonBusy(RAW_BUTTON_ID, isBusy);
    setButtonBusy(HANDOFF_BUTTON_ID, isBusy);
  }
  /*
   * 標記目前有匯出流程正在進行。
   *
   * 這個狀態會讓週期性 UI 更新保留目前進度文字，
   * 例如「正在擷取原始 JSON…」或「正在下載交接 JSON…」。
   */
  function setExportInProgress(buttonId, text) {
    activeExportState = {
      buttonId,
      text
    };
    setAllButtonsBusy(true);
    setButtonText(buttonId, text);
  }
  /*
   * 更新目前匯出流程的進度文字。
   *
   * 匯出流程會分階段呼叫這個 helper，讓使用者知道目前正在擷取、產出或下載哪一種資料。
   */
  function setExportProgress(buttonId, text) {
    if (!activeExportState || activeExportState.buttonId !== buttonId) {
      return;
    }
    activeExportState.text = text;
    setButtonText(buttonId, text);
  }
  /*
   * 若目前正在匯出，重新套用匯出中的按鈕狀態。
   *
   * 回傳 true 代表已接管 UI 狀態，呼叫端不應再覆蓋按鈕文字。
   */
  function applyExportInProgressState() {
    if (!activeExportState) {
      return false;
    }
    setAllButtonsBusy(true);
    setButtonText(activeExportState.buttonId, activeExportState.text);
    return true;
  }
  /*
   * 清除匯出中狀態，並恢復一般按鈕文字與 tooltip。
   */
  function clearExportInProgress() {
    activeExportState = null;
    setAllButtonsBusy(false);
    updateButtonState();
  }
  /*
   * 執行單一匯出流程。
   *
   * 這裡集中處理：
   *   - conversation ID 檢查
   *   - 匯出中進度文字
   *   - busy 狀態
   *   - 錯誤 log 與 alert
   *   - 流程結束後恢復 UI
   *
   * 實際的 raw / handoff 匯出邏輯由 operation callback 提供，
   * callback 可透過 updateProgress() 更新目前階段，讓兩個按鈕共用相同的 UI 狀態管理。
   */
  async function runExportFlow({ buttonId, initialProgressText, errorLogMessage, operation }) {
    const { conversationId } = getCurrentState();

    if (!conversationId) {
      alert(
        '找不到 conversation ID。\n\n' +
        '請確認目前頁面是 ChatGPT 對話頁，且網址包含 /c/{conversation_id}。\n' +
        '如果你剛切換頁面，請等待頁面載入完成後再試。'
      );
      return;
    }

    const updateProgress = (text) => {
      setExportProgress(buttonId, text);
    };

    try {
      setExportInProgress(buttonId, initialProgressText);
      await operation(conversationId, updateProgress);
    } catch (error) {
      logError(errorLogMessage, error);
      showErrorAlert(error);
    } finally {
      clearExportInProgress();
    }
  }
  /*
   * 建立按鈕 tooltip。
   *
   * 兩個按鈕會使用不同 actionName，避免 title 看起來像共用同一段說明。
   * tooltip 只顯示對話標題、conversation ID 與捕捉時間，不顯示 headers 或 raw JSON。
   */
  function buildBaseTooltip({ actionName, conversationId, capture, replayRequest }) {
    const title = conversationId ? getKnownConversationTitle(conversationId) : '';
    const lines = [actionName];
    if (title) {
      lines.push(`對話標題：${title}`);
    }
    if (conversationId) {
      lines.push(`Conversation ID：${conversationId}`);
    }
    if (replayRequest) {
      lines.push(`最近一次捕捉請求資訊：${getDisplayDateTime(new Date(replayRequest.capturedAt))}`);
    }
    if (capture) {
      lines.push(`最近一次捕捉 JSON：${getDisplayDateTime(new Date(capture.capturedAt))}`);
    }
    return lines.join('\n');
  }
  /*
   * 根據目前頁面狀態更新按鈕文字與 tooltip。
   *
   * 按鈕文字維持動作名稱，避免在 SPA 導航或新對話頁面中殘留暫時狀態。
   * 詳細狀態放在 tooltip 與錯誤訊息中呈現。
   */
  function updateButtonState() {
    const { conversationId, capture, replayRequest } = getCurrentState();
    const isExporting = applyExportInProgressState();
    if (!isConversationPage() || !conversationId) {
      if (!isExporting) {
        setButtonText(RAW_BUTTON_ID, '下載原始 JSON');
        setButtonText(HANDOFF_BUTTON_ID, '下載交接 JSON');
        setButtonTooltip(RAW_BUTTON_ID, '');
        setButtonTooltip(HANDOFF_BUTTON_ID, '');
        setAllButtonsBusy(false);
      }
      return;
    }
    if (!isExporting) {
      setButtonText(RAW_BUTTON_ID, '下載原始 JSON');
      setButtonText(HANDOFF_BUTTON_ID, '下載交接 JSON');
      setAllButtonsBusy(false);
    }
    const rawActionName = '下載目前對話的原始 raw conversation JSON';
    const handoffActionName = '產出並下載目前對話的交接 handoff JSON';
    setButtonTooltip(
      RAW_BUTTON_ID,
      buildBaseTooltip({
        actionName: rawActionName,
        conversationId,
        capture,
        replayRequest
      })
    );
    setButtonTooltip(
      HANDOFF_BUTTON_ID,
      buildBaseTooltip({
        actionName: handoffActionName,
        conversationId,
        capture,
        replayRequest
      })
    );
  }
  /*
   * 離開對話頁時移除匯出按鈕。
   *
   * ChatGPT 是 SPA，網址切換時不一定重新載入頁面，因此需要主動清理舊 UI。
   */
  function removeButtonsIfNeeded() {
    const rawButton = document.querySelector(`#${RAW_BUTTON_ID}`);
    const handoffButton = document.querySelector(`#${HANDOFF_BUTTON_ID}`);
    if (rawButton) {
      rawButton.remove();
    }
    if (handoffButton) {
      handoffButton.remove();
    }
  }
  /*
   * 建立和 ChatGPT header action 風格接近的按鈕。
   */
  function createHeaderButton({ id, label, ariaLabel, testId, iconSvg, onClick }) {
    const button = document.createElement('button');
    button.id = id;
    button.type = 'button';
    button.setAttribute('aria-label', ariaLabel);
    button.setAttribute('data-testid', testId);
    button.setAttribute('data-cgpt-export-button', 'true');
    /*
     * 這裡沿用 ChatGPT 既有按鈕 class，讓樣式與「分享」按鈕一致。
     * 若 ChatGPT 未來改 class，按鈕可能仍存在，但外觀可能需要調整。
     */
    button.className = [
      'btn',
      'relative',
      'group-focus-within/dialog:focus-visible:[outline-width:1.5px]',
      'group-focus-within/dialog:focus-visible:[outline-offset:2.5px]',
      'group-focus-within/dialog:focus-visible:[outline-style:solid]',
      'group-focus-within/dialog:focus-visible:[outline-color:var(--text-primary)]',
      'btn-ghost',
      'text-token-text-primary',
      'hover:bg-token-surface-hover',
      'keyboard-focused:bg-token-surface-hover',
      'rounded-lg',
      'max-sm:hidden'
    ].join(' ');
    button.innerHTML = `
      <div class="flex w-full items-center justify-center gap-1.5">
        ${iconSvg || ''}
        <span data-export-label>${label}</span>
      </div>
    `;
    /*
     * 滑鼠移入或鍵盤 focus 時重新整理 tooltip。
     * 這能讓剛改名的對話標題較快反映到 title。
     */
    button.addEventListener('mouseenter', () => {
      updateButtonState();
    });
    button.addEventListener('focus', () => {
      updateButtonState();
    });
    button.addEventListener('click', onClick);
    return button;
  }
  /*
   * 執行「下載原始 JSON」的實際匯出工作。
   *
   * 流程刻意拆成三步：
   *   1. 取得並驗證 conversation raw JSON。
   *   2. 立即下載 raw JSON。
   *   3. 再嘗試下載 textdocs。
   *
   * 這樣即使 textdocs 取得失敗，也不會影響最重要的 raw JSON。
   */
  async function exportRawConversationFiles(conversationId, updateProgress) {
    const exportTimestamp = getTimestampString();

    updateProgress('正在擷取原始 JSON…');
    const snapshot = await getLatestConversationSnapshot(conversationId);

    updateProgress('正在下載原始 JSON…');
    downloadRawConversation(snapshot, conversationId, exportTimestamp);

    updateProgress('正在擷取 textdocs…');
    const textdocs = await getLatestTextdocs(conversationId);

    if (Array.isArray(textdocs) && textdocs.length > 0) {
      updateProgress('正在下載 textdocs…');
      downloadTextdocsIfPresent(textdocs, snapshot.rawText, conversationId, exportTimestamp);
    }
  }
  /*
   * 執行「下載交接 JSON」的實際匯出工作。
   *
   * handoff 需要同時整合對話主分支與 textdocs。
   * textdocs 若不可取得會被視為空陣列，讓主要對話脈絡仍可交接。
   */
  async function exportHandoffFile(conversationId, updateProgress) {
    const exportTimestamp = getTimestampString();

    updateProgress('正在擷取原始 JSON…');
    const snapshot = await getLatestConversationSnapshot(conversationId);

    updateProgress('正在擷取 textdocs…');
    const textdocs = await getLatestTextdocs(conversationId);

    updateProgress('正在產出交接 JSON…');
    const handoffPayload = buildHandoffDownloadPayload(snapshot, textdocs, conversationId, exportTimestamp);

    updateProgress('正在下載交接 JSON…');
    downloadHandoffPayload(handoffPayload);
  }
  /*
   * 點擊「下載原始 JSON」。
   *
   * raw JSON 會輸出為 4 空白縮排，方便閱讀與版本管理。
   */
  async function handleDownloadRawClick() {
    await runExportFlow({
      buttonId: RAW_BUTTON_ID,
      initialProgressText: '正在擷取原始 JSON…',
      errorLogMessage: '下載原始 JSON 失敗。',
      operation: exportRawConversationFiles
    });
  }
  /*
   * 點擊「下載交接 JSON」。
   *
   * UI 狀態與錯誤處理由 runExportFlow() 統一處理，
   * 實際轉換與下載工作交給 exportHandoffFile()。
   */
  async function handleDownloadHandoffClick() {
    await runExportFlow({
      buttonId: HANDOFF_BUTTON_ID,
      initialProgressText: '正在擷取原始 JSON…',
      errorLogMessage: '下載交接 JSON 失敗。',
      operation: exportHandoffFile
    });
  }
  /*
   * 移除同一個按鈕 ID 的重複節點。
   *
   * ChatGPT SPA 重繪或 userscript 重複初始化異常時，可能留下重複按鈕；
   * 保留第一個節點並移除其餘節點，可避免 UI 上出現多組匯出按鈕。
   */
  function removeDuplicateButtons(buttonId) {
    const buttons = Array.from(document.querySelectorAll(`#${buttonId}`));
    for (const duplicateButton of buttons.slice(1)) {
      duplicateButton.remove();
    }
  }
  /*
   * 取得匯出按鈕應插入的 header action 容器。
   *
   * 優先使用目前最精準的 #conversation-header-actions；
   * 若 ChatGPT 前端調整 DOM，則依序退回 thread header 右側 action 區與 page header。
   */
  function findHeaderActionsContainer() {
    const selectors = [
      '#conversation-header-actions',
      '[data-testid="thread-header-right-actions"]',
      '[data-testid="thread-header-right-actions-container"]',
      '#page-header'
    ];
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (element) {
        return element;
      }
    }
    return null;
  }
  /*
   * 取得或建立指定匯出按鈕。
   *
   * 若按鈕已存在，會重用既有節點，避免重新綁定事件或造成 focus 狀態遺失。
   */
  function getOrCreateExportButton(config) {
    const existingButton = document.querySelector(`#${config.id}`);
    if (existingButton) {
      return existingButton;
    }
    return createHeaderButton(config);
  }
  /*
   * 找出 element 在 parent 底下對應的直接子元素。
   *
   * ChatGPT header 的 action 可能包在多層 div 裡，例如更多選單按鈕通常
   * 不會直接掛在 #conversation-header-actions 底下。
   *
   * 插入匯出按鈕時，若直接對深層 button 操作，可能會把按鈕塞進錯誤 wrapper。
   * 因此這裡先往上找到 action 容器底下的直接子元素，再用該節點決定插入位置。
   */
  function getDirectChildWithin(parent, element) {
    if (!parent || !element) {
      return null;
    }

    let current = element;

    while (current && current.parentElement && current.parentElement !== parent) {
      current = current.parentElement;
    }

    return current && current.parentElement === parent ? current : null;
  }
  /*
   * 將匯出按鈕放到 ChatGPT header 的適當位置。
   *
   * 目標順序：
   *   分享 → 下載原始 JSON → 下載交接 JSON → 更多選單
   *
   * 使用 header action 的直接子元素作為插入錨點，避免匯出按鈕被放到
   * ChatGPT 原生按鈕的內層 wrapper 裡。
   *
   * 若找不到分享按鈕或更多選單，仍會把兩顆匯出按鈕插入 action 容器中，
   * 避免 ChatGPT DOM 結構小幅變動時按鈕直接消失。
   */
  function placeExportButtons(headerActions, rawButton, handoffButton) {
    const shareButton = headerActions.querySelector('[data-testid="share-chat-button"]');
    const optionsButton = headerActions.querySelector('[data-testid="conversation-options-button"]');

    const shareAction = getDirectChildWithin(headerActions, shareButton);
    const optionsAction = getDirectChildWithin(headerActions, optionsButton);

    if (shareAction) {
      shareAction.insertAdjacentElement('afterend', rawButton);
    } else if (optionsAction) {
      optionsAction.insertAdjacentElement('beforebegin', rawButton);
    } else {
      headerActions.append(rawButton);
    }

    rawButton.insertAdjacentElement('afterend', handoffButton);
  }
  /*
   * 將兩個按鈕插入 ChatGPT 對話頁 header。
   *
   * 這個函式同時負責建立、去重、搬移與狀態更新。
   * ChatGPT header 若因 SPA 導航或 React 重繪被重建，下一次 ensureButtonsSoon() 會把按鈕放回正確位置。
   */
  function insertButtonsOnce() {
    if (!isConversationPage()) {
      removeButtonsIfNeeded();
      return;
    }

    removeDuplicateButtons(RAW_BUTTON_ID);
    removeDuplicateButtons(HANDOFF_BUTTON_ID);

    const headerActions = findHeaderActionsContainer();
    if (!headerActions) {
      return;
    }

    const rawButton = getOrCreateExportButton({
      id: RAW_BUTTON_ID,
      label: '下載原始 JSON',
      ariaLabel: '下載目前對話原始 JSON',
      testId: 'raw-json-export-button',
      iconSvg: RAW_JSON_ICON_SVG,
      onClick: handleDownloadRawClick
    });
    const handoffButton = getOrCreateExportButton({
      id: HANDOFF_BUTTON_ID,
      label: '下載交接 JSON',
      ariaLabel: '產出並下載目前對話交接 JSON',
      testId: 'handoff-json-export-button',
      iconSvg: HANDOFF_ICON_SVG,
      onClick: handleDownloadHandoffClick
    });

    placeExportButtons(headerActions, rawButton, handoffButton);
    updateButtonState();
  }
  /*
   * 節流插入按鈕。
   *
   * 避免 ChatGPT DOM 頻繁變動時，每次都立即查 DOM。
   */
  function ensureButtonsSoon() {
    if (ensureTimer !== null) {
      return;
    }
    ensureTimer = window.setTimeout(() => {
      ensureTimer = null;
      insertButtonsOnce();
    }, 300);
  }
  /*
   * 偵測 SPA path 是否改變。
   */
  function handleRouteMaybeChanged() {
    if (location.pathname === lastPathname) {
      return;
    }
    lastPathname = location.pathname;
    ensureButtonsSoon();
  }
  /*
   * 包裝 history.pushState / replaceState。
   *
   * ChatGPT 是 SPA，切換對話時不一定重新載入整頁。
   * 因此需要監聽路由變化，才能在新對話頁補上按鈕。
   */
  function installHistoryListener() {
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;
    history.pushState = function () {
      const result = originalPushState.apply(this, arguments);
      ensureButtonsSoon();
      return result;
    };
    history.replaceState = function () {
      const result = originalReplaceState.apply(this, arguments);
      ensureButtonsSoon();
      return result;
    };
    window.addEventListener('popstate', () => {
      ensureButtonsSoon();
    });
  }
  /*
   * 低頻輪詢。
   *
   * 用途：
   *   - 補救某些 React 重繪導致按鈕消失的情況。
   *   - 確認非對話頁時移除按鈕。
   *
   * 頻率：
   *   每秒一次，且主要只做輕量檢查。
   */
  function startLightPolling() {
    window.setInterval(() => {
      handleRouteMaybeChanged();
      if (isConversationPage()) {
        insertButtonsOnce();
      } else {
        removeButtonsIfNeeded();
      }
    }, 1000);
  }
  /*
   * 監聽 document.title 變化。
   *
   * 使用者修改對話標題後，ChatGPT 可能會更新 document.title。
   * 此時重新整理 tooltip，使按鈕 title 顯示較新的對話標題。
   */
  function installTitleObserver() {
    const titleElement = document.querySelector('title');
    if (!titleElement) {
      return;
    }
    const observer = new MutationObserver(() => {
      ensureButtonsSoon();
    });
    observer.observe(titleElement, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }
  /*
   * 啟動 UI 相關邏輯。
   */
  function startUi() {
    if (uiStarted) {
      return;
    }
    uiStarted = true;
    installHistoryListener();
    installTitleObserver();
    ensureButtonsSoon();
    startLightPolling();
  }
  // ============================================================
  // 七、啟動腳本
  // ============================================================
  /*
   * 越早包裝 fetch，越有機會捕捉到 ChatGPT 載入對話時的原始 JSON。
   *
   * UI 插入則等 DOM 可用後再開始。
   */
  installFetchInterceptor();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startUi, { once: true });
  } else {
    startUi();
  }
})();
