// ==UserScript==
// @name         ChatGPT 對話 JSON 與交接檔匯出工具
// @name:en      ChatGPT Conversation Handoff Exporter
// @namespace    https://github.com/SunnyLeu/ChatGPT-Conversation-Handoff-Exporter
// @version      1.1.2
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
  const INSTALL_FLAG = '__chatgptConversationHandoffExporterInstalled_v112';

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
   */
  let lastPathname = location.pathname;
  let ensureTimer = null;
  let uiStarted = false;

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
   * 例如 web 搜尋工具的 search_query / open / find 等。
   *
   * 這些內容若輸出到 handoff，會讓新對話看到內部工具呼叫細節，
   * 因此要排除。
   */
  const ASSISTANT_TOOL_OPERATION_PATTERN =
    /(^|\n)\s*\{?\s*"?(search_query|open|find|click|image_query|product_query|sports|finance|weather|calculator|time)"?\s*:/i;

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

  function logInfo(message, data = null) {
    if (data === null || data === undefined) {
      console.info(LOG_PREFIX, message);
      return;
    }

    console.info(LOG_PREFIX, message, data);
  }

  function logWarn(message, data = null) {
    if (data === null || data === undefined) {
      console.warn(LOG_PREFIX, message);
      return;
    }

    console.warn(LOG_PREFIX, message, data);
  }

  function logError(message, error = null) {
    if (!error) {
      console.error(LOG_PREFIX, message);
      return;
    }

    console.error(LOG_PREFIX, message, {
      name: error.name || 'Error',
      message: error.message || String(error)
    });
  }

  function toErrorMessage(error) {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
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

  function tryParseJson(rawText) {
    return JSON.parse(rawText);
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
   * 優先從目前頁面取得即時標題。
   *
   * 原因：
   *   使用者重新命名對話後，raw JSON 中的 title 可能要等下一次
   *   重新抓取才更新；但頁面標題或側邊欄文字可能較快更新。
   *
   * 取值順序：
   *   1. document.title
   *   2. 側邊欄中連到目前 conversation ID 的連結文字
   *   3. 空字串
   */
  function getTitleFromCurrentPage(conversationId) {
    const browserTitle = cleanBrowserTitle(document.title);

    if (browserTitle) {
      return browserTitle;
    }

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
   * tooltip 顯示用標題。
   *
   * 優先使用目前頁面上的即時標題；
   * 若沒有，再退回已捕捉 raw JSON 中的 title。
   */
  function getKnownConversationTitle(conversationId) {
    const liveTitle = getTitleFromCurrentPage(conversationId);

    if (liveTitle) {
      return liveTitle;
    }

    const capture = capturedRawByConversationId.get(conversationId);

    if (capture && capture.rawText) {
      try {
        const conversation = JSON.parse(capture.rawText);
        return getConversationTitle(conversation, '');
      } catch {
        return '';
      }
    }

    return '';
  }

  function tryGetTitleFromRawJson(rawText, conversationId) {
    try {
      const data = tryParseJson(rawText);
      return getConversationTitle(data, conversationId || 'chatgpt-conversation');
    } catch {
      return conversationId || 'chatgpt-conversation';
    }
  }

  function buildRawFilename(rawText, conversationId, timestamp = getTimestampString()) {
    const title = sanitizeFilenamePart(tryGetTitleFromRawJson(rawText, conversationId));
    return `${title}-${timestamp}.json`;
  }

  function buildTextdocsFilename(rawText, conversationId, timestamp = getTimestampString()) {
    const title = sanitizeFilenamePart(tryGetTitleFromRawJson(rawText, conversationId));
    return `${title}-${timestamp}.textdocs.json`;
  }

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

    const forbiddenOrUnhelpful = new Set([
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

    return !forbiddenOrUnhelpful.has(lowerName);
  }

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
   */
  function rememberRawConversation(conversationId, rawText) {
    capturedRawByConversationId.set(conversationId, {
      rawText,
      capturedAt: Date.now()
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
        '這通常表示頁面剛切換對話，或捕捉到舊對話資料。請稍等一秒後再試。'
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

          try {
            parseAndValidateRawConversation(rawText, conversationId);
          } catch {
            return;
          }

          rememberRawConversation(conversationId, rawText);
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
   */
  function buildConversationApiUrl(conversationId) {
    return new URL(
      `/backend-api/conversation/${encodeURIComponent(conversationId)}`,
      location.origin
    ).href;
  }

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

  function applyConversationTargetHeaders(headers, conversationId) {
    const targetPath = `/backend-api/conversation/${encodeURIComponent(conversationId)}`;

    return applyTargetHeaders(
      headers,
      targetPath,
      '/backend-api/conversation/{conversation_id}'
    );
  }

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
      throw new Error(
        '目前無法取得此對話的 JSON 請求資訊。\n\n' +
        '請確認對話內容已載入完成，或重新進入此對話頁後再試一次。'
      );
    }

    replayRequestByConversationId.set(conversationId, replayRequest);

    const response = await fetch(replayRequest.url, {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
      headers: new Headers(replayRequest.headers)
    });

    if (!response.ok) {
      throw new Error(`即時重新抓取失敗：HTTP ${response.status} ${response.statusText}`);
    }

    const contentType = response.headers.get('content-type') || '';

    if (!contentType.includes('application/json')) {
      throw new Error(
        '即時重新抓取失敗：回應不是 JSON。\n\n' +
        `Content-Type: ${contentType || '未知'}`
      );
    }

    const rawText = await response.text();

    if (!looksLikeConversationObject(rawText)) {
      throw new Error(
        '即時重新抓取失敗：回應不是完整 conversation JSON 物件。\n\n' +
        `內容長度：${rawText ? rawText.length : 0}`
      );
    }

    parseAndValidateRawConversation(rawText, conversationId);
    rememberRawConversation(conversationId, rawText);

    return rawText;
  }

  function parseAndValidateTextdocsRaw(rawText) {
    let textdocs;

    try {
      textdocs = JSON.parse(rawText);
    } catch (error) {
      throw new Error(`textdocs JSON 解析失敗：${toErrorMessage(error)}`);
    }

    if (!Array.isArray(textdocs)) {
      throw new Error('textdocs JSON 不是有效的陣列。');
    }

    for (const [index, textdoc] of textdocs.entries()) {
      if (!textdoc || typeof textdoc !== 'object' || Array.isArray(textdoc)) {
        throw new Error(`第 ${index + 1} 個 textdoc 不是有效物件。`);
      }

      if (typeof textdoc.id !== 'string' || !textdoc.id) {
        throw new Error(`第 ${index + 1} 個 textdoc 缺少有效 id。`);
      }

      if (typeof textdoc.content !== 'string') {
        throw new Error(`第 ${index + 1} 個 textdoc 缺少有效 content。`);
      }

      if (textdoc.comments !== undefined && !Array.isArray(textdoc.comments)) {
        throw new Error(`第 ${index + 1} 個 textdoc 的 comments 不是陣列。`);
      }
    }

    return textdocs;
  }

  function warnAndReturnEmptyTextdocs(message, data = null) {
    logWarn(message, data);
    return '[]';
  }

  /*
   * 即時抓取目前對話的 textdocs JSON。
   *
   * 不是所有對話都有畫布。若 textdocs endpoint 無法提供可用 JSON，
   * 會改用空陣列繼續匯出，避免畫布資料取得失敗阻斷一般對話匯出。
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

  async function getLatestTextdocsRaw(conversationId) {
    return refetchTextdocsRaw(conversationId);
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

  function looksLikeAssistantToolOperation(text) {
    const stripped = String(text || '').trim();

    if (!stripped) {
      return false;
    }

    return ASSISTANT_TOOL_OPERATION_PATTERN.test(stripped);
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

      if (textdoc.metadata !== null && textdoc.metadata !== undefined) {
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

  function setButtonText(buttonId, text) {
    const button = document.querySelector(`#${buttonId}`);

    if (!button) {
      return;
    }

    const label = button.querySelector('[data-export-label]');

    if (label) {
      label.textContent = text;
    }
  }

  function setButtonTooltip(buttonId, text) {
    const button = document.querySelector(`#${buttonId}`);

    if (!button) {
      return;
    }

    button.title = text;
  }

  function setButtonBusy(buttonId, isBusy) {
    const button = document.querySelector(`#${buttonId}`);

    if (!button) {
      return;
    }

    button.disabled = isBusy;
    button.style.opacity = isBusy ? '0.65' : '';
    button.style.cursor = isBusy ? 'wait' : '';
  }

  function setAllButtonsBusy(isBusy) {
    setButtonBusy(RAW_BUTTON_ID, isBusy);
    setButtonBusy(HANDOFF_BUTTON_ID, isBusy);
  }

  /*
   * 建立按鈕 tooltip。
   *
   * 兩個按鈕會使用不同 actionName，
   * 避免 title 看起來像共用同一段說明。
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

    if (!isConversationPage() || !conversationId) {
      setButtonText(RAW_BUTTON_ID, '下載原始 JSON');
      setButtonText(HANDOFF_BUTTON_ID, '下載交接 JSON');
      setButtonTooltip(RAW_BUTTON_ID, '');
      setButtonTooltip(HANDOFF_BUTTON_ID, '');
      setAllButtonsBusy(false);
      return;
    }

    setButtonText(RAW_BUTTON_ID, '下載原始 JSON');
    setButtonText(HANDOFF_BUTTON_ID, '下載交接 JSON');

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
   * 點擊「下載原始 JSON」。
   *
   * raw JSON 會輸出為 4 空白縮排，方便閱讀與版本管理。
   */
  async function handleDownloadRawClick() {
    const { conversationId } = getCurrentState();

    if (!conversationId) {
      alert('找不到 conversation ID。請確認目前頁面是 ChatGPT 對話頁。');
      return;
    }

    try {
      setAllButtonsBusy(true);
      setButtonText(RAW_BUTTON_ID, '抓取中…');

      const exportTimestamp = getTimestampString();
      const rawText = await getLatestRawText(conversationId);
      const conversation = parseAndValidateRawConversation(rawText, conversationId);

      const prettyRawText = JSON.stringify(conversation, null, 4);
      const filename = buildRawFilename(rawText, conversationId, exportTimestamp);

      downloadTextFile(prettyRawText, filename);

      try {
        const textdocsRawText = await getLatestTextdocsRaw(conversationId);
        const textdocs = parseAndValidateTextdocsRaw(textdocsRawText);

        if (textdocs.length > 0) {
          const prettyTextdocsText = JSON.stringify(textdocs, null, 4);
          const textdocsFilename = buildTextdocsFilename(rawText, conversationId, exportTimestamp);

          downloadTextFile(prettyTextdocsText, textdocsFilename);
        }
      } catch (textdocsError) {
        logWarn('原始 JSON 已下載，但 textdocs JSON 下載失敗。', {
          message: toErrorMessage(textdocsError)
        });

        alert(
          '原始 JSON 已成功下載，但 textdocs JSON 下載失敗。\n\n' +
          '這不影響原始 conversation JSON。若這段對話有畫布內容，請稍後再試。\n\n' +
          `textdocs 錯誤：${toErrorMessage(textdocsError)}`
        );
      }
    } catch (error) {
      logError('下載原始 JSON 失敗。', error);
      showErrorAlert(error);
    } finally {
      setAllButtonsBusy(false);
      updateButtonState();
    }
  }

  /*
   * 點擊「下載交接 JSON」。
   *
   * 流程：
   *   1. 取得最新 raw JSON。
   *   2. 驗證 raw JSON 與目前 conversation ID 一致。
   *   3. 取得目前對話的 textdocs JSON。
   *   4. 轉換成 handoff JSON。
   *   5. 檢查 handoff 結果合理性。
   *   6. 以 4 空白縮排下載。
   */
  async function handleDownloadHandoffClick() {
    const { conversationId } = getCurrentState();

    if (!conversationId) {
      alert('找不到 conversation ID。請確認目前頁面是 ChatGPT 對話頁。');
      return;
    }

    try {
      setAllButtonsBusy(true);
      setButtonText(HANDOFF_BUTTON_ID, '產出中…');

      const exportTimestamp = getTimestampString();
      const rawText = await getLatestRawText(conversationId);
      const conversation = parseAndValidateRawConversation(rawText, conversationId);
      const textdocsRawText = await getLatestTextdocsRaw(conversationId);
      const textdocs = parseAndValidateTextdocsRaw(textdocsRawText);
      const handoff = buildHandoff(conversation, textdocs);

      validateHandoffOrThrow(handoff, conversation);

      const handoffText = JSON.stringify(handoff, null, 4);
      const filename = buildHandoffFilename(rawText, conversationId, exportTimestamp);

      downloadTextFile(handoffText, filename);
    } catch (error) {
      logError('下載交接 JSON 失敗。', error);
      showErrorAlert(error);
    } finally {
      setAllButtonsBusy(false);
      updateButtonState();
    }
  }

  /*
   * 將兩個按鈕插入 ChatGPT 對話頁 header。
   *
   * 插入位置：
   *   #conversation-header-actions 裡的「分享」按鈕旁邊。
   */
  function insertButtonsOnce() {
    if (!isConversationPage()) {
      removeButtonsIfNeeded();
      return;
    }

    const rawButtonExists = Boolean(document.querySelector(`#${RAW_BUTTON_ID}`));
    const handoffButtonExists = Boolean(document.querySelector(`#${HANDOFF_BUTTON_ID}`));

    if (rawButtonExists && handoffButtonExists) {
      updateButtonState();
      return;
    }

    const headerActions = document.querySelector('#conversation-header-actions');

    if (!headerActions) {
      return;
    }

    if (!rawButtonExists) {
      const rawButton = createHeaderButton({
        id: RAW_BUTTON_ID,
        label: '下載原始 JSON',
        ariaLabel: '下載目前對話原始 JSON',
        testId: 'raw-json-export-button',
        iconSvg: RAW_JSON_ICON_SVG,
        onClick: handleDownloadRawClick
      });

      const shareButton = headerActions.querySelector('[data-testid="share-chat-button"]');

      if (shareButton) {
        shareButton.insertAdjacentElement('afterend', rawButton);
      } else {
        headerActions.prepend(rawButton);
      }
    }

    if (!handoffButtonExists) {
      const handoffButton = createHeaderButton({
        id: HANDOFF_BUTTON_ID,
        label: '下載交接 JSON',
        ariaLabel: '產出並下載目前對話交接 JSON',
        testId: 'handoff-json-export-button',
        iconSvg: HANDOFF_ICON_SVG,
        onClick: handleDownloadHandoffClick
      });

      const rawButton = document.querySelector(`#${RAW_BUTTON_ID}`);

      if (rawButton) {
        rawButton.insertAdjacentElement('afterend', handoffButton);
      } else {
        headerActions.prepend(handoffButton);
      }
    }

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
