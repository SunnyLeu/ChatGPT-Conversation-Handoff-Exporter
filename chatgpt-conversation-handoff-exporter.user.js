// ==UserScript==
// @name         ChatGPT 對話 JSON 與交接檔匯出工具
// @name:en      ChatGPT Conversation Handoff Exporter
// @namespace    https://github.com/SunnyLeu/ChatGPT-Conversation-Handoff-Exporter
// @version      1.5.11
// @description  匯出 ChatGPT raw / handoff / complete JSON；handoff v2 採 Structure-first / Preserve-on-unknown 完整保留交接文字，並支援受控批次原始、交接與完整 JSON session。
// @description:en Export ChatGPT raw / handoff / complete JSON; handoff v2 uses structure-first, preserve-on-unknown semantics and supports controlled raw, handoff, and complete batch sessions.
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
 *   1. 在 ChatGPT 對話頁右上角、原生「分享」旁新增一個「匯出」選單按鈕。
 *      按鈕沿用交接 JSON 圖示；點擊後使用目前 ChatGPT 原生選單結構與既有樣式提供：
 *      -「下載原始 JSON」
 *      -「下載交接 JSON」
 *      -「下載完整 JSON」
 *
 *   2.「下載原始 JSON」會匯出目前對話的 raw conversation JSON。
 *
 *   3.「下載交接 JSON」會把 raw conversation JSON 轉換成較精簡、
 *      適合上傳到新 ChatGPT 對話接續前情的 handoff JSON；schema v2
 *      會保留附件、回覆 / 來源關聯、可理解的推理摘要、結構化執行狀態與原始可讀工具文字。
 *
 *   4.「下載完整 JSON」會以同一份 authoritative conversation / textdocs snapshot
 *      依序下載 raw conversation JSON、可用的 textdocs JSON 與 handoff JSON；
 *      單一對話完整匯出不建立 ZIP，也不壓縮檔案。
 *
 *   5. 一般聊天側邊欄與專案聊天列表提供受控批次 raw / handoff / complete 功能：
 *      使用者可在同一個批次 session 中多次選取並追加 conversation 到佇列；
 *      資料取得完成後仍保留在目前頁面記憶體，只有使用者按下「打包」時，
 *      才以 ZIP STORE（不壓縮）封裝並下載。
 *
 * 設計原則：
 *   - 單一匯出只處理目前使用者正在看的對話。
 *   - 批次選取只處理使用者在 ChatGPT UI 中直接點選的一般對話，
 *     或單一專案內直接點選的專案對話；不列舉或掃描帳號其他對話。
 *   - 批次模式只處理使用者直接選取並確認加入目前 session 的 conversation ID；
 *     不列舉帳號其他對話，也不在背景定時主動抓取 conversation / textdocs。
 *   - 一般聊天與專案聊天各自維持獨立 batch session；兩者可同時存在、各自追加與打包。
 *   - 底層主動資料 request 共用全域 round-robin scheduler，任何時間最多只處理一筆。
 *   - 同一個批次 session 鎖定 raw、handoff 或 complete 類型，可在既有 queue 執行期間繼續追加。
 *   - 批次資料只暫存在目前頁面記憶體；按下「打包」後才建立 ZIP STORE
 *     （compression method 0），不壓縮、不載入第三方 ZIP library。
 *   - 從出現第一個批次選取起，到所有相關 session 打包完成前，使用 beforeunload 防止誤關閉／重新整理。
 *   - 「取消批次下載作業」需再次確認；確認後以一次性 bypass 直接重新整理頁面，以清除整個 session。
 *   - raw 批次沿用單一 raw 匯出語意：封裝 conversation JSON，若有 textdocs 則一併封裝
 *     正規化 `.textdocs.json`；handoff 批次輸出 `.handoff.json`；complete 批次使用同一份
 *     authoritative conversation / textdocs snapshot 同時產生兩者，並分別放入 `原始JSON/` 與 `交接JSON/`。
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
  const INSTALL_FLAG = '__chatgptConversationHandoffExporterInstalled_v1511';
  /*
   * 匯出按鈕事件綁定標記。
   *
   * ChatGPT SPA 可能保留既有按鈕節點；此標記用於判斷節點上的
   * click listener 是否屬於目前腳本，必要時重建按鈕以避免殘留
   * listener 或 conversation 狀態。
   */
  const EXPORT_BUTTON_LISTENER_VERSION = '1.5.11';
  /*
   * 匯出器與 handoff schema 版本。
   *
   * EXPORTER_VERSION：
   *   對應目前 userscript 版本，用於 handoff provenance。
   *
   * HANDOFF_SCHEMA_VERSION：
   *   與 userscript 版本分離；只有 handoff 結構或語意改版時才升版。
   */
  const EXPORTER_VERSION = '1.5.11';
  const HANDOFF_SCHEMA_VERSION = '2.0';
  /*
   * Structure-first / Preserve-on-unknown：
   * 已納入 handoff domain 的 tool input / progress / output 純文字不設內容長度上限，
   * 也不依文字樣式做 REDACTED、摘要或截斷。runtime-only request context / headers /
   * cookie / session 等仍在來源與結構層排除，不能因取消文字遮蔽而注入 handoff。
   */
  const NORMAL_MESSAGE_STATUS = 'finished_successfully';
  /*
   * 單一對話匯出選單的 DOM id。
   *
   * Header 常駐只保留一顆「匯出」觸發按鈕；選單內再提供 raw / handoff /
   * complete 三種既有匯出動作。舊版三顆 Header 按鈕 id 只保留給升版時清理
   * SPA 可能殘留的節點，不再作為正式操作入口。
   */
  const EXPORT_MENU_BUTTON_ID = 'cgpt-export-menu-button';
  const EXPORT_MENU_ID = 'cgpt-export-menu';
  const LEGACY_SINGLE_EXPORT_BUTTON_IDS = [
    'cgpt-export-raw-json-button',
    'cgpt-export-handoff-json-button',
    'cgpt-export-complete-json-button'
  ];
  /*
   * Header action 共用 selector 與幾何量測容差。
   *
   * HEADER_LAYOUT_TOLERANCE：
   *   只用來吸收 getBoundingClientRect()、clientWidth / scrollWidth 的
   *   次像素與整數取整差異，不作為 viewport / Header 固定寬度門檻。
   *
   * compact / expanded 的決策改由實際版面壓力驅動：
   *   - 右側 action 發生 overflow 或越界。
   *   - 左右 Header 區塊實際重疊。
   *   - expanded 相較 compact 新增左側文字裁切 / 截斷。
   */
  const SHARE_BUTTON_SELECTOR = '[data-testid="share-chat-button"]';
  const LEGACY_HEADER_ACTIONS_SELECTOR = '#conversation-header-actions';
  const CURRENT_HEADER_ACTIONS_SELECTOR = '[data-cgpt-export-header-actions="true"]';
  const HEADER_ACTIONS_SELECTOR = `${LEGACY_HEADER_ACTIONS_SELECTOR}, ${CURRENT_HEADER_ACTIONS_SELECTOR}`;
  const HEADER_LAYOUT_TOLERANCE = 1;
  /*
   * conversation request-context endpoint 世代。
   *
   * Legacy：/backend-api/conversation/{conversation_id}
   * Current：/backend-api/conversations/{conversation_id}
   *
   * 2026-09 App Shell build 已確認：current plural endpoint 是分頁 messages schema，
   * authoritative full raw conversation 仍由 legacy singular endpoint 提供 mapping。
   * 因此此世代值只用來判斷「來源 request context 應如何整理 headers」，
   * 不再決定正式 raw / handoff 匯出的 authoritative endpoint。
   */
  const CONVERSATION_ENDPOINT_LEGACY = 'legacy';
  const CONVERSATION_ENDPOINT_CURRENT = 'current';
  /*
   * backend JSON response 完整性驗證用容差。
   *
   * PerformanceResourceTiming.decodedBodySize 是瀏覽器網路層解碼後的 body bytes；
   * TextEncoder 則計算 JavaScript 實際拿到的 JSON UTF-8 bytes。
   *
   * 正常同源 JSON 兩者應非常接近。保留少量比例與固定 bytes 容差，
   * 避免 BOM、瀏覽器實作細節或極小 response 的微小差異被誤判。
   */
  const RESOURCE_TIMING_BYTE_TOLERANCE_RATIO = 0.01;
  const RESOURCE_TIMING_BYTE_TOLERANCE_MIN = 64;
  const RESOURCE_TIMING_START_SLOP_MS = 5;
  /*
   * 若目前頁面已經安裝過本腳本，就直接結束。
   */
  if (window[INSTALL_FLAG]) {
    return;
  }
  window[INSTALL_FLAG] = true;
  /*
   * capturedRawByConversationId：
   *   暫存被動觀察到或已驗證通過的 conversation JSON。
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
   *   /backend-api/conversation/{conversation_id} 或 /backend-api/conversations/{conversation_id} 完整對話 JSON 請求。
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
   * 最近一次實際觀察到的 raw/scoped conversation endpoint 世代。
   * 只保存在目前頁面記憶體，不寫入任何永久儲存區。
   */
  let latestConversationEndpointKind = null;
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
  let exportMenuAbortController = null;
  let exportMenuTriggerNode = null;
  /*
   * ChatGPT 回覆中的內嵌引用標記，例如：
   *   citeturn0search0
   *   fileciteturn1file3
   *
   * handoff 會優先由 content_references / marker payload 還原可見 label / title / name；
   * 無法可靠解析的 marker 直接保留原文，不得用通用 Regex 靜默刪除。
   */
  const INLINE_MARK_PATTERN = /.*?/gs;
  /*
   * handoff JSON 只保留 user / assistant。
   *
   * system、tool 等內部訊息通常會讓新對話失焦，因此不輸出。
   */
  const ALLOWED_ROLES = new Set(['user', 'assistant']);
  /*
   * 一般 handoff messages 明確排除的 content_type。
   *
   * thoughts / reasoning_recap 不再做 blanket exclusion：
   *   - thoughts[].summary 會正規化到 execution_trace.reasoning_summary。
   *   - reasoning_recap 會正規化到 execution_trace.reasoning_recap。
   *   - thoughts[].content / chunks 等 private / backend-only reasoning body
   *     仍不得輸出。
   *
   * user_editable_context：
   *   使用者設定 / 個人化上下文，不屬於實際對話訊息。
   */
  const EXCLUDED_CONTENT_TYPES = new Set([
    'user_editable_context'
  ]);
  /*
   * 某些 assistant 訊息其實是工具操作內容，而不是一般可讀回覆。
   *
   * 這裡先處理較明顯的非 canmore 工具 payload，例如 web 搜尋、
   * 商品查詢、天氣、計算器等工具呼叫。畫布 / textdocs 相關工具
   * 會另外透過 recipient 與 JSON payload 結構判斷。
   */
  const ASSISTANT_TOOL_OPERATION_KEYS = new Set([
    'search_query',
    'open',
    'find',
    'click',
    'image_query',
    'product_query',
    'sports',
    'finance',
    'weather',
    'calculator',
    'time'
  ]);
  /*
   * 單一對話匯出按鈕使用的 inline SVG。
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
  const COMPLETE_JSON_ICON_SVG = `
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" class="-ms-0.5 icon" fill="none">
          <path d="M12 3v11" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
          <path d="m8 10 4 4 4-4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M5 16v2.5A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5V16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
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
   * 每次輸出時即時計算時間，避免長時間頁面停留後仍使用過期時間。
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
   * 從目前網址取得 /c/ 後方的原始 ID。
   *
   * 這個值可能是正式 conversation UUID，也可能是 ChatGPT 前端在
   * 建立分支對話前使用的暫存 ID。呼叫端必須再檢查是否可匯出。
   */
  function getRawConversationIdFromUrl() {
    const match = location.pathname.match(/\/c\/([^/?#]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  }
  /*
   * 判斷 ID 是否可作為匯出用 conversation ID。
   *
   * 只有正式 UUID 會對應可重新抓取的 backend conversation JSON。
   * 例如 WEB: 開頭的前端暫存 ID 不應顯示匯出按鈕，也不應送往
   * /backend-api/conversation/{conversation_id}。
   */
  function isExportableConversationId(value) {
    return looksLikeUuid(value);
  }
  /*
   * 從目前網址取得可匯出的 conversation ID。
   */
  function getConversationIdFromUrl() {
    const conversationId = getRawConversationIdFromUrl();
    return isExportableConversationId(conversationId) ? conversationId : null;
  }
  /*
   * 判斷目前頁面是否是可匯出的 ChatGPT 對話頁。
   *
   * 支援：
   *   https://chatgpt.com/c/{conversation_id}
   *   https://chatgpt.com/g/.../c/{conversation_id}
   *
   * 不支援尚未建立完成的前端暫存對話 ID。
   */
  function isConversationPage() {
    return Boolean(getConversationIdFromUrl());
  }
  /*
   * 判斷 conversation 相關 endpoint 屬於哪一代。
   *
   * Legacy：
   *   /backend-api/conversation/{conversation_id}
   *   /backend-api/conversation/{conversation_id}/...
   *
   * Current：
   *   /backend-api/conversations/{conversation_id}
   *   /backend-api/conversations/{conversation_id}/...
   *
   * /backend-api/conversations/batch 等非 UUID 路徑不會被誤認。
   */
  function getConversationApiEndpointKind(url) {
    try {
      const parsedUrl = new URL(url, location.origin);
      if (/^\/backend-api\/conversations\/[^/]+(?:\/|$)/.test(parsedUrl.pathname)) {
        return CONVERSATION_ENDPOINT_CURRENT;
      }
      if (/^\/backend-api\/conversation\/[^/]+(?:\/|$)/.test(parsedUrl.pathname)) {
        return CONVERSATION_ENDPOINT_LEGACY;
      }
      return null;
    } catch {
      return null;
    }
  }
  /*
   * 從 ChatGPT raw conversation endpoint 取得 conversation ID。
   *
   * 同時接受 legacy singular 與 current plural endpoint，但只接受精確 raw 路徑，
   * 不把 stream_status、textdocs 等子路徑回應誤認為 raw conversation JSON。
   */
  function getConversationIdFromExactApiUrl(url) {
    try {
      const parsedUrl = new URL(url, location.origin);
      const match = parsedUrl.pathname.match(
        /^\/backend-api\/(?:conversation|conversations)\/([^/]+)\/?$/
      );
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
   * Legacy 與 current endpoint 都可提供 request context；真正 raw JSON 是否為精確
   * endpoint 仍由 getConversationIdFromExactApiUrl() 判斷。
   */
  function getConversationIdFromScopedApiUrl(url) {
    try {
      const parsedUrl = new URL(url, location.origin);
      const match = parsedUrl.pathname.match(
        /^\/backend-api\/(?:conversation|conversations)\/([^/]+)(?:\/|$)/
      );
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
   * 將 conversation timestamp 轉成檔名時間戳。
   *
   * conversation JSON 的數字時間是 Unix seconds；字串時間則交由 Date 解析。
   * getTimestampString() 使用瀏覽器本機時區，維持既有檔名時間語意。
   */
  function getDateFromTimeValue(value) {
    let date = null;
    if (typeof value === 'number' && Number.isFinite(value)) {
      date = new Date(value * 1000);
    } else if (typeof value === 'string' && value.trim()) {
      const stripped = value.trim();
      if (/^[+-]?\d+(?:\.\d+)?$/.test(stripped)) {
        const numeric = Number(stripped);
        if (Number.isFinite(numeric)) {
          date = new Date(numeric * 1000);
        }
      } else {
        const parsed = new Date(stripped);
        if (Number.isFinite(parsed.getTime())) {
          date = parsed;
        }
      }
    }
    return date && Number.isFinite(date.getTime()) ? date : null;
  }
  function getFilenameTimestampFromTimeValue(value) {
    const date = getDateFromTimeValue(value);
    return date ? getTimestampString(date) : null;
  }
  /*
   * 取得目前 conversation 主分支最後一則具有效時間的 message Date。
   *
   * 只沿 current_node 的 parent chain 處理目前有效主分支，不讀取 alternate branch。
   * 優先使用 message.create_time；若該節點缺少 create_time，再使用 update_time。
   * 若所有主分支 message 都缺少時間，最後才退回 conversation.update_time。
   */
  function getConversationLastMessageDate(conversation) {
    try {
      const mapping = conversation && conversation.mapping && typeof conversation.mapping === 'object'
        ? conversation.mapping
        : null;
      const currentNode = conversation && typeof conversation.current_node === 'string'
        ? conversation.current_node
        : null;
      if (mapping && currentNode) {
        const pathNodeIds = resolveMainPath(mapping, currentNode);
        for (let index = pathNodeIds.length - 1; index >= 0; index -= 1) {
          const node = mapping[pathNodeIds[index]];
          const message = node && typeof node.message === 'object' ? node.message : null;
          if (!message) {
            continue;
          }
          const created = getDateFromTimeValue(message.create_time);
          if (created) {
            return created;
          }
          const updated = getDateFromTimeValue(message.update_time);
          if (updated) {
            return updated;
          }
        }
      }
    } catch {
      // 檔名 / ZIP metadata fallback 不得中斷正式匯出。
    }
    return getDateFromTimeValue(conversation && conversation.update_time);
  }
  function getConversationLastMessageTimestamp(conversation) {
    const date = getConversationLastMessageDate(conversation);
    return date ? getTimestampString(date) : null;
  }
  function getConversationCreateDate(conversation) {
    return getDateFromTimeValue(conversation && conversation.create_time);
  }
  /*
   * raw / handoff 檔名使用「目前主分支最後一則訊息時間」。
   *
   * 若 conversation 結構或時間缺失，才退回觸發匯出時的 fallback timestamp。
   */
  function getConversationFilenameTimestamp(conversation, fallbackTimestamp = getTimestampString()) {
    return getConversationLastMessageTimestamp(conversation) || fallbackTimestamp;
  }
  /*
   * 建立 raw conversation JSON 的下載檔名。
   */
  function buildRawFilename(
    rawText,
    conversationId,
    fallbackTimestamp = getTimestampString(),
    conversation = null
  ) {
    const sourceConversation = conversation && typeof conversation === 'object'
      ? conversation
      : (() => {
        try {
          return JSON.parse(rawText);
        } catch {
          return null;
        }
      })();
    const title = sanitizeFilenamePart(
      sourceConversation
        ? getConversationTitle(sourceConversation, conversationId || 'chatgpt-conversation')
        : tryGetTitleFromRawJson(rawText, conversationId)
    );
    const timestamp = getConversationFilenameTimestamp(sourceConversation, fallbackTimestamp);
    return `${title}-${timestamp}.json`;
  }
  /*
   * 建立 textdocs 原始 JSON 的下載檔名。
   *
   * textdocs 不是 conversation 主訊息檔，因此維持觸發匯出時的時間戳。
   */
  function buildTextdocsFilename(rawText, conversationId, timestamp = getTimestampString()) {
    const title = sanitizeFilenamePart(tryGetTitleFromRawJson(rawText, conversationId));
    return `${title}-${timestamp}.textdocs.json`;
  }
  /*
   * 建立 handoff JSON 的下載檔名。
   */
  function buildHandoffFilename(
    rawText,
    conversationId,
    fallbackTimestamp = getTimestampString(),
    conversation = null
  ) {
    const sourceConversation = conversation && typeof conversation === 'object'
      ? conversation
      : (() => {
        try {
          return JSON.parse(rawText);
        } catch {
          return null;
        }
      })();
    const title = sanitizeFilenamePart(
      sourceConversation
        ? getConversationTitle(sourceConversation, conversationId || 'chatgpt-conversation')
        : tryGetTitleFromRawJson(rawText, conversationId)
    );
    const timestamp = getConversationFilenameTimestamp(sourceConversation, fallbackTimestamp);
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
   * Authorization 是重抓必要條件；ChatGPT client context header 用於
   * 確認這是同源前端 API 請求樣板。x-oai-is 只是可用信號之一，
   * 不作唯一條件。實際重抓後仍會驗證 conversation_id。
   */
  function hasReusableAuthHeaders(headers) {
    if (!headers || !headers.has('authorization')) {
      return false;
    }
    const hasLegacyClientContext = (
      headers.has('x-oai-is') ||
      headers.has('oai-session-id') ||
      headers.has('oai-device-id') ||
      headers.has('oai-client-version') ||
      headers.has('oai-client-build-number')
    );
    /*
     * 2026-09 App Shell build 已觀察到新版同源 backend request 使用：
     *   oai-did + x-openai-web-frontend / x-openai-codex-window-type / chatgpt-account-id
     *
     * 仍要求 Authorization + client context；不放寬成只要 Authorization 就接受。
     */
    const hasCurrentClientContext = (
      headers.has('oai-did') &&
      (
        headers.has('x-openai-web-frontend') ||
        headers.has('x-openai-codex-window-type') ||
        headers.has('chatgpt-account-id')
      )
    );
    return hasLegacyClientContext || hasCurrentClientContext;
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
    const exactConversationId = getConversationIdFromExactApiUrl(requestUrl);
    const endpointKind = exactConversationId === conversationId
      ? getConversationApiEndpointKind(requestUrl)
      : null;
    if (endpointKind) {
      latestConversationEndpointKind = endpointKind;
    }
    const replayRequest = {
      url: new URL(requestUrl, location.origin).href,
      headers,
      capturedAt: Date.now(),
      endpointKind
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
  function rememberRawConversation(conversationId, rawText, conversation = null, source = 'observed') {
    const title = conversation ? getConversationTitle(conversation, '') : '';
    capturedRawByConversationId.set(conversationId, {
      rawText,
      capturedAt: Date.now(),
      title,
      source
    });
    logInfo(
      source.startsWith('authoritative')
        ? '已更新可信 conversation JSON。'
        : '已捕捉 conversation JSON。',
      {
        conversationId,
        length: rawText.length,
        source
      }
    );
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
    if (!Object.prototype.hasOwnProperty.call(conversation.mapping, conversation.current_node)) {
      throw new Error('raw JSON 的 current_node 不存在於 mapping 中。');
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
          rememberRawConversation(conversationId, rawText, conversation, 'observed-fetch');
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
   *   - 捕捉成功回應作為 observed JSON，供標題 / 狀態與輔助比較使用。
   *
   * 注意：被動 response 可能已被其他 page script / userscript / extension 改寫，
   * 因此正式 raw / handoff 匯出不會直接把這份 capture 視為 authoritative JSON。
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
    if (
      originalFetch.__chatgptConversationHandoffExporterWrapperVersion ===
      EXPORTER_VERSION
    ) {
      return;
    }
    function interceptedFetch(input, init) {
      const requestUrl = getRequestUrl(input);
      const exactConversationId = getConversationIdFromExactApiUrl(requestUrl);
      const scopedConversationId = getConversationIdFromScopedApiUrl(requestUrl);
      const endpointKind = exactConversationId
        ? getConversationApiEndpointKind(requestUrl)
        : null;
      if (endpointKind) {
        latestConversationEndpointKind = endpointKind;
      }
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
    interceptedFetch.__chatgptConversationHandoffExporterWrapperVersion =
      EXPORTER_VERSION;
    window.fetch = interceptedFetch;
  }
  /*
   * ChatGPT 新版 SPA 可能在 userscript document-start 之後重新指定 window.fetch。
   * 低頻 UI heartbeat 只檢查目前 fetch 是否仍為本版 wrapper；遺失時才重新掛接。
   * 這裡不主動發送任何 API request。
   */
  function ensureFetchInterceptor() {
    const currentFetch = window.fetch;
    if (
      typeof currentFetch === 'function' &&
      currentFetch.__chatgptConversationHandoffExporterWrapperVersion ===
      EXPORTER_VERSION
    ) {
      return;
    }
    installFetchInterceptor();
  }
  /*
   * 建立 authoritative full raw conversation URL。
   *
   * 2026-09 App Shell build 的 plural /conversations/{id} 是分頁 messages schema，
   * 不含 handoff / raw 完整性驗證所需的 mapping。實機診斷已確認 singular
   * /conversation/{id} 仍回傳完整 mapping + current_node，因此正式 raw / handoff
   * 重抓固定使用 singular full endpoint。
   */
  function buildConversationApiUrl(conversationId) {
    return new URL(
      `/backend-api/conversation/${encodeURIComponent(conversationId)}`,
      location.origin
    ).href;
  }
  /*
   * 建立目前 conversation ID 專用的 textdocs endpoint。
   *
   * 本輪沒有新版 textdocs endpoint 的直接 request 證據，因此保留 legacy singular
   * 路徑與既有容錯；raw conversation 的 plural 遷移不在此推測套用。
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
   * 某些 legacy ChatGPT backend 請求會帶有 x-openai-target-path /
   * x-openai-target-route 這類路由提示 header。
   *
   * 若直接重用其他 endpoint 的 request template，這些 header 可能仍指向
   * 原本的 API 路徑，導致實際請求 URL 與 target headers 不一致。
   */
  function applyTargetHeaders(headers, targetPath, targetRoute) {
    headers.set('accept', 'application/json');
    headers.set('x-openai-target-path', targetPath);
    headers.set('x-openai-target-route', targetRoute);
    headers.delete('content-type');
    return headers;
  }
  /*
   * Current plural conversation request 的實際 header 集合中沒有 target path / route。
   * 因此 current branch 不額外製造這兩個 header；若樣板來自其他 endpoint，先移除。
   */
  function applyCurrentConversationHeaders(headers) {
    headers.set('accept', 'application/json');
    headers.delete('content-type');
    headers.delete('x-openai-target-path');
    headers.delete('x-openai-target-route');
    return headers;
  }
  /*
   * 將重用 headers 調整為 authoritative singular full endpoint 使用。
   *
   * endpointKind 描述的是「request context 來源世代」，不是目標 endpoint：
   * - current plural context：保留新版 header 形狀並移除 legacy target hints；
   *   實機診斷已確認這組 context 可直接 GET singular full endpoint。
   * - legacy singular context：維持既有 x-openai-target-* 行為。
   */
  function applyConversationTargetHeaders(headers, conversationId, endpointKind) {
    if (endpointKind === CONVERSATION_ENDPOINT_CURRENT) {
      return applyCurrentConversationHeaders(headers);
    }
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
   * 正式 URL 固定指向 singular full endpoint；來源 endpoint 世代只決定 headers
   * 要沿用 current 形狀或 legacy target hints。
   * 這個函式只在使用者按下匯出按鈕後的抓取流程中使用。
   */
  function getReplayRequestForConversation(conversationId) {
    const replayRequest = replayRequestByConversationId.get(conversationId);
    if (replayRequest) {
      const endpointKind = replayRequest.endpointKind ||
        latestConversationEndpointKind ||
        CONVERSATION_ENDPOINT_CURRENT;
      return {
        url: buildConversationApiUrl(conversationId),
        headers: applyConversationTargetHeaders(
          new Headers(replayRequest.headers),
          conversationId,
          endpointKind
        ),
        capturedAt: replayRequest.capturedAt,
        endpointKind
      };
    }
    if (!latestReplayRequestTemplate) {
      return null;
    }
    const endpointKind = latestConversationEndpointKind ||
      CONVERSATION_ENDPOINT_CURRENT;
    return {
      url: buildConversationApiUrl(conversationId),
      headers: applyConversationTargetHeaders(
        new Headers(latestReplayRequestTemplate.headers),
        conversationId,
        endpointKind
      ),
      capturedAt: latestReplayRequestTemplate.capturedAt,
      endpointKind
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
   * 計算字串以 UTF-8 編碼後的實際 bytes。
   *
   * JSON 完整性判定只記錄長度，不輸出內容。
   */
  function getUtf8ByteLength(value) {
    return new TextEncoder().encode(String(value || '')).byteLength;
  }
  /*
   * 判斷 JavaScript 收到的 body bytes 是否與瀏覽器網路層 decodedBodySize 一致。
   */
  function isBodyByteLengthConsistent(rawByteLength, decodedBodySize) {
    if (!Number.isFinite(rawByteLength) || !Number.isFinite(decodedBodySize) || decodedBodySize <= 0) {
      return false;
    }
    const tolerance = Math.max(
      RESOURCE_TIMING_BYTE_TOLERANCE_MIN,
      Math.ceil(decodedBodySize * RESOURCE_TIMING_BYTE_TOLERANCE_RATIO)
    );
    return Math.abs(rawByteLength - decodedBodySize) <= tolerance;
  }
  /*
   * 建立單次 Resource Timing 探針。
   *
   * 優先使用 PerformanceObserver 只觀察「探針建立後」的新 resource entry，
   * 避免同一 URL 先前已有大量歷史 entry 時配錯 request。
   * 若 observer 不可用，再退回 performance.getEntriesByName()。
   *
   * 這裡不 clear 全域 Resource Timing buffer，也不修改 ChatGPT 自己的 performance 狀態。
   */
  function createResourceTimingProbe(url, initiatorType) {
    const normalizedUrl = new URL(url, location.origin).href;
    const startedAt = performance.now();
    const observedEntries = [];
    let observer = null;
    if (typeof PerformanceObserver === 'function') {
      try {
        observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (
              entry &&
              entry.entryType === 'resource' &&
              entry.name === normalizedUrl &&
              entry.initiatorType === initiatorType &&
              entry.startTime >= startedAt - RESOURCE_TIMING_START_SLOP_MS
            ) {
              observedEntries.push(entry);
            }
          }
        });
        observer.observe({ type: 'resource', buffered: false });
      } catch {
        observer = null;
      }
    }
    return {
      startedAt,
      cancel() {
        if (observer) {
          observer.disconnect();
          observer = null;
        }
      },
      async finish(rawText) {
        /* 讓 PerformanceObserver 有一個 task 的時間送出最後一批 entry。 */
        await new Promise((resolve) => window.setTimeout(resolve, 0));
        if (observer) {
          observer.disconnect();
          observer = null;
        }
        let candidates = observedEntries;
        if (candidates.length === 0) {
          try {
            candidates = performance
              .getEntriesByName(normalizedUrl, 'resource')
              .filter((entry) => {
                return (
                  entry &&
                  entry.initiatorType === initiatorType &&
                  entry.startTime >= startedAt - RESOURCE_TIMING_START_SLOP_MS
                );
              });
          } catch {
            candidates = [];
          }
        }
        const entry = candidates.length > 0
          ? candidates.reduce((latest, current) => {
            return !latest || current.startTime > latest.startTime ? current : latest;
          }, null)
          : null;
        const rawByteLength = getUtf8ByteLength(rawText);
        const decodedBodySize = entry && Number.isFinite(entry.decodedBodySize)
          ? entry.decodedBodySize
          : 0;
        const encodedBodySize = entry && Number.isFinite(entry.encodedBodySize)
          ? entry.encodedBodySize
          : 0;
        const transferSize = entry && Number.isFinite(entry.transferSize)
          ? entry.transferSize
          : 0;
        if (!entry || decodedBodySize <= 0) {
          return {
            status: 'unavailable',
            rawByteLength,
            decodedBodySize,
            encodedBodySize,
            transferSize
          };
        }
        return {
          status: isBodyByteLengthConsistent(rawByteLength, decodedBodySize)
            ? 'match'
            : 'mismatch',
          rawByteLength,
          decodedBodySize,
          encodedBodySize,
          transferSize
        };
      }
    };
  }
  /*
   * 從 current_node 沿 parent 鏈回溯，建立 conversation 主路徑摘要。
   *
   * 只回傳 node ID 與結構狀態，不讀取或輸出訊息內容。
   */
  function analyzeConversationMainPath(conversation) {
    const mapping = conversation && conversation.mapping && typeof conversation.mapping === 'object'
      ? conversation.mapping
      : {};
    const pathNodeIds = [];
    const seen = new Set();
    let currentId = conversation ? conversation.current_node : null;
    let hasCycle = false;
    let missingNodeId = null;
    while (typeof currentId === 'string' && currentId) {
      if (seen.has(currentId)) {
        hasCycle = true;
        break;
      }
      seen.add(currentId);
      const node = mapping[currentId];
      if (!node || typeof node !== 'object') {
        missingNodeId = currentId;
        break;
      }
      pathNodeIds.push(currentId);
      currentId = typeof node.parent === 'string' && node.parent ? node.parent : null;
    }
    return {
      pathNodeIds,
      hasCycle,
      missingNodeId
    };
  }
  /*
   * 建立 conversation 的非敏感完整性摘要。
   *
   * 這些數值只用來比較不同取得通道，不會把 message content、headers、
   * token、cookie 或 raw JSON 寫入 log / 檔案。
   */
  function analyzeConversationIntegrity(conversation, rawText) {
    const mapping = conversation.mapping;
    const mappingNodeIds = Object.keys(mapping);
    const mainPath = analyzeConversationMainPath(conversation);
    let branchCount = 0;
    for (const nodeId of mappingNodeIds) {
      const node = mapping[nodeId];
      if (node && Array.isArray(node.children) && node.children.length > 1) {
        branchCount += 1;
      }
    }
    let visibleRoleTransitionCount = 0;
    let previousVisibleRole = null;
    const chronologicalPath = [...mainPath.pathNodeIds].reverse();
    for (const nodeId of chronologicalPath) {
      const role = mapping[nodeId]?.message?.author?.role;
      if (role !== 'user' && role !== 'assistant') {
        continue;
      }
      if (role !== previousVisibleRole) {
        visibleRoleTransitionCount += 1;
        previousVisibleRole = role;
      }
    }
    return {
      rawByteLength: getUtf8ByteLength(rawText),
      mappingNodeCount: mappingNodeIds.length,
      mainPathNodeCount: mainPath.pathNodeIds.length,
      offMainPathNodeCount: Math.max(0, mappingNodeIds.length - mainPath.pathNodeIds.length),
      branchCount,
      visibleRoleTransitionCount,
      hasMainPathCycle: mainPath.hasCycle,
      missingMainPathNode: mainPath.missingNodeId,
      isLinearMapping:
        !mainPath.hasCycle &&
        !mainPath.missingNodeId &&
        mappingNodeIds.length === mainPath.pathNodeIds.length &&
        branchCount === 0
    };
  }
  /*
   * 判斷兩份 conversation 是否可視為同一個 revision。
   *
   * current_node 必須一致；若兩邊都有 update_time，也必須一致。
   * 這可避免使用者剛好在雙通道驗證期間新增訊息時，把不同 revision 誤判成裁切。
   */
  function isSameConversationRevision(candidateA, candidateB) {
    if (!candidateA || !candidateB) {
      return false;
    }
    const a = candidateA.conversation;
    const b = candidateB.conversation;
    if (
      a.conversation_id !== b.conversation_id ||
      a.current_node !== b.current_node
    ) {
      return false;
    }
    const aUpdateTime = a.update_time ?? null;
    const bUpdateTime = b.update_time ?? null;
    if (aUpdateTime !== null && bUpdateTime !== null && String(aUpdateTime) !== String(bUpdateTime)) {
      return false;
    }
    return true;
  }
  /*
   * 比較 mapping key 集合。
   */
  function isMappingKeySubset(smallerCandidate, largerCandidate) {
    const smallerKeys = Object.keys(smallerCandidate.conversation.mapping);
    const largerMapping = largerCandidate.conversation.mapping;
    return smallerKeys.every((nodeId) => Object.prototype.hasOwnProperty.call(largerMapping, nodeId));
  }
  function compareConversationCandidates(candidateA, candidateB) {
    if (!isSameConversationRevision(candidateA, candidateB)) {
      return 'different-revision';
    }
    const aCount = candidateA.integrity.mappingNodeCount;
    const bCount = candidateB.integrity.mappingNodeCount;
    if (aCount === bCount) {
      return isMappingKeySubset(candidateA, candidateB) && isMappingKeySubset(candidateB, candidateA)
        ? 'equivalent'
        : 'diverged';
    }
    if (aCount > bCount && isMappingKeySubset(candidateB, candidateA)) {
      return 'a-superset';
    }
    if (bCount > aCount && isMappingKeySubset(candidateA, candidateB)) {
      return 'b-superset';
    }
    return 'diverged';
  }
  /*
   * 將安全可重用 headers 套用到 XMLHttpRequest。
   *
   * 若瀏覽器拒絕某個 header，錯誤只顯示 header 名稱，不輸出值。
   */
  function applyReplayHeadersToXhr(xhr, headers) {
    headers.forEach((value, key) => {
      try {
        xhr.setRequestHeader(key, value);
      } catch (error) {
        throw new Error(
          `XHR 無法套用必要 request header「${key}」：${toErrorMessage(error)}`
        );
      }
    });
  }
  /*
   * conversation 正式重抓通道 A：XMLHttpRequest。
   *
   * 這條通道不使用 window.fetch，可避開只攔截 fetch 的第三方修改器。
   * 但 XHR 本身仍可能被其他頁面程式包裝，因此結果仍必須通過 Resource Timing 驗證。
   */
  async function requestConversationViaXhr(replayRequest, onProgress = null) {
    return new Promise((resolve, reject) => {
      let xhr;
      let probe = null;
      try {
        xhr = new XMLHttpRequest();
        xhr.open('GET', replayRequest.url, true);
        xhr.withCredentials = true;
        const xhrHeaders = new Headers(replayRequest.headers);
        xhrHeaders.set('cache-control', 'no-cache');
        applyReplayHeadersToXhr(xhr, xhrHeaders);
        probe = createResourceTimingProbe(replayRequest.url, 'xmlhttprequest');
      } catch (error) {
        probe?.cancel();
        reject(error);
        return;
      }
      try {
        xhr.addEventListener('progress', (event) => {
          if (typeof onProgress !== 'function') {
            return;
          }
          try {
            onProgress({
              loaded: Number.isFinite(event.loaded) ? event.loaded : 0,
              total: Number.isFinite(event.total) ? event.total : 0,
              lengthComputable: Boolean(event.lengthComputable)
            });
          } catch {
            // UI 進度 callback 不得影響 authoritative transport。
          }
        });
        xhr.addEventListener('load', async () => {
          try {
            const rawText = typeof xhr.responseText === 'string' ? xhr.responseText : '';
            const timing = await probe.finish(rawText);
            resolve({
              transport: 'xhr',
              status: xhr.status,
              statusText: xhr.statusText || '',
              contentType: xhr.getResponseHeader('content-type') || '',
              rawText,
              timing
            });
          } catch (error) {
            reject(error);
          }
        }, { once: true });
        xhr.addEventListener('error', () => {
          probe?.cancel();
          reject(new Error('XHR 重新抓取 conversation JSON 時發生網路錯誤。'));
        }, { once: true });
        xhr.addEventListener('abort', () => {
          probe?.cancel();
          reject(new Error('XHR 重新抓取 conversation JSON 已被中止。'));
        }, { once: true });
        xhr.send();
      } catch (error) {
        probe?.cancel();
        reject(error);
      }
    });
  }
  /*
   * conversation 正式重抓通道 B：目前頁面的 window.fetch。
   *
   * 這條通道只在 XHR 無法被 Resource Timing 直接驗證，或偵測到大小不一致時啟用。
   * 它不是預設可信來源，而是第二個獨立比較訊號。
   */
  async function requestConversationViaFetch(replayRequest) {
    const probe = createResourceTimingProbe(replayRequest.url, 'fetch');
    let response;
    let rawText;
    try {
      response = await window.fetch(replayRequest.url, {
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
        headers: new Headers(replayRequest.headers)
      });
      rawText = await response.text();
    } catch (error) {
      probe.cancel();
      throw error;
    }
    const timing = await probe.finish(rawText);
    return {
      transport: 'fetch',
      status: response.status,
      statusText: response.statusText || '',
      contentType: response.headers.get('content-type') || '',
      rawText,
      timing
    };
  }
  /*
   * 將 transport response 解析成可比較的 conversation candidate。
   */
  function validateConversationTransportResult(result, conversationId) {
    if (!result || !Number.isFinite(result.status) || result.status < 200 || result.status >= 300) {
      const status = result && Number.isFinite(result.status) ? result.status : 0;
      const statusText = result?.statusText || '';
      throw new Error(
        `重新抓取 conversation JSON 失敗：HTTP ${status || '未知'} ${statusText}\n\n` +
        getHttpStatusSuggestion(status)
      );
    }
    if (!String(result.contentType || '').includes('application/json')) {
      throw new Error(
        '重新抓取 conversation JSON 失敗：回應不是 JSON。\n\n' +
        `Content-Type: ${result.contentType || '未知'}\n\n` +
        '建議：重新整理頁面並確認對話已正常載入。若仍持續發生，可能是 ChatGPT 前端或內部 endpoint 格式已變更。'
      );
    }
    if (!String(result.rawText || '').trim()) {
      throw new Error('重新抓取 conversation JSON 失敗：response body 為空。');
    }
    const conversation = parseAndValidateRawConversation(result.rawText, conversationId);
    return {
      ...result,
      conversation,
      integrity: analyzeConversationIntegrity(conversation, result.rawText)
    };
  }
  async function tryConversationTransport(transportName, replayRequest, conversationId, onProgress = null) {
    try {
      const rawResult = transportName === 'xhr'
        ? await requestConversationViaXhr(replayRequest, onProgress)
        : await requestConversationViaFetch(replayRequest);
      return {
        candidate: validateConversationTransportResult(rawResult, conversationId),
        error: null
      };
    } catch (error) {
      return {
        candidate: null,
        error
      };
    }
  }
  /*
   * 使用另一個 request 的 network decodedBodySize 驗證 candidate。
   *
   * 只有兩份 response 屬於同一個 conversation revision 時才允許交叉驗證，
   * 避免對話剛好更新時拿舊的 network size 套到新 revision。
   */
  function isCandidateSupportedByOtherTiming(candidate, timingSourceCandidate) {
    if (
      !candidate ||
      !timingSourceCandidate ||
      !isSameConversationRevision(candidate, timingSourceCandidate)
    ) {
      return false;
    }
    const decodedBodySize = timingSourceCandidate.timing?.decodedBodySize || 0;
    return isBodyByteLengthConsistent(candidate.integrity.rawByteLength, decodedBodySize);
  }
  function formatCandidateIntegritySummary(candidate) {
    if (!candidate) {
      return '無有效 response';
    }
    const timing = candidate.timing || {};
    return [
      `${candidate.transport.toUpperCase()} response=${candidate.integrity.rawByteLength} bytes`,
      `network=${timing.decodedBodySize > 0 ? `${timing.decodedBodySize} bytes` : '無法取得'}`,
      `timing=${timing.status || 'unavailable'}`,
      `mapping=${candidate.integrity.mappingNodeCount}`,
      `mainPath=${candidate.integrity.mainPathNodeCount}`,
      `branches=${candidate.integrity.branchCount}`
    ].join('，');
  }
  function buildConversationIntegrityFailureMessage(xhrAttempt, fetchAttempt, reason) {
    const lines = [
      '下載中止：無法確認 conversation JSON 的完整性。',
      '',
      reason,
      ''
    ];
    if (xhrAttempt?.candidate) {
      lines.push(formatCandidateIntegritySummary(xhrAttempt.candidate));
    } else if (xhrAttempt?.error) {
      lines.push(`XHR：${toErrorMessage(xhrAttempt.error)}`);
    }
    if (fetchAttempt?.candidate) {
      lines.push(formatCandidateIntegritySummary(fetchAttempt.candidate));
    } else if (fetchAttempt?.error) {
      lines.push(`Fetch：${toErrorMessage(fetchAttempt.error)}`);
    }
    lines.push(
      '',
      '這可能表示頁面腳本、userscript 或瀏覽器擴充功能修改了 conversation API 回應，',
      '也可能是對話剛好仍在更新，導致兩次請求取得不同 revision。',
      '',
      '為避免產生不完整的 raw / handoff JSON，本次未下載檔案。',
      '建議：等待對話停止更新後再試；若持續發生，請重新整理頁面後重新匯出。'
    );
    return lines.join('\n');
  }
  /*
   * 從 XHR / fetch 候選中選出可被網路大小或雙通道結構支持的可信 response。
   *
   * 原則：
   *   1. 任一通道自身 Resource Timing 明確 match → 直接可信。
   *   2. 某通道 timing mismatch，但另一份同 revision body bytes 能吻合該 network size → 採另一份。
   *   3. 兩邊都沒有 timing 證據時，只接受同 revision 且 mapping 完全一致或一方為嚴格 superset。
   *   4. 已知 mismatch、不同 revision 或無法判斷 → fail closed。
   */
  function selectTrustedConversationCandidate(xhrAttempt, fetchAttempt) {
    const xhrCandidate = xhrAttempt?.candidate || null;
    const fetchCandidate = fetchAttempt?.candidate || null;
    if (xhrCandidate?.timing?.status === 'match') {
      return xhrCandidate;
    }
    if (fetchCandidate?.timing?.status === 'match') {
      return fetchCandidate;
    }
    if (!xhrCandidate && !fetchCandidate) {
      throw new Error(
        buildConversationIntegrityFailureMessage(
          xhrAttempt,
          fetchAttempt,
          '兩個 conversation 取得通道都失敗。'
        )
      );
    }
    if (xhrCandidate && fetchCandidate) {
      const xhrSupportedByFetchTiming = isCandidateSupportedByOtherTiming(xhrCandidate, fetchCandidate);
      const fetchSupportedByXhrTiming = isCandidateSupportedByOtherTiming(fetchCandidate, xhrCandidate);
      if (xhrSupportedByFetchTiming && !fetchSupportedByXhrTiming) {
        return xhrCandidate;
      }
      if (fetchSupportedByXhrTiming && !xhrSupportedByFetchTiming) {
        return fetchCandidate;
      }
      if (
        xhrCandidate.timing?.status === 'mismatch' ||
        fetchCandidate.timing?.status === 'mismatch'
      ) {
        throw new Error(
          buildConversationIntegrityFailureMessage(
            xhrAttempt,
            fetchAttempt,
            '至少一個 JavaScript response body 與瀏覽器實際網路 response 大小明顯不一致。'
          )
        );
      }
      const comparison = compareConversationCandidates(xhrCandidate, fetchCandidate);
      if (comparison === 'equivalent') {
        return xhrCandidate;
      }
      if (comparison === 'a-superset') {
        return xhrCandidate;
      }
      if (comparison === 'b-superset') {
        return fetchCandidate;
      }
      throw new Error(
        buildConversationIntegrityFailureMessage(
          xhrAttempt,
          fetchAttempt,
          comparison === 'different-revision'
            ? '兩個取得通道拿到不同 conversation revision，無法安全判定哪一份是目前完整資料。'
            : '兩個取得通道的 mapping 結構不一致，且不存在可確認的完整 superset。'
        )
      );
    }
    const onlyCandidate = xhrCandidate || fetchCandidate;
    const onlyAttemptName = xhrCandidate ? 'XHR' : 'Fetch';
    if (onlyCandidate.timing?.status === 'mismatch') {
      throw new Error(
        buildConversationIntegrityFailureMessage(
          xhrAttempt,
          fetchAttempt,
          `${onlyAttemptName} response 與瀏覽器實際網路 response 大小不一致，另一通道又無法提供有效驗證。`
        )
      );
    }
    throw new Error(
      buildConversationIntegrityFailureMessage(
        xhrAttempt,
        fetchAttempt,
        `${onlyAttemptName} 雖取得合法 JSON，但缺少可獨立驗證的 Resource Timing，另一通道也無法確認，因此不將它視為原始 authoritative JSON。`
      )
    );
  }
  /*
   * 使用先前被動捕捉的 request context，即時重新抓取目前 conversation。
   *
   * 正式匯出不再直接信任被動 capture，也不再把 window.fetch 的單一路徑
   * 當成 authoritative source。預設先走 XHR；只有無法直接驗證或發現異常時，
   * 才追加 fetch 第二通道，最後由完整性判定挑選可信 snapshot。
   */
  async function refetchLatestConversationSnapshot(conversationId, { onProgress = null } = {}) {
    const replayRequest = getReplayRequestForConversation(conversationId);
    if (!replayRequest) {
      throw new Error(buildMissingRequestContextMessage('conversation JSON'));
    }
    replayRequestByConversationId.set(conversationId, replayRequest);
    const xhrAttempt = await tryConversationTransport('xhr', replayRequest, conversationId, onProgress);
    let fetchAttempt = null;
    if (!xhrAttempt.candidate || xhrAttempt.candidate.timing?.status !== 'match') {
      fetchAttempt = await tryConversationTransport('fetch', replayRequest, conversationId);
    }
    const trustedCandidate = selectTrustedConversationCandidate(xhrAttempt, fetchAttempt);
    rememberRawConversation(
      conversationId,
      trustedCandidate.rawText,
      trustedCandidate.conversation,
      `authoritative-${trustedCandidate.transport}`
    );
    logInfo('conversation JSON 完整性驗證通過。', {
      conversationId,
      transport: trustedCandidate.transport,
      responseBytes: trustedCandidate.integrity.rawByteLength,
      networkBytes: trustedCandidate.timing?.decodedBodySize || null,
      timingStatus: trustedCandidate.timing?.status || 'unavailable',
      mappingNodeCount: trustedCandidate.integrity.mappingNodeCount,
      mainPathNodeCount: trustedCandidate.integrity.mainPathNodeCount,
      branchCount: trustedCandidate.integrity.branchCount
    });
    return {
      rawText: trustedCandidate.rawText,
      conversation: trustedCandidate.conversation,
      integrity: trustedCandidate.integrity,
      transport: trustedCandidate.transport,
      timing: trustedCandidate.timing
    };
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
   * textdocs 取得、解析或完整性驗證失敗時的共同退路。
   *
   * textdocs 是附加資料；失敗時改用空陣列，避免阻斷主要 conversation 匯出。
   */
  function warnAndReturnEmptyTextdocs(message, data = null) {
    logWarn(message, data);
    return [];
  }
  /*
   * textdocs 正式重抓通道 A：XMLHttpRequest。
   *
   * 和 conversation 一樣，預設先使用不經 window.fetch 的 XHR，
   * 再用 Resource Timing 比對 JavaScript body bytes 與瀏覽器網路層 decodedBodySize。
   */
  async function requestTextdocsViaXhr(replayRequest, onProgress = null) {
    return new Promise((resolve, reject) => {
      let xhr;
      let probe = null;
      try {
        xhr = new XMLHttpRequest();
        xhr.open('GET', replayRequest.url, true);
        xhr.withCredentials = true;
        const xhrHeaders = new Headers(replayRequest.headers);
        xhrHeaders.set('cache-control', 'no-cache');
        applyReplayHeadersToXhr(xhr, xhrHeaders);
        probe = createResourceTimingProbe(replayRequest.url, 'xmlhttprequest');
      } catch (error) {
        probe?.cancel();
        reject(error);
        return;
      }
      try {
        xhr.addEventListener('progress', (event) => {
          if (typeof onProgress !== 'function') {
            return;
          }
          try {
            onProgress({
              loaded: Number.isFinite(event.loaded) ? event.loaded : 0,
              total: Number.isFinite(event.total) ? event.total : 0,
              lengthComputable: Boolean(event.lengthComputable)
            });
          } catch {
            // UI 進度 callback 不得影響 textdocs transport。
          }
        });
        xhr.addEventListener('load', async () => {
          try {
            const rawText = typeof xhr.responseText === 'string' ? xhr.responseText : '';
            const timing = await probe.finish(rawText);
            resolve({
              transport: 'xhr',
              status: xhr.status,
              statusText: xhr.statusText || '',
              contentType: xhr.getResponseHeader('content-type') || '',
              rawText,
              timing
            });
          } catch (error) {
            reject(error);
          }
        }, { once: true });
        xhr.addEventListener('error', () => {
          probe?.cancel();
          reject(new Error('XHR 重新抓取 textdocs JSON 時發生網路錯誤。'));
        }, { once: true });
        xhr.addEventListener('abort', () => {
          probe?.cancel();
          reject(new Error('XHR 重新抓取 textdocs JSON 已被中止。'));
        }, { once: true });
        xhr.send();
      } catch (error) {
        probe?.cancel();
        reject(error);
      }
    });
  }
  /*
   * textdocs 正式重抓通道 B：目前頁面的 window.fetch。
   *
   * 只有 XHR 無法由 Resource Timing 直接驗證、或 XHR 取得失敗時才啟用。
   * 這條通道只作第二個比較訊號，不會因為 JSON 可解析就直接視為可信來源。
   */
  async function requestTextdocsViaFetch(replayRequest) {
    const probe = createResourceTimingProbe(replayRequest.url, 'fetch');
    let response;
    let rawText;
    try {
      response = await window.fetch(replayRequest.url, {
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
        headers: new Headers(replayRequest.headers)
      });
      rawText = await response.text();
    } catch (error) {
      probe.cancel();
      throw error;
    }
    const timing = await probe.finish(rawText);
    return {
      transport: 'fetch',
      status: response.status,
      statusText: response.statusText || '',
      contentType: response.headers.get('content-type') || '',
      rawText,
      timing
    };
  }
  /*
   * 建立 textdocs 的非敏感完整性摘要。
   *
   * 只記錄 response bytes 與正規化後的 textdoc 數量，不輸出內容、comment、
   * request headers、token、cookie 或 raw JSON。
   */
  function analyzeTextdocsIntegrity(textdocs, rawText) {
    return {
      rawByteLength: getUtf8ByteLength(rawText),
      textdocCount: Array.isArray(textdocs) ? textdocs.length : 0
    };
  }
  /*
   * 將 transport response 解析成可比較的 textdocs candidate。
   *
   * 204 / 205 / 404 與空 2xx body 沿用既有容錯語意，視為「目前沒有 textdocs」。
   */
  function validateTextdocsTransportResult(result) {
    if (!result || !Number.isFinite(result.status)) {
      throw new Error('重新抓取 textdocs JSON 失敗：無法取得有效 HTTP 狀態。');
    }
    const status = result.status;
    const rawText = String(result.rawText || '');
    if (status === 204 || status === 205 || status === 404) {
      const textdocs = [];
      return {
        ...result,
        textdocs,
        integrity: analyzeTextdocsIntegrity(textdocs, rawText)
      };
    }
    if (status < 200 || status >= 300) {
      throw new Error(
        `重新抓取 textdocs JSON 失敗：HTTP ${status || '未知'} ${result.statusText || ''}`
      );
    }
    if (!rawText.trim()) {
      const textdocs = [];
      return {
        ...result,
        textdocs,
        integrity: analyzeTextdocsIntegrity(textdocs, rawText)
      };
    }
    if (!String(result.contentType || '').includes('application/json')) {
      throw new Error(
        '重新抓取 textdocs JSON 失敗：回應不是 JSON。' +
        ` Content-Type: ${result.contentType || '未知'}`
      );
    }
    const textdocs = parseAndValidateTextdocsRaw(rawText);
    return {
      ...result,
      textdocs,
      integrity: analyzeTextdocsIntegrity(textdocs, rawText)
    };
  }
  async function tryTextdocsTransport(transportName, replayRequest, onProgress = null) {
    try {
      const rawResult = transportName === 'xhr'
        ? await requestTextdocsViaXhr(replayRequest, onProgress)
        : await requestTextdocsViaFetch(replayRequest);
      return {
        candidate: validateTextdocsTransportResult(rawResult),
        error: null
      };
    } catch (error) {
      return {
        candidate: null,
        error
      };
    }
  }
  /*
   * 比較兩個 textdocs candidate 的正規化內容是否完全一致。
   *
   * 只有雙通道 fallback 被啟動時才進行一次序列化比較；平常 XHR timing match
   * 的 fast path 不會額外轉換大型 textdocs。
   */
  function areTextdocsCandidatesEquivalent(candidateA, candidateB) {
    if (!candidateA || !candidateB) {
      return false;
    }
    if (candidateA.integrity.textdocCount !== candidateB.integrity.textdocCount) {
      return false;
    }
    return JSON.stringify(candidateA.textdocs) === JSON.stringify(candidateB.textdocs);
  }
  /*
   * 使用另一個 request 的 network decodedBodySize 交叉驗證 textdocs candidate。
   */
  function isTextdocsCandidateSupportedByOtherTiming(candidate, timingSourceCandidate) {
    if (!candidate || !timingSourceCandidate) {
      return false;
    }
    const decodedBodySize = timingSourceCandidate.timing?.decodedBodySize || 0;
    return isBodyByteLengthConsistent(candidate.integrity.rawByteLength, decodedBodySize);
  }
  function formatTextdocsIntegritySummary(candidate) {
    if (!candidate) {
      return '無有效 response';
    }
    const timing = candidate.timing || {};
    return [
      `${candidate.transport.toUpperCase()} response=${candidate.integrity.rawByteLength} bytes`,
      `network=${timing.decodedBodySize > 0 ? `${timing.decodedBodySize} bytes` : '無法取得'}`,
      `timing=${timing.status || 'unavailable'}`,
      `textdocs=${candidate.integrity.textdocCount}`
    ].join('，');
  }
  function buildTextdocsIntegrityFailureMessage(xhrAttempt, fetchAttempt, reason) {
    const lines = [
      '無法確認 textdocs JSON 的完整性。',
      '',
      reason,
      ''
    ];
    if (xhrAttempt?.candidate) {
      lines.push(formatTextdocsIntegritySummary(xhrAttempt.candidate));
    } else if (xhrAttempt?.error) {
      lines.push(`XHR：${toErrorMessage(xhrAttempt.error)}`);
    }
    if (fetchAttempt?.candidate) {
      lines.push(formatTextdocsIntegritySummary(fetchAttempt.candidate));
    } else if (fetchAttempt?.error) {
      lines.push(`Fetch：${toErrorMessage(fetchAttempt.error)}`);
    }
    lines.push(
      '',
      '這可能表示頁面腳本、userscript 或瀏覽器擴充功能修改了 textdocs API 回應，',
      '也可能是 textdocs 剛好在兩次請求之間更新。',
      '',
      'textdocs 屬於附加資料；為避免把不完整 Canvas / textdoc 內容寫入匯出檔，',
      '本次會略過 textdocs，但不阻斷主要 conversation raw JSON。'
    );
    return lines.join('\n');
  }
  /*
   * 從 XHR / fetch 候選中選出可信 textdocs response。
   *
   * 原則與 conversation 保持一致，但不對 textdocs 做「較大即較完整」的猜測：
   *   1. 任一通道自身 Resource Timing 明確 match → 直接可信。
   *   2. 某通道 body bytes 能吻合另一 request 的 network size → 採該通道。
   *   3. 兩邊都沒有 timing 證據時，只接受正規化 textdocs 完全一致。
   *   4. 已知 mismatch 或兩通道內容不同 → 不猜測哪份較完整，改為略過 textdocs。
   */
  function selectTrustedTextdocsCandidate(xhrAttempt, fetchAttempt) {
    const xhrCandidate = xhrAttempt?.candidate || null;
    const fetchCandidate = fetchAttempt?.candidate || null;
    if (xhrCandidate?.timing?.status === 'match') {
      return xhrCandidate;
    }
    if (fetchCandidate?.timing?.status === 'match') {
      return fetchCandidate;
    }
    if (!xhrCandidate && !fetchCandidate) {
      throw new Error(
        buildTextdocsIntegrityFailureMessage(
          xhrAttempt,
          fetchAttempt,
          '兩個 textdocs 取得通道都失敗。'
        )
      );
    }
    if (xhrCandidate && fetchCandidate) {
      const xhrSupportedByFetchTiming = isTextdocsCandidateSupportedByOtherTiming(xhrCandidate, fetchCandidate);
      const fetchSupportedByXhrTiming = isTextdocsCandidateSupportedByOtherTiming(fetchCandidate, xhrCandidate);
      if (xhrSupportedByFetchTiming && !fetchSupportedByXhrTiming) {
        return xhrCandidate;
      }
      if (fetchSupportedByXhrTiming && !xhrSupportedByFetchTiming) {
        return fetchCandidate;
      }
      if (
        xhrCandidate.timing?.status === 'mismatch' ||
        fetchCandidate.timing?.status === 'mismatch'
      ) {
        throw new Error(
          buildTextdocsIntegrityFailureMessage(
            xhrAttempt,
            fetchAttempt,
            '至少一個 JavaScript response body 與瀏覽器實際網路 response 大小明顯不一致。'
          )
        );
      }
      if (areTextdocsCandidatesEquivalent(xhrCandidate, fetchCandidate)) {
        return xhrCandidate;
      }
      throw new Error(
        buildTextdocsIntegrityFailureMessage(
          xhrAttempt,
          fetchAttempt,
          '兩個取得通道的 textdocs 內容不同，且沒有足夠的網路層證據判定哪一份可信。'
        )
      );
    }
    const onlyCandidate = xhrCandidate || fetchCandidate;
    const onlyAttemptName = xhrCandidate ? 'XHR' : 'Fetch';
    if (onlyCandidate.timing?.status === 'mismatch') {
      throw new Error(
        buildTextdocsIntegrityFailureMessage(
          xhrAttempt,
          fetchAttempt,
          `${onlyAttemptName} response 與瀏覽器實際網路 response 大小不一致，另一通道又無法提供有效驗證。`
        )
      );
    }
    throw new Error(
      buildTextdocsIntegrityFailureMessage(
        xhrAttempt,
        fetchAttempt,
        `${onlyAttemptName} 雖取得可解析的 textdocs，但缺少可獨立驗證的 Resource Timing，另一通道也無法確認。`
      )
    );
  }
  /*
   * 使用先前被動捕捉的 request context，即時重新抓取目前 textdocs。
   *
   * textdocs 現在與 conversation 使用相同的 transport / Resource Timing 原則：
   * 預設 XHR，必要時追加 window.fetch 作第二通道；只有通過完整性判定的
   * candidate 才會進入 .textdocs.json 或 handoff。
   */
  async function refetchLatestTextdocsSnapshot(conversationId, { onProgress = null } = {}) {
    const replayRequest = getReplayRequestForTextdocs(conversationId);
    if (!replayRequest) {
      throw new Error(buildMissingRequestContextMessage('textdocs JSON'));
    }
    const xhrAttempt = await tryTextdocsTransport('xhr', replayRequest, onProgress);
    let fetchAttempt = null;
    if (!xhrAttempt.candidate || xhrAttempt.candidate.timing?.status !== 'match') {
      fetchAttempt = await tryTextdocsTransport('fetch', replayRequest);
    }
    const trustedCandidate = selectTrustedTextdocsCandidate(xhrAttempt, fetchAttempt);
    logInfo('textdocs JSON 完整性驗證通過。', {
      conversationId,
      transport: trustedCandidate.transport,
      responseBytes: trustedCandidate.integrity.rawByteLength,
      networkBytes: trustedCandidate.timing?.decodedBodySize || null,
      timingStatus: trustedCandidate.timing?.status || 'unavailable',
      textdocCount: trustedCandidate.integrity.textdocCount
    });
    return {
      rawText: trustedCandidate.rawText,
      textdocs: trustedCandidate.textdocs,
      integrity: trustedCandidate.integrity,
      transport: trustedCandidate.transport,
      timing: trustedCandidate.timing
    };
  }
  /*
   * 確認匯出流程仍停留在觸發匯出時的 conversation。
   *
   * ChatGPT 是 SPA，路由可能在匯出期間切換。若目前 URL 已不是
   * 觸發匯出時的 conversation ID，應立即中止，避免下載非目標對話。
   */
  function assertConversationStillCurrent(expectedConversationId, stageName = '匯出流程') {
    const currentConversationId = getConversationIdFromUrl();
    if (!expectedConversationId || !currentConversationId) {
      throw new Error(
        `${stageName}中止：目前頁面不是有效的 ChatGPT 對話頁。\n\n` +
        '建議：等待對話頁載入完成後再按一次匯出按鈕。'
      );
    }
    if (currentConversationId !== expectedConversationId) {
      throw new Error(
        `${stageName}中止：目前網址的 conversation ID 已變更。\n\n` +
        `匯出開始時 ID：${expectedConversationId}\n` +
        `目前網址 ID：${currentConversationId}\n\n` +
        '這通常表示 ChatGPT 正在切換對話或頁面尚未載入完成。\n' +
        '建議：等待目前對話完全載入後，再按一次匯出按鈕。'
      );
    }
  }
  /*
   * 確認匯出按鈕記錄的 conversation ID 與目前 URL 一致。
   *
   * SPA 切換後，既有按鈕節點可能保留前一段對話的 ID。
   * 在 click handler 一開始即檢查，可阻止殘留 listener 或 UI 狀態觸發下載。
   */
  function assertButtonConversationMatchesCurrent(button) {
    if (!button || typeof button.getAttribute !== 'function') {
      return;
    }
    const buttonConversationId = button.getAttribute('data-cgpt-export-conversation-id');
    const currentConversationId = getConversationIdFromUrl();
    if (!buttonConversationId || !currentConversationId) {
      return;
    }
    if (buttonConversationId !== currentConversationId) {
      throw new Error(
        '匯出中止：匯出按鈕仍指向上一個對話。\n\n' +
        `按鈕記錄 ID：${buttonConversationId}\n` +
        `目前網址 ID：${currentConversationId}\n\n` +
        '這通常表示 ChatGPT 剛完成 SPA 切換，但匯出按鈕尚未同步更新。\n' +
        '建議：等待頁面穩定後再按一次；若持續發生，請重新整理此對話頁。'
      );
    }
  }
  /*
   * 確認已取得的 conversation snapshot 對應目前匯出的 conversation ID。
   */
  function assertSnapshotConversationMatches(snapshot, expectedConversationId, stageName = '匯出流程') {
    const actualConversationId = snapshot && snapshot.conversation
      ? snapshot.conversation.conversation_id
      : null;
    if (actualConversationId !== expectedConversationId) {
      throw new Error(
        `${stageName}中止：取得的 raw JSON 不屬於目前對話。\n\n` +
        `預期 ID：${expectedConversationId}\n` +
        `raw JSON ID：${actualConversationId || '未知'}\n\n` +
        '為避免匯出舊資料，已停止下載。請重新整理或重新進入目前對話後再試。'
      );
    }
  }
  /*
   * 取得目前對話的 authoritative conversation snapshot。
   *
   * 被動 capture 只保留給 tooltip / 標題與 request context 輔助用途；
   * 正式 raw / handoff 匯出必須重新抓取並通過 transport + Resource Timing 完整性驗證。
   */
  async function getLatestConversationSnapshot(conversationId) {
    assertConversationStillCurrent(conversationId, '取得 raw JSON 前');
    const snapshot = await refetchLatestConversationSnapshot(conversationId);
    assertConversationStillCurrent(conversationId, '重新抓取 raw JSON 後');
    return snapshot;
  }
  /*
   * 取得目前對話的 textdocs 與資料品質狀態。
   *
   * status：
   *   - present：authoritative textdocs snapshot 中至少有一份 textdoc。
   *   - empty：authoritative textdocs snapshot 成功，但陣列為空。
   *   - unavailable：endpoint / request context / transport / integrity 無法可靠取得。
   *
   * handoff schema v2 會把這三種狀態寫入 data_quality，避免「真的沒有」
   * 與「這次抓不到」都被壓成同一個空陣列。
   */
  async function getLatestTextdocsResult(conversationId, { onProgress = null } = {}) {
    try {
      const snapshot = await refetchLatestTextdocsSnapshot(conversationId, { onProgress });
      const textdocs = Array.isArray(snapshot.textdocs) ? snapshot.textdocs : [];
      return {
        textdocs,
        status: textdocs.length > 0 ? 'present' : 'empty'
      };
    } catch (error) {
      const textdocs = warnAndReturnEmptyTextdocs(
        'textdocs 無法通過取得或完整性驗證，改以空 textdocs 繼續。',
        {
          conversationId,
          message: toErrorMessage(error)
        }
      );
      return {
        textdocs,
        status: 'unavailable'
      };
    }
  }
  /*
   * 舊 raw / textdocs 匯出流程只需要陣列，保留相容 wrapper。
   */
  async function getLatestTextdocs(conversationId, { onProgress = null } = {}) {
    const result = await getLatestTextdocsResult(conversationId, { onProgress });
    return result.textdocs;
  }
  /*
   * 下載已驗證的 raw conversation JSON。
   *
   * 這裡只負責格式化與下載，不重新解析或重抓資料。
   * raw 檔名時間戳使用目前主分支最後一則訊息時間；
   * exportTimestamp 只作為來源時間缺失時的 fallback。
   */
  function downloadRawConversation({ rawText, conversation }, conversationId, exportTimestamp) {
    const prettyRawText = JSON.stringify(conversation, null, 4);
    const filename = buildRawFilename(
      rawText,
      conversationId,
      exportTimestamp,
      conversation
    );
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
  function buildHandoffDownloadPayload(
    { rawText, conversation },
    textdocs,
    conversationId,
    exportDate,
    textdocsStatus
  ) {
    const exportedAt = exportDate instanceof Date && Number.isFinite(exportDate.getTime())
      ? exportDate
      : new Date();
    const fallbackTimestamp = getTimestampString(exportedAt);
    const handoff = buildHandoff(conversation, textdocs, {
      exportedAt,
      textdocsStatus
    });
    validateHandoffOrThrow(handoff, conversation);
    const modifiedAt = getConversationLastMessageDate(conversation) || exportedAt;
    const createdAt = getConversationCreateDate(conversation) || modifiedAt;
    return {
      text: JSON.stringify(handoff, null, 4),
      filename: buildHandoffFilename(
        rawText,
        conversationId,
        fallbackTimestamp,
        conversation
      ),
      modifiedAt,
      createdAt
    };
  }
  /*
   * 以指定 conversation ID 建立一份已驗證 handoff payload。
   *
   * enforceCurrentPage=true 供既有單一對話匯出使用，保留 URL / conversation 安全斷言。
   * enforceCurrentPage=false 供使用者確認後的受控批次流程使用；批次目標由 immutable snapshot 決定。
   * 這個 helper 只建立 payload，不下載檔案。
   */
  async function createHandoffPayloadForConversationId(
    conversationId,
    {
      enforceCurrentPage = false,
      onStage = null,
      onConversationProgress = null,
      onTextdocsProgress = null
    } = {}
  ) {
    const reportStage = (stage) => {
      if (typeof onStage !== 'function') {
        return;
      }
      try {
        onStage(stage);
      } catch {
        // UI callback 不得影響 handoff 建置。
      }
    };
    reportStage('conversation-start');
    const snapshot = enforceCurrentPage
      ? await getLatestConversationSnapshot(conversationId)
      : await refetchLatestConversationSnapshot(conversationId, {
        onProgress: onConversationProgress
      });
    assertSnapshotConversationMatches(snapshot, conversationId, '產出交接 JSON 前');
    reportStage('conversation-ready');
    if (enforceCurrentPage) {
      assertConversationStillCurrent(conversationId, '擷取 textdocs 前');
    }
    reportStage('textdocs-start');
    const textdocsResult = await getLatestTextdocsResult(conversationId, {
      onProgress: onTextdocsProgress
    });
    const textdocs = textdocsResult.textdocs;
    if (enforceCurrentPage) {
      assertConversationStillCurrent(conversationId, '擷取 textdocs 後');
    }
    reportStage('textdocs-ready');
    reportStage('handoff-build');
    const exportDate = new Date();
    const handoffPayload = buildHandoffDownloadPayload(
      snapshot,
      textdocs,
      conversationId,
      exportDate,
      textdocsResult.status
    );
    reportStage('handoff-ready');
    if (enforceCurrentPage) {
      assertConversationStillCurrent(conversationId, '下載交接 JSON 前');
    }
    return {
      handoffPayload,
      textdocCount: Array.isArray(textdocs) ? textdocs.length : 0,
      conversationIntegrity: snapshot.integrity || null,
      transport: snapshot.transport || null
    };
  }
  /*
   * 建立已驗證 raw conversation 的文字 payload。
   *
   * 與既有單一 raw 下載相同，輸出 4 空白縮排的 conversation JSON。
   */
  function buildRawDownloadPayload({ rawText, conversation }, conversationId, exportTimestamp) {
    const modifiedAt = getConversationLastMessageDate(conversation) || new Date();
    const createdAt = getConversationCreateDate(conversation) || modifiedAt;
    return {
      text: JSON.stringify(conversation, null, 4),
      filename: buildRawFilename(
        rawText,
        conversationId,
        exportTimestamp,
        conversation
      ),
      modifiedAt,
      createdAt
    };
  }
  /*
   * 建立正規化 textdocs 的文字 payload。
   *
   * 沒有 textdocs 時回傳 null；raw 批次會因此只封裝 conversation JSON。
   */
  function buildTextdocsDownloadPayload(
    textdocs,
    rawText,
    conversationId,
    exportTimestamp,
    conversation = null
  ) {
    if (!Array.isArray(textdocs) || textdocs.length === 0) {
      return null;
    }
    const modifiedAt = getConversationLastMessageDate(conversation) || new Date();
    const createdAt = getConversationCreateDate(conversation) || modifiedAt;
    return {
      text: JSON.stringify(textdocs, null, 4),
      filename: buildTextdocsFilename(rawText, conversationId, exportTimestamp),
      modifiedAt,
      createdAt
    };
  }
  /*
   * 以指定 conversation ID 建立 raw 批次需要的 payload。
   *
   * conversation 仍必須通過 authoritative transport / Resource Timing；
   * textdocs 採既有容錯，無法取得時以空陣列繼續。
   */
  async function createRawPayloadForConversationId(
    conversationId,
    {
      onStage = null,
      onConversationProgress = null,
      onTextdocsProgress = null
    } = {}
  ) {
    const reportStage = (stage) => {
      if (typeof onStage !== 'function') {
        return;
      }
      try {
        onStage(stage);
      } catch {
        // UI callback 不得影響正式資料取得。
      }
    };
    const exportTimestamp = getTimestampString();
    reportStage('conversation-start');
    const snapshot = await refetchLatestConversationSnapshot(conversationId, {
      onProgress: onConversationProgress
    });
    assertSnapshotConversationMatches(snapshot, conversationId, '產出批次原始 JSON 前');
    reportStage('conversation-ready');
    reportStage('textdocs-start');
    const textdocs = await getLatestTextdocs(conversationId, {
      onProgress: onTextdocsProgress
    });
    reportStage('textdocs-ready');
    reportStage('raw-build');
    const rawPayload = buildRawDownloadPayload(snapshot, conversationId, exportTimestamp);
    const textdocsPayload = buildTextdocsDownloadPayload(
      textdocs,
      snapshot.rawText,
      conversationId,
      exportTimestamp,
      snapshot.conversation
    );
    reportStage('raw-ready');
    return {
      rawPayload,
      textdocsPayload,
      textdocCount: Array.isArray(textdocs) ? textdocs.length : 0,
      conversationIntegrity: snapshot.integrity || null,
      transport: snapshot.transport || null
    };
  }
  /*
   * 以單一次 authoritative conversation / textdocs snapshot 同時建立 raw 與 handoff。
   * complete 批次使用此流程，避免 raw 與 handoff 在兩次 request 之間看到不同時間點。
   */
  async function createCompletePayloadForConversationId(
    conversationId,
    {
      onStage = null,
      onConversationProgress = null,
      onTextdocsProgress = null
    } = {}
  ) {
    const reportStage = (stage) => {
      if (typeof onStage !== 'function') return;
      try {
        onStage(stage);
      } catch {
        // UI callback 不得影響正式資料取得。
      }
    };
    const exportDate = new Date();
    const exportTimestamp = getTimestampString(exportDate);
    reportStage('conversation-start');
    const snapshot = await refetchLatestConversationSnapshot(conversationId, {
      onProgress: onConversationProgress
    });
    assertSnapshotConversationMatches(snapshot, conversationId, '產出批次完整 JSON 前');
    reportStage('conversation-ready');
    reportStage('textdocs-start');
    const textdocsResult = await getLatestTextdocsResult(conversationId, {
      onProgress: onTextdocsProgress
    });
    const textdocs = textdocsResult.textdocs;
    reportStage('textdocs-ready');
    reportStage('raw-build');
    const rawPayload = buildRawDownloadPayload(snapshot, conversationId, exportTimestamp);
    const textdocsPayload = buildTextdocsDownloadPayload(
      textdocs,
      snapshot.rawText,
      conversationId,
      exportTimestamp,
      snapshot.conversation
    );
    reportStage('raw-ready');
    reportStage('handoff-build');
    const handoffPayload = buildHandoffDownloadPayload(
      snapshot,
      textdocs,
      conversationId,
      exportDate,
      textdocsResult.status
    );
    reportStage('complete-ready');
    return {
      rawPayload,
      textdocsPayload,
      handoffPayload,
      textdocCount: Array.isArray(textdocs) ? textdocs.length : 0,
      conversationIntegrity: snapshot.integrity || null,
      transport: snapshot.transport || null
    };
  }
  /*
   * 下載 Blob 檔案。
   */
  function downloadBlobFile(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 1000);
  }
  /*
   * ZIP32 / STORE 純封裝 writer。
   *
   * - compression method 固定為 0（STORE），不壓縮。
   * - UTF-8 filename flag 固定開啟。
   * - 不載入 CDN / 第三方套件，也不上傳資料。
   * - 以 Blob parts 累積 local file records，避免建立一個同等大小的連續 ArrayBuffer。
   * - 使用標準 ZIP32；單檔、offset、central directory 或整體結構超過 4 GiB 時停止，
   *   不偷偷改用未實作的 ZIP64。
   */
  let storedZipCrc32Table = null;
  function getStoredZipCrc32Table() {
    if (storedZipCrc32Table) {
      return storedZipCrc32Table;
    }
    const table = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) {
        value = (value & 1)
          ? (0xedb88320 ^ (value >>> 1))
          : (value >>> 1);
      }
      table[index] = value >>> 0;
    }
    storedZipCrc32Table = table;
    return table;
  }
  function calculateStoredZipCrc32(bytes) {
    const table = getStoredZipCrc32Table();
    let crc = 0xffffffff;
    for (let index = 0; index < bytes.length; index += 1) {
      crc = table[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }
  function writeZipUint16(view, offset, value) {
    view.setUint16(offset, value & 0xffff, true);
  }
  function writeZipUint32(view, offset, value) {
    view.setUint32(offset, value >>> 0, true);
  }
  function writeZipUint64(view, offset, value) {
    const numeric = BigInt(value);
    view.setUint32(offset, Number(numeric & 0xffffffffn), true);
    view.setUint32(offset + 4, Number((numeric >> 32n) & 0xffffffffn), true);
  }
  function getZipWindowsFileTime(date) {
    const safeDate = date instanceof Date && Number.isFinite(date.getTime()) ? date : new Date();
    return BigInt(Math.trunc(safeDate.getTime()) + 11644473600000) * 10000n;
  }
  function getZipUnixSeconds(date) {
    const safeDate = date instanceof Date && Number.isFinite(date.getTime()) ? date : new Date();
    return Math.max(0, Math.min(0xffffffff, Math.floor(safeDate.getTime() / 1000)));
  }
  function concatZipExtraFields(...fields) {
    const length = fields.reduce((sum, field) => sum + field.byteLength, 0);
    const result = new Uint8Array(length);
    let offset = 0;
    for (const field of fields) {
      result.set(new Uint8Array(field), offset);
      offset += field.byteLength;
    }
    return result;
  }
  function buildZipNtfsTimestampExtra(modifiedDate, accessedDate, createdDate) {
    const buffer = new ArrayBuffer(36);
    const view = new DataView(buffer);
    writeZipUint16(view, 0, 0x000a);
    writeZipUint16(view, 2, 32);
    writeZipUint32(view, 4, 0);
    writeZipUint16(view, 8, 0x0001);
    writeZipUint16(view, 10, 24);
    writeZipUint64(view, 12, getZipWindowsFileTime(modifiedDate));
    writeZipUint64(view, 20, getZipWindowsFileTime(accessedDate));
    writeZipUint64(view, 28, getZipWindowsFileTime(createdDate));
    return buffer;
  }
  function buildZipExtendedTimestampExtra(modifiedDate, accessedDate, createdDate, central = false) {
    const buffer = new ArrayBuffer(central ? 9 : 17);
    const view = new DataView(buffer);
    writeZipUint16(view, 0, 0x5455);
    writeZipUint16(view, 2, central ? 5 : 13);
    view.setUint8(4, central ? 0x01 : 0x07);
    writeZipUint32(view, 5, getZipUnixSeconds(modifiedDate));
    if (!central) {
      writeZipUint32(view, 9, getZipUnixSeconds(accessedDate));
      writeZipUint32(view, 13, getZipUnixSeconds(createdDate));
    }
    return buffer;
  }
  function buildStoredZipTimestampExtras(modifiedDate, createdDate) {
    const modified = modifiedDate instanceof Date && Number.isFinite(modifiedDate.getTime())
      ? modifiedDate
      : new Date();
    const created = createdDate instanceof Date && Number.isFinite(createdDate.getTime())
      ? createdDate
      : modified;
    const accessed = modified;
    return {
      local: concatZipExtraFields(
        buildZipNtfsTimestampExtra(modified, accessed, created),
        buildZipExtendedTimestampExtra(modified, accessed, created, false)
      ),
      central: concatZipExtraFields(
        buildZipNtfsTimestampExtra(modified, accessed, created),
        buildZipExtendedTimestampExtra(modified, accessed, created, true)
      )
    };
  }
  function getStoredZipDosDateTime(date = new Date()) {
    const year = Math.min(2107, Math.max(1980, date.getFullYear()));
    const dosTime =
      ((date.getHours() & 0x1f) << 11) |
      ((date.getMinutes() & 0x3f) << 5) |
      ((Math.floor(date.getSeconds() / 2)) & 0x1f);
    const dosDate =
      (((year - 1980) & 0x7f) << 9) |
      (((date.getMonth() + 1) & 0x0f) << 5) |
      (date.getDate() & 0x1f);
    return {
      time: dosTime,
      date: dosDate
    };
  }
  function splitZipFilenameForSuffix(filename) {
    for (const suffix of ['.handoff.json', '.textdocs.json', '.json']) {
      if (filename.toLowerCase().endsWith(suffix)) {
        return {
          base: filename.slice(0, -suffix.length),
          extension: filename.slice(-suffix.length)
        };
      }
    }
    const dotIndex = filename.lastIndexOf('.');
    if (dotIndex > 0) {
      return {
        base: filename.slice(0, dotIndex),
        extension: filename.slice(dotIndex)
      };
    }
    return {
      base: filename,
      extension: ''
    };
  }
  function createUniqueStoredZipFilename(filename, usedNames) {
    let candidate = String(filename || 'file');
    if (!usedNames.has(candidate)) {
      usedNames.add(candidate);
      return candidate;
    }
    const { base, extension } = splitZipFilenameForSuffix(candidate);
    let suffixIndex = 2;
    while (usedNames.has(`${base} (${suffixIndex})${extension}`)) {
      suffixIndex += 1;
    }
    candidate = `${base} (${suffixIndex})${extension}`;
    usedNames.add(candidate);
    return candidate;
  }
  function sanitizeStoredZipPathSegment(value, fallback = 'file') {
    return String(value || fallback)
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .replace(/[\\/]/g, '_')
      .replace(/[. ]+$/g, '')
      .trim()
      .slice(0, 240) || fallback;
  }
  function buildStoredZipFolderPath(folderName, filename) {
    const folder = sanitizeStoredZipPathSegment(folderName, 'folder');
    const leaf = sanitizeStoredZipPathSegment(filename, 'file');
    return `${folder}/${leaf}`;
  }
  function createStoredZipBuilder() {
    const encoder = new TextEncoder();
    const parts = [];
    const centralEntries = [];
    const usedNames = new Set();
    let offset = 0;
    let fileCount = 0;
    const ZIP32_MAX = 0xffffffff;
    const ZIP32_MAX_FILES = 0xffff;
    const ensureZip32 = (value, label) => {
      if (!Number.isSafeInteger(value) || value < 0 || value > ZIP32_MAX) {
        throw new Error(`ZIP32 限制：${label} 超過 4 GiB 可表示範圍。`);
      }
    };
    const addTextFileAtPath = (requestedPath, text, modifiedDate = new Date(), createdDate = modifiedDate) => {
      if (fileCount >= ZIP32_MAX_FILES) {
        throw new Error('ZIP32 限制：檔案數量超過 65535。');
      }
      const filename = createUniqueStoredZipFilename(String(requestedPath || 'file'), usedNames);
      const filenameBytes = encoder.encode(filename);
      if (filenameBytes.length > 0xffff) {
        throw new Error('ZIP32 限制：ZIP 內檔名過長。');
      }
      const dataBytes = encoder.encode(String(text));
      const dataSize = dataBytes.byteLength;
      ensureZip32(dataSize, `檔案 ${filename}`);
      const crc32 = calculateStoredZipCrc32(dataBytes);
      const { time, date: dosDate } = getStoredZipDosDateTime(modifiedDate);
      const timestampExtras = buildStoredZipTimestampExtras(modifiedDate, createdDate);
      const flags = 0x0800; // UTF-8 filenames
      const method = 0; // STORE
      const localHeader = new ArrayBuffer(30 + filenameBytes.length + timestampExtras.local.byteLength);
      const localView = new DataView(localHeader);
      writeZipUint32(localView, 0, 0x04034b50);
      writeZipUint16(localView, 4, 20);
      writeZipUint16(localView, 6, flags);
      writeZipUint16(localView, 8, method);
      writeZipUint16(localView, 10, time);
      writeZipUint16(localView, 12, dosDate);
      writeZipUint32(localView, 14, crc32);
      writeZipUint32(localView, 18, dataSize);
      writeZipUint32(localView, 22, dataSize);
      writeZipUint16(localView, 26, filenameBytes.length);
      writeZipUint16(localView, 28, timestampExtras.local.byteLength);
      new Uint8Array(localHeader, 30).set(filenameBytes);
      new Uint8Array(localHeader, 30 + filenameBytes.length).set(timestampExtras.local);
      const localRecordSize = localHeader.byteLength + dataSize;
      ensureZip32(offset, 'local header offset');
      ensureZip32(offset + localRecordSize, 'archive data');
      parts.push(localHeader, dataBytes);
      centralEntries.push({
        filenameBytes,
        crc32,
        dataSize,
        time,
        dosDate,
        flags,
        method,
        centralExtra: timestampExtras.central,
        localHeaderOffset: offset
      });
      offset += localRecordSize;
      fileCount += 1;
      return {
        filename,
        bytes: dataSize,
        crc32
      };
    };
    const addTextFile = (requestedFilename, text, modifiedDate = new Date(), createdDate = modifiedDate) =>
      addTextFileAtPath(
        sanitizeStoredZipPathSegment(requestedFilename, 'file'),
        text,
        modifiedDate,
        createdDate
      );
    const addTextFileInFolder = (
      folderName,
      requestedFilename,
      text,
      modifiedDate = new Date(),
      createdDate = modifiedDate
    ) => addTextFileAtPath(
      buildStoredZipFolderPath(folderName, requestedFilename),
      text,
      modifiedDate,
      createdDate
    );
    const finalize = () => {
      const centralOffset = offset;
      const centralParts = [];
      let centralSize = 0;
      for (const entry of centralEntries) {
        const header = new ArrayBuffer(46 + entry.filenameBytes.length + entry.centralExtra.byteLength);
        const view = new DataView(header);
        writeZipUint32(view, 0, 0x02014b50);
        writeZipUint16(view, 4, 20);
        writeZipUint16(view, 6, 20);
        writeZipUint16(view, 8, entry.flags);
        writeZipUint16(view, 10, entry.method);
        writeZipUint16(view, 12, entry.time);
        writeZipUint16(view, 14, entry.dosDate);
        writeZipUint32(view, 16, entry.crc32);
        writeZipUint32(view, 20, entry.dataSize);
        writeZipUint32(view, 24, entry.dataSize);
        writeZipUint16(view, 28, entry.filenameBytes.length);
        writeZipUint16(view, 30, entry.centralExtra.byteLength);
        writeZipUint16(view, 32, 0);
        writeZipUint16(view, 34, 0);
        writeZipUint16(view, 36, 0);
        writeZipUint32(view, 38, 0);
        writeZipUint32(view, 42, entry.localHeaderOffset);
        new Uint8Array(header, 46).set(entry.filenameBytes);
        new Uint8Array(header, 46 + entry.filenameBytes.length).set(entry.centralExtra);
        centralParts.push(header);
        centralSize += header.byteLength;
      }
      ensureZip32(centralOffset, 'central directory offset');
      ensureZip32(centralSize, 'central directory size');
      ensureZip32(centralOffset + centralSize + 22, 'archive size');
      const endRecord = new ArrayBuffer(22);
      const endView = new DataView(endRecord);
      writeZipUint32(endView, 0, 0x06054b50);
      writeZipUint16(endView, 4, 0);
      writeZipUint16(endView, 6, 0);
      writeZipUint16(endView, 8, fileCount);
      writeZipUint16(endView, 10, fileCount);
      writeZipUint32(endView, 12, centralSize);
      writeZipUint32(endView, 16, centralOffset);
      writeZipUint16(endView, 20, 0);
      return new Blob(
        [...parts, ...centralParts, endRecord],
        { type: 'application/zip' }
      );
    };
    const createCheckpoint = () => ({
      partsLength: parts.length,
      centralEntriesLength: centralEntries.length,
      offset,
      fileCount,
      usedNames: new Set(usedNames)
    });
    const rollback = (checkpoint) => {
      if (!checkpoint) {
        return;
      }
      parts.length = checkpoint.partsLength;
      centralEntries.length = checkpoint.centralEntriesLength;
      offset = checkpoint.offset;
      fileCount = checkpoint.fileCount;
      usedNames.clear();
      for (const name of checkpoint.usedNames) {
        usedNames.add(name);
      }
    };
    return {
      addTextFile,
      addTextFileInFolder,
      createCheckpoint,
      rollback,
      finalize,
      getFileCount: () => fileCount
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
        if (part.trim()) texts.push(part);
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
      }
    }
    return texts.join('\n');
  }
  function hasReadableText(value) {
    return typeof value === 'string' && value.trim().length > 0;
  }
  /*
   * 將 ChatGPT message.content 正規化成純文字。
   *
   * Structure-first：只對明確 private / excluded 結構排除；其他未知 content type
   * 若存在 text / text-like parts / summary / content 純文字，採 Preserve-on-unknown。
   * 只用 trim 判斷是否為空，不改寫原始字串本身。
   */
  function normalizeContentToText(content, role) {
    if (!content || typeof content !== 'object') {
      return hasReadableText(content) ? content : null;
    }
    const contentType = content.content_type;
    if (EXCLUDED_CONTENT_TYPES.has(contentType) || contentType === 'thoughts') {
      return null;
    }
    if (contentType === 'reasoning_recap') {
      return hasReadableText(content.content) ? content.content : null;
    }
    if (contentType === 'text' || contentType === 'multimodal_text') {
      const text = flattenTextLikeParts(content.parts);
      return hasReadableText(text) ? text : null;
    }
    if (hasReadableText(content.text)) {
      return content.text;
    }
    const partText = flattenTextLikeParts(content.parts);
    if (hasReadableText(partText)) {
      return partText;
    }
    if (hasReadableText(content.summary)) {
      return content.summary;
    }
    if (hasReadableText(content.content)) {
      return content.content;
    }
    return null;
  }
  function getInlineReferenceVisibleLabel(ref) {
    if (!ref || typeof ref !== 'object') return null;
    const candidates = [
      ref.name,
      ref.title,
      ref.label,
      ref.display_name,
      ref.display_title,
      ref.product_name,
      ref.product && ref.product.title,
      ref.product && ref.product.name,
      ref.product && ref.product.product_name
    ];
    for (const value of candidates) {
      if (hasReadableText(value)) return value.trim();
    }
    return null;
  }
  function parseInlineMarkerVisibleLabel(marker) {
    const text = String(marker || '');
    const match = /^([A-Za-z0-9_]+)([\s\S]*)$/.exec(text);
    if (!match) return null;
    const type = match[1];
    const payloadText = match[2];
    if (!['product', 'product_entity', 'products', 'entity'].includes(type)) {
      return null;
    }
    try {
      const payload = JSON.parse(payloadText);
      if (Array.isArray(payload)) {
        for (let index = payload.length - 1; index >= 0; index -= 1) {
          if (hasReadableText(payload[index])) return payload[index].trim();
        }
        return null;
      }
      if (payload && typeof payload === 'object') {
        if (type === 'products' && Array.isArray(payload.selections)) {
          const labels = payload.selections
            .map((selection) => Array.isArray(selection) && hasReadableText(selection[1]) ? selection[1].trim() : null)
            .filter(Boolean);
          if (labels.length > 0) return labels.join('；');
        }
        return getInlineReferenceVisibleLabel(payload);
      }
    } catch {
      return null;
    }
    return null;
  }
  /*
   * 以可靠結構還原 structured UI / inline marker 的可見文字。
   * 無法可靠解析時保留原始 marker，不做 blanket removal。
   */
  function removeInlineMarks(text, contentReferences = null) {
    const source = String(text || '');
    const refs = Array.isArray(contentReferences) ? contentReferences : [];
    const exactLabels = new Map();
    for (const ref of refs) {
      if (!ref || typeof ref !== 'object' || !hasReadableText(ref.matched_text)) continue;
      const label = getInlineReferenceVisibleLabel(ref);
      if (label) exactLabels.set(ref.matched_text, label);
    }
    return source.replace(INLINE_MARK_PATTERN, (marker) => {
      const exact = exactLabels.get(marker);
      if (exact) return exact;
      const parsed = parseInlineMarkerVisibleLabel(marker);
      return parsed || marker;
    });
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
  function looksLikeAssistantToolOperation(text, message = null) {
    const stripped = String(text || '').trim();
    if (!stripped || !stripped.startsWith('{') || !stripped.endsWith('}')) {
      return false;
    }
    /*
     * 真正的 tool call 原則上已由 recipient 分流。這裡只保留一個非常窄的
     * fallback：整則內容必須是 JSON 物件，而且 raw metadata 明確標為
     * visually hidden。不能再因一般回答 / Markdown / YAML 內出現 time:、open:
     * 等欄位名稱就把整則 final answer 誤刪。
     */
    const metadata = message && typeof message.metadata === 'object' ? message.metadata : {};
    if (metadata.is_visually_hidden_from_conversation !== true) {
      return false;
    }
    try {
      const parsed = JSON.parse(stripped);
      if (looksLikeCanmoreToolPayloadObject(parsed)) {
        return true;
      }
      if (!isObjectRecord(parsed)) {
        return false;
      }
      const keys = Object.keys(parsed);
      return keys.length > 0 && keys.every((key) => ASSISTANT_TOOL_OPERATION_KEYS.has(key));
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
    if (!source || typeof source !== 'object') {
      return null;
    }
    const rawPubDate =
      typeof source.pub_date === 'string' && source.pub_date.trim()
        ? source.pub_date
        : typeof source.published_at === 'string' && source.published_at.trim()
          ? source.published_at
          : source.time;
    const result = {
      url: typeof source.url === 'string' && source.url.trim() ? source.url.trim() : null,
      title: typeof source.title === 'string' && source.title.trim() ? source.title.trim() : null,
      snippet: typeof source.snippet === 'string' && source.snippet.trim() ? source.snippet.trim() : null,
      pub_date: toReadableTime(rawPubDate),
      attribution: normalizeAttribution(source.attribution)
    };
    return Object.values(result).some((value) => value !== null) ? result : null;
  }
  function canonicalizeCiteUrlForKey(value) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) {
      return null;
    }
    try {
      const url = new URL(text);
      const removable = [];
      for (const [key] of url.searchParams.entries()) {
        if (/^utm_/i.test(key) || /^(?:gclid|fbclid)$/i.test(key)) {
          removable.push(key);
        }
      }
      for (const key of removable) {
        url.searchParams.delete(key);
      }
      const ordered = [...url.searchParams.entries()].sort(([aKey, aValue], [bKey, bValue]) => {
        if (aKey !== bKey) return aKey.localeCompare(bKey);
        return aValue.localeCompare(bValue);
      });
      url.search = '';
      for (const [key, item] of ordered) {
        url.searchParams.append(key, item);
      }
      url.hash = '';
      return url.toString();
    } catch {
      return text;
    }
  }
  function citeSourceKey(source) {
    const canonicalUrl = canonicalizeCiteUrlForKey(source.url);
    if (canonicalUrl) {
      return `url:${canonicalUrl}`;
    }
    return JSON.stringify([
      source.title,
      source.snippet,
      source.pub_date,
      source.attribution
    ]);
  }
  function chooseRicherCiteText(current, candidate) {
    const a = typeof current === 'string' && current.trim() ? current.trim() : null;
    const b = typeof candidate === 'string' && candidate.trim() ? candidate.trim() : null;
    if (!a) return b;
    if (!b) return a;
    return b.length > a.length ? b : a;
  }
  function mergeCiteSource(existing, candidate) {
    if (!existing) {
      return { ...candidate };
    }
    return {
      url: existing.url || candidate.url || null,
      title: chooseRicherCiteText(existing.title, candidate.title),
      snippet: chooseRicherCiteText(existing.snippet, candidate.snippet),
      pub_date: existing.pub_date || candidate.pub_date || null,
      attribution: existing.attribution || candidate.attribution || null
    };
  }
  function dedupeCiteSources(values) {
    const result = [];
    const indexByKey = new Map();
    for (const value of values) {
      const normalized = buildCiteSource(value);
      if (!normalized) {
        continue;
      }
      const key = citeSourceKey(normalized);
      if (indexByKey.has(key)) {
        const index = indexByKey.get(key);
        result[index] = mergeCiteSource(result[index], normalized);
        continue;
      }
      indexByKey.set(key, result.length);
      result.push(normalized);
    }
    return result;
  }
  function appendCiteSourceWithSupportingWebsites(sources, source) {
    const primary = buildCiteSource(source);
    if (primary) {
      sources.push(primary);
    }
    if (source && Array.isArray(source.supporting_websites)) {
      for (const supporting of source.supporting_websites) {
        const item = buildCiteSource(supporting);
        if (item) sources.push(item);
      }
    }
  }
  /*
   * 只保留實際 citation reference 直接攜帶的來源。
   *
   * search_result_groups / metadata.safe_urls 代表搜尋候選池或安全 URL 集合，
   * 不等於最後回答真正引用的來源；舊版把它們全部塞入 cite_sources，會讓
   * handoff 大幅膨脹。只有 content_references / sources_footnote / citations
   * 明確連到回答時才納入，並以 canonical URL 合併 tracking-parameter 重複項。
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
        let addedRichSource = false;
        if (Array.isArray(ref.items)) {
          for (const item of ref.items) {
            if (item && typeof item === 'object') {
              appendCiteSourceWithSupportingWebsites(sources, item);
              addedRichSource = true;
            }
          }
        }
        if (ref.item && typeof ref.item === 'object') {
          appendCiteSourceWithSupportingWebsites(sources, ref.item);
          addedRichSource = true;
        }
        if (Array.isArray(ref.sources)) {
          for (const source of ref.sources) {
            if (source && typeof source === 'object') {
              appendCiteSourceWithSupportingWebsites(sources, source);
              addedRichSource = true;
            }
          }
        }
        if (
          !addedRichSource &&
          typeof ref.matched_text === 'string' &&
          ref.matched_text.includes('cite') &&
          Array.isArray(ref.safe_urls)
        ) {
          for (const url of ref.safe_urls) {
            if (typeof url === 'string' && url.trim()) {
              sources.push(buildCiteSource({ url }));
            }
          }
        }
      }
    }
    if (Array.isArray(metadata.citations)) {
      for (const citation of metadata.citations) {
        if (!citation || typeof citation !== 'object') {
          continue;
        }
        const candidate =
          citation.metadata && typeof citation.metadata === 'object'
            ? citation.metadata
            : citation;
        const source = buildCiteSource(candidate);
        if (source) sources.push(source);
      }
    }
    return dedupeCiteSources(sources);
  }
  /*
   * 取得 message.content 中可供 tool event / recap 使用的自然語言文字。
   *
   * thoughts 不在這裡展開；reasoning summary 只允許由 thoughts[].summary
   * 專用流程讀取，避免誤把 private reasoning body 當成可匯出內容。
   */
  function getMessageContentText(content) {
    if (!content || typeof content !== 'object') {
      return hasReadableText(content) ? content : null;
    }
    const contentType = content.content_type;
    if (contentType === 'thoughts') {
      return null;
    }
    if (contentType === 'reasoning_recap') {
      return hasReadableText(content.content) ? content.content : null;
    }
    if (contentType === 'text' || contentType === 'multimodal_text') {
      const text = flattenTextLikeParts(content.parts);
      return hasReadableText(text) ? text : null;
    }
    if (contentType === 'tether_browsing_display' && hasReadableText(content.summary)) {
      return content.summary;
    }
    if (hasReadableText(content.text)) {
      return content.text;
    }
    const partText = flattenTextLikeParts(content.parts);
    if (hasReadableText(partText)) {
      return partText;
    }
    if (hasReadableText(content.summary)) {
      return content.summary;
    }
    if (hasReadableText(content.content)) {
      return content.content;
    }
    return null;
  }
  function getSafeBasename(value) {
    const text = String(value || '').trim();
    if (!text) {
      return null;
    }
    const pieces = text.split(/[\\/]+/).filter(Boolean);
    return pieces[pieces.length - 1] || text;
  }
  function normalizeSafeLabel(value, maxLength = 120) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text || text.length > maxLength) {
      return null;
    }
    if (/^[a-z][a-z0-9_.:/ -]*$/i.test(text) || /^[\p{L}\p{N}_.:/ -]+$/u.test(text)) {
      return text;
    }
    return null;
  }
  function createHandoffBuildContext(conversation, pathNodeIds, textdocsStatus) {
    const mapping = conversation && conversation.mapping && typeof conversation.mapping === 'object'
      ? conversation.mapping
      : {};
    const mappingNodeIds = Object.keys(mapping);
    let branchPointCount = 0;
    for (const node of Object.values(mapping)) {
      if (
        node &&
        typeof node === 'object' &&
        Array.isArray(node.children) &&
        node.children.length > 1
      ) {
        branchPointCount += 1;
      }
    }
    return {
      sequence: 0,
      nextAttachmentIndex: 0,
      nextArtifactIndex: 0,
      nextExecutionIndex: 0,
      messageIdByRawId: new Map(),
      attachmentIdByRawId: new Map(),
      attachmentIdsByName: new Map(),
      fileCitationByMarker: new Map(),
      textdocSyntheticIdByRawId: new Map(),
      artifactIdByRawId: new Map(),
      rawExecutionIdByMessageId: new Map(),
      executionEventById: new Map(),
      pendingToolEvents: [],
      pendingApprovalEvent: null,
      dataQuality: {
        textdocs_status:
          textdocsStatus === 'present' || textdocsStatus === 'empty' || textdocsStatus === 'unavailable'
            ? textdocsStatus
            : 'unavailable',
        tool_outputs_truncated: 0,
        redactions_applied: 0,
        unresolved_tool_results: 0,
        unresolved_reply_targets: 0,
        unresolved_file_references: 0,
        unresolved_execution_refs: 0,
        omitted_internal_events: 0,
        result_only_tool_events: 0,
        source_tree: {
          mapping_node_count: mappingNodeIds.length,
          main_path_node_count: Array.isArray(pathNodeIds) ? pathNodeIds.length : 0,
          alternate_nodes_omitted: Math.max(
            0,
            mappingNodeIds.length - new Set(pathNodeIds || []).size
          ),
          branch_point_count: branchPointCount
        }
      }
    };
  }
  function nextHandoffSequence(context) {
    context.sequence += 1;
    return context.sequence;
  }
  function nextExecutionId(context) {
    context.nextExecutionIndex += 1;
    return `e${String(context.nextExecutionIndex).padStart(2, '0')}`;
  }
  function nextAttachmentId(context) {
    context.nextAttachmentIndex += 1;
    return `att${String(context.nextAttachmentIndex).padStart(2, '0')}`;
  }
  function nextArtifactId(context) {
    context.nextArtifactIndex += 1;
    return `art${String(context.nextArtifactIndex).padStart(2, '0')}`;
  }
  /*
   * 將已納入 handoff domain 的工具純文字放入 schema。
   *
   * Structure-first / Preserve-on-unknown：此處不做內容型 REDACTED、摘要或
   * 長度截斷；runtime-only 資料必須在更前面的來源 / 結構層排除。
   */
  function buildPreservedToolText(value) {
    const text = String(value ?? '');
    if (!text.trim()) {
      return null;
    }
    return { content: text };
  }
  function addAttachmentNameCandidate(context, name, syntheticId) {
    if (!name || !syntheticId) {
      return;
    }
    let ids = context.attachmentIdsByName.get(name);
    if (!ids) {
      ids = new Set();
      context.attachmentIdsByName.set(name, ids);
    }
    ids.add(syntheticId);
  }
  function resolveUniqueAttachmentIdByName(context, name) {
    const ids = name ? context.attachmentIdsByName.get(name) : null;
    if (!ids || ids.size !== 1) {
      return null;
    }
    return ids.values().next().value || null;
  }
  function registerAttachment(context, source) {
    if (!source || typeof source !== 'object') {
      return null;
    }
    const rawId = typeof source.id === 'string' && source.id.trim() ? source.id.trim() : null;
    const name = getSafeBasename(source.name);
    if (rawId && context.attachmentIdByRawId.has(rawId)) {
      return context.attachmentIdByRawId.get(rawId);
    }
    /*
     * 不同 raw file ID 一律視為不同附件版本。basename 只建立候選索引，
     * 不能再因同名就合併 synthetic ID；這可避免同名 ZIP / JSON 多次上傳時
     * 把不同版本引用成同一個 attXX。
     */
    const syntheticId = nextAttachmentId(context);
    if (rawId) {
      context.attachmentIdByRawId.set(rawId, syntheticId);
    }
    addAttachmentNameCandidate(context, name, syntheticId);
    return syntheticId;
  }
  function buildAttachmentSummary(source, context) {
    if (!source || typeof source !== 'object') {
      return null;
    }
    const id = registerAttachment(context, source);
    if (!id) {
      return null;
    }
    const result = { id };
    const name = getSafeBasename(source.name);
    const mimeType =
      typeof source.mime_type === 'string' && source.mime_type.trim()
        ? source.mime_type.trim()
        : null;
    const size =
      Number.isFinite(source.size)
        ? source.size
        : Number.isFinite(source.size_bytes)
          ? source.size_bytes
          : null;
    if (name) {
      result.name = name;
    }
    if (mimeType) {
      result.mime_type = mimeType;
    }
    if (Number.isFinite(size)) {
      result.size = size;
    }
    if (Number.isFinite(source.width)) {
      result.width = source.width;
    }
    if (Number.isFinite(source.height)) {
      result.height = source.height;
    }
    const safeSource = normalizeSafeLabel(source.source, 80);
    if (safeSource) {
      result.source = safeSource;
    }
    return result;
  }
  function dedupeObjects(values) {
    const result = [];
    const seen = new Set();
    for (const value of values) {
      if (!value || typeof value !== 'object') {
        continue;
      }
      const key = JSON.stringify(value);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      result.push(value);
    }
    return result;
  }
  function extractMessageAttachments(message, context) {
    const metadata = message && typeof message.metadata === 'object' ? message.metadata : {};
    const summaries = [];
    if (Array.isArray(metadata.attachments)) {
      for (const attachment of metadata.attachments) {
        const summary = buildAttachmentSummary(attachment, context);
        if (summary) {
          summaries.push(summary);
        }
      }
    }
    /*
     * 少數 multimodal message 可能只有 content.parts pointer metadata。
     * metadata.attachments 已存在時不再重複建立 fallback。
     */
    if (summaries.length === 0) {
      const content = message && message.content && typeof message.content === 'object'
        ? message.content
        : null;
      const parts = content && Array.isArray(content.parts) ? content.parts : [];
      for (const part of parts) {
        if (
          !part ||
          typeof part !== 'object' ||
          (part.content_type !== 'image_asset_pointer' && part.content_type !== 'asset_pointer')
        ) {
          continue;
        }
        const fallback = {
          size_bytes: Number.isFinite(part.size_bytes) ? part.size_bytes : null,
          width: Number.isFinite(part.width) ? part.width : null,
          height: Number.isFinite(part.height) ? part.height : null,
          mime_type: part.content_type === 'image_asset_pointer' ? 'image/*' : null
        };
        const summary = buildAttachmentSummary(fallback, context);
        if (summary) {
          summaries.push(summary);
        }
      }
    }
    return dedupeObjects(summaries);
  }
  function buildLineRange(start, end) {
    if (!Number.isInteger(start) && !Number.isInteger(end)) {
      return null;
    }
    const result = {};
    if (Number.isInteger(start)) {
      result.start = start;
    }
    if (Number.isInteger(end)) {
      result.end = end;
    }
    return result;
  }
  function parseFileCitationMarkers(value) {
    const text = String(value || '');
    const result = [];
    const pattern = /filecite([^]+)/g;
    let match;
    while ((match = pattern.exec(text))) {
      const parts = match[1].split('').filter(Boolean);
      const markerId = parts[0] || null;
      if (!markerId) continue;
      const item = {
        marker_id: markerId,
        matched_text: match[0]
      };
      for (const part of parts.slice(1)) {
        let range = /^L(\d+)-L(\d+)$/i.exec(part);
        if (range) {
          item.line_range = {
            start: Number(range[1]),
            end: Number(range[2])
          };
          continue;
        }
        range = /^P(\d+)-P(\d+)$/i.exec(part);
        if (range) {
          item.page_range = {
            start: Number(range[1]),
            end: Number(range[2])
          };
        }
      }
      result.push(item);
    }
    return result;
  }
  function indexToolFileCitationMetadata(message, context) {
    const metadata = message && typeof message.metadata === 'object' ? message.metadata : {};
    const citation =
      metadata.citation_metadata && typeof metadata.citation_metadata === 'object' &&
        !Array.isArray(metadata.citation_metadata)
        ? metadata.citation_metadata
        : null;
    if (!citation) {
      return;
    }
    const rawText = getMessageContentText(message && message.content);
    const markers = parseFileCitationMarkers(rawText);
    const uniqueMarkerIds = [...new Set(markers.map((item) => item.marker_id))];
    if (uniqueMarkerIds.length !== 1) {
      return;
    }
    const title = getSafeBasename(citation.title || citation.display_title || citation.path);
    const rawId = typeof citation.id === 'string' && citation.id.trim() ? citation.id.trim() : null;
    if (!title && !rawId) {
      return;
    }
    context.fileCitationByMarker.set(uniqueMarkerIds[0], {
      name: title || null,
      raw_id: rawId
    });
  }
  function resolveFileCitationSource(context, marker) {
    const source = marker && marker.marker_id
      ? context.fileCitationByMarker.get(marker.marker_id)
      : null;
    if (!source) {
      return null;
    }
    let fileId = source.raw_id ? context.attachmentIdByRawId.get(source.raw_id) : null;
    if (!fileId && source.name) {
      fileId = resolveUniqueAttachmentIdByName(context, source.name);
    }
    return {
      fileId: fileId || null,
      name: source.name || null
    };
  }
  function extractAssistantFileReferences(message, context) {
    const metadata = message && typeof message.metadata === 'object' ? message.metadata : {};
    if (!Array.isArray(metadata.content_references)) {
      return [];
    }
    const refs = [];
    for (const ref of metadata.content_references) {
      if (!ref || typeof ref !== 'object') {
        continue;
      }
      if (ref.type === 'file') {
        const result = {};
        const rawId = typeof ref.id === 'string' && ref.id.trim() ? ref.id.trim() : null;
        const name = getSafeBasename(ref.name);
        let fileId = rawId ? context.attachmentIdByRawId.get(rawId) : null;
        if (!fileId && name) {
          fileId = resolveUniqueAttachmentIdByName(context, name);
        }
        if (fileId) {
          result.file_id = fileId;
        }
        if (name) {
          result.name = name;
        }
        const pointer = ref.input_pointer && typeof ref.input_pointer === 'object'
          ? ref.input_pointer
          : {};
        const lineRange = buildLineRange(
          Number.isInteger(pointer.line_range_start)
            ? pointer.line_range_start
            : ref.line_range_start,
          Number.isInteger(pointer.line_range_end)
            ? pointer.line_range_end
            : ref.line_range_end
        );
        if (lineRange) {
          result.line_range = lineRange;
        }
        const pageRange = buildLineRange(ref.page_range_start, ref.page_range_end);
        if (pageRange) {
          result.page_range = pageRange;
        }
        if (typeof ref.snippet === 'string' && ref.snippet.trim()) {
          result.snippet = removeInlineMarks(ref.snippet, metadata.content_references);
        }
        if (!fileId && (rawId || name)) {
          context.dataQuality.unresolved_file_references += 1;
        }
        if (Object.keys(result).length > 0) {
          refs.push(result);
        }
        continue;
      }
      /*
       * 新版 ChatGPT 可能把可讀 filecite 標成 hidden / invalid，ref 本身不再
       * 直接帶 file 欄位。先前工具結果若提供 Citation Marker + citation_metadata，
       * 可保守恢復安全檔名與行範圍；仍標記 citation_status，不把 invalid citation
       * 偽裝成平台已驗證的正式來源。
       */
      const markers = parseFileCitationMarkers(ref.matched_text);
      if (markers.length === 0) {
        continue;
      }
      for (const marker of markers) {
        const source = resolveFileCitationSource(context, marker);
        if (!source) {
          context.dataQuality.unresolved_file_references += 1;
          continue;
        }
        const result = {};
        if (source.fileId) result.file_id = source.fileId;
        if (source.name) result.name = source.name;
        if (marker.line_range) result.line_range = marker.line_range;
        if (marker.page_range) result.page_range = marker.page_range;
        if (ref.invalid === true) {
          result.citation_status = 'invalid';
        } else if (ref.type === 'hidden') {
          result.citation_status = 'hidden';
        }
        refs.push(result);
      }
    }
    return dedupeObjects(refs);
  }
  function getRichReferenceText(value, maxBytes = null) {
    void maxBytes;
    const text = typeof value === 'string' ? removeInlineMarks(value) : '';
    return hasReadableText(text) ? text : null;
  }
  function extractAssistantRichContent(message) {
    const metadata = message && typeof message.metadata === 'object' ? message.metadata : {};
    if (!Array.isArray(metadata.content_references)) {
      return [];
    }
    const allowedTypes = new Set([
      'image_group',
      'product',
      'product_entity',
      'products',
      'entity',
      'file_navlist',
      'nav_list',
      'client_defined_widget',
      'dil'
    ]);
    const result = [];
    for (const ref of metadata.content_references) {
      if (!ref || typeof ref !== 'object' || !allowedTypes.has(ref.type)) {
        continue;
      }
      const item = { type: ref.type };
      if (ref.type === 'product' || ref.type === 'product_entity') {
        const title = getInlineReferenceVisibleLabel(ref);
        if (title) item.title = title;
        const product = ref.product && typeof ref.product === 'object' ? ref.product : null;
        if (product && hasReadableText(product.price)) item.price = product.price;
        if (product && hasReadableText(product.merchants)) item.merchants = product.merchants;
      } else if (ref.type === 'entity') {
        if (typeof ref.name === 'string' && ref.name.trim()) {
          item.name = ref.name.trim();
        }
        if (typeof ref.category === 'string' && ref.category.trim()) {
          item.category = ref.category.trim();
        }
        const disambiguation =
          ref.extra_params &&
            typeof ref.extra_params === 'object' &&
            typeof ref.extra_params.disambiguation === 'string'
            ? ref.extra_params.disambiguation.trim()
            : '';
        if (disambiguation) {
          item.disambiguation = disambiguation;
        }
      } else if (ref.type === 'products') {
        const products = Array.isArray(ref.products) ? ref.products : [];
        item.items = products.map((product) => {
          const productItem = {};
          if (product && typeof product.title === 'string' && product.title.trim()) {
            productItem.title = product.title.trim();
          }
          if (product && typeof product.price === 'string' && product.price.trim()) {
            productItem.price = product.price.trim();
          }
          if (product && typeof product.merchants === 'string' && product.merchants.trim()) {
            productItem.merchants = product.merchants.trim();
          }
          return productItem;
        }).filter((product) => Object.keys(product).length > 0);
      } else if (ref.type === 'file_navlist') {
        const items = Array.isArray(ref.items) ? ref.items : [];
        item.items = items.map((source) => {
          const sourceItem = {};
          const name = getSafeBasename(source && source.name);
          if (name) {
            sourceItem.name = name;
          }
          const description = getRichReferenceText(source && source.description, 4 * 1024);
          if (description) {
            sourceItem.description = description;
          }
          return sourceItem;
        }).filter((source) => Object.keys(source).length > 0);
      } else if (ref.type === 'nav_list') {
        const title = getRichReferenceText(ref.title || ref.alt, 4 * 1024);
        if (title) {
          item.title = title;
        }
        const items = Array.isArray(ref.items) ? ref.items : [];
        item.items = items.map((source) => {
          const sourceItem = buildCiteSource(source || {});
          return sourceItem;
        }).filter((source) =>
          source.url || source.title || source.snippet || source.pub_date || source.attribution
        );
      } else if (ref.type === 'client_defined_widget') {
        const content =
          ref.data &&
            typeof ref.data === 'object' &&
            ref.data.content &&
            typeof ref.data.content === 'object'
            ? ref.data.content
            : null;
        const meta = content && content.meta && typeof content.meta === 'object'
          ? content.meta
          : null;
        const widgetType =
          ref.data && typeof ref.data.widget_type === 'string'
            ? ref.data.widget_type.trim()
            : '';
        if (widgetType) {
          item.widget_type = widgetType;
        }
        if (meta) {
          const title = getRichReferenceText(meta.title, 4 * 1024);
          const description = getRichReferenceText(meta.description, 8 * 1024);
          const footer = getRichReferenceText(meta.footer, 4 * 1024);
          if (title) item.title = title;
          if (description) item.description = description;
          if (footer) item.footer = footer;
        }
      } else if (ref.type === 'dil') {
        if (typeof ref.name === 'string' && ref.name.trim()) {
          item.name = ref.name.trim();
        }
        const label =
          ref.dil &&
            ref.dil.initialState &&
            typeof ref.dil.initialState.label === 'string'
            ? ref.dil.initialState.label.trim()
            : '';
        if (label) {
          item.label = label;
        }
      } else if (ref.type === 'image_group') {
        const images = Array.isArray(ref.items) ? ref.items : [];
        const titles = [];
        for (const image of images) {
          const title =
            image &&
              image.image_result &&
              typeof image.image_result.title === 'string'
              ? image.image_result.title.trim()
              : '';
          if (title) {
            titles.push(title);
          }
        }
        if (titles.length > 0) {
          item.items = titles.map((title) => ({ title }));
        }
      }
      const alt = getRichReferenceText(ref.alt, 8 * 1024);
      if (alt && !item.title && !item.label) {
        item.alt = alt;
      }
      if (Object.keys(item).length > 1) {
        result.push(item);
      }
    }
    return dedupeObjects(result);
  }
  function extractReplyTo(message, context) {
    const metadata = message && typeof message.metadata === 'object' ? message.metadata : {};
    const rawSourceId =
      typeof metadata.targeted_reply_source_message_id === 'string' &&
        metadata.targeted_reply_source_message_id.trim()
        ? metadata.targeted_reply_source_message_id.trim()
        : null;
    const quoteSource =
      typeof metadata.targeted_reply === 'string' && metadata.targeted_reply.trim()
        ? metadata.targeted_reply
        : typeof metadata.targeted_reply_label === 'string' && metadata.targeted_reply_label.trim()
          ? metadata.targeted_reply_label
          : null;
    if (!rawSourceId && !quoteSource) {
      return null;
    }
    const result = {};
    if (rawSourceId) {
      const syntheticId = context.messageIdByRawId.get(rawSourceId);
      if (syntheticId) {
        result.message_id = syntheticId;
      } else {
        context.dataQuality.unresolved_reply_targets += 1;
      }
    }
    if (quoteSource) {
      const quote = removeInlineMarks(quoteSource);
      if (quote) {
        result.quote = quote;
      }
    }
    return Object.keys(result).length > 0 ? result : null;
  }
  function getMessagePhase(message) {
    if (!message || typeof message.channel !== 'string' || !message.channel.trim()) {
      return null;
    }
    const channel = message.channel.trim();
    if (channel === 'final') {
      return 'final_answer';
    }
    if (channel === 'commentary') {
      return 'commentary';
    }
    return channel;
  }
  function getMessageModel(message) {
    const metadata = message && typeof message.metadata === 'object' ? message.metadata : {};
    return typeof metadata.model_slug === 'string' && metadata.model_slug.trim()
      ? metadata.model_slug.trim()
      : null;
  }
  function getMessageReasoningEffort(message) {
    const metadata = message && typeof message.metadata === 'object' ? message.metadata : {};
    return typeof metadata.thinking_effort === 'string' && metadata.thinking_effort.trim()
      ? metadata.thinking_effort.trim()
      : null;
  }
  function buildSourceContext(conversation) {
    return {
      product: 'chatgpt',
      surface: 'web',
      conversation_kind:
        conversation && conversation.gizmo_type === 'snorlax'
          ? 'project'
          : 'general'
    };
  }
  function buildConversationSettings(conversation) {
    const result = {};
    for (const key of [
      'is_temporary_chat',
      'is_do_not_remember',
      'memory_scope',
      'is_study_mode'
    ]) {
      if (conversation && conversation[key] !== null && conversation[key] !== undefined) {
        result[key] = conversation[key];
      }
    }
    return result;
  }
  function buildExecutionProfile(conversation, pathNodeIds) {
    const mapping = conversation && conversation.mapping && typeof conversation.mapping === 'object'
      ? conversation.mapping
      : {};
    const modelsObserved = [];
    const effortsObserved = [];
    const modelSet = new Set();
    const effortSet = new Set();
    let initialModel = null;
    let finalModel = null;
    let initialEffort = null;
    let finalEffort = null;
    for (const nodeId of pathNodeIds || []) {
      const node = mapping[nodeId];
      const message = node && typeof node.message === 'object' ? node.message : null;
      const role =
        message &&
          message.author &&
          typeof message.author === 'object'
          ? message.author.role
          : null;
      if (role !== 'assistant') {
        continue;
      }
      const model = getMessageModel(message);
      if (model) {
        if (!initialModel) {
          initialModel = model;
        }
        finalModel = model;
        if (!modelSet.has(model)) {
          modelSet.add(model);
          modelsObserved.push(model);
        }
      }
      const effort = getMessageReasoningEffort(message);
      if (effort) {
        if (!initialEffort) {
          initialEffort = effort;
        }
        finalEffort = effort;
        if (!effortSet.has(effort)) {
          effortSet.add(effort);
          effortsObserved.push(effort);
        }
      }
    }
    const result = {};
    if (
      conversation &&
      typeof conversation.default_model_slug === 'string' &&
      conversation.default_model_slug.trim()
    ) {
      result.default_model = conversation.default_model_slug.trim();
    }
    if (initialModel) {
      result.initial_model = initialModel;
      result.final_model = finalModel;
      result.models_observed = modelsObserved;
    }
    if (initialEffort) {
      result.initial_reasoning_effort = initialEffort;
      result.final_reasoning_effort = finalEffort;
      result.reasoning_efforts_observed = effortsObserved;
    }
    return result;
  }
  function getReasoningTitle(message) {
    const metadata = message && typeof message.metadata === 'object' ? message.metadata : {};
    return typeof metadata.reasoning_title === 'string' && metadata.reasoning_title.trim()
      ? metadata.reasoning_title.trim()
      : null;
  }
  function getTurnExchangeId(message) {
    const metadata = message && typeof message.metadata === 'object' ? message.metadata : {};
    return typeof metadata.turn_exchange_id === 'string' && metadata.turn_exchange_id.trim()
      ? metadata.turn_exchange_id.trim()
      : null;
  }
  function normalizeToolName(value) {
    const text = typeof value === 'string' ? value.trim() : '';
    return text || 'unknown_tool';
  }
  function parseToolCallObject(message) {
    const text = getMessageContentText(message && message.content);
    if (!text) {
      return null;
    }
    const stripped = text.trim();
    if (!stripped.startsWith('{') || !stripped.endsWith('}')) {
      return null;
    }
    try {
      const parsed = JSON.parse(stripped);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  function getConnectorSafeInfo(message, tool) {
    if (!String(tool || '').startsWith('api_tool')) {
      return { app: null, operation: null };
    }
    const metadata = message && typeof message.metadata === 'object' ? message.metadata : {};
    const invokedResource =
      metadata.invoked_resource && typeof metadata.invoked_resource === 'object'
        ? metadata.invoked_resource
        : null;
    let app = invokedResource
      ? normalizeSafeLabel(invokedResource.app_name, 80)
      : null;
    let operation = null;
    if (invokedResource && typeof invokedResource.resource_uri === 'string') {
      const segments = invokedResource.resource_uri.split('/').filter(Boolean);
      if (segments.length > 0) {
        operation = normalizeSafeLabel(segments[segments.length - 1], 120);
      }
    }
    const parsed = parseToolCallObject(message);
    if (parsed) {
      if (!app && Array.isArray(parsed.paths) && parsed.paths.length === 1) {
        app = normalizeSafeLabel(parsed.paths[0], 80);
      }
      if (typeof parsed.path === 'string' && parsed.path.trim()) {
        const segments = parsed.path.split('/').filter(Boolean);
        if (!app && segments.length > 0 && !/^connector_/i.test(segments[0])) {
          app = normalizeSafeLabel(segments[0], 80);
        }
        if (!operation && segments.length > 0) {
          operation = normalizeSafeLabel(segments[segments.length - 1], 120);
        }
      }
    }
    if (!operation && String(tool || '') !== 'api_tool') {
      const pieces = String(tool || '').split('.');
      operation = normalizeSafeLabel(pieces[pieces.length - 1], 120);
    }
    return { app, operation };
  }
  function inferToolOperation(tool, message) {
    const connector = getConnectorSafeInfo(message, tool);
    if (connector.operation) {
      return connector.operation;
    }
    if (isConnectorTool(tool)) return null;
    if (tool === 'container.exec') return 'exec';
    if (tool === 'container.open_image') return 'open_image';
    if (tool === 'container.download') return 'download';
    if (tool === 'python') return 'execute';
    if (tool === 'file_search') {
      const metadata = message && typeof message.metadata === 'object' ? message.metadata : {};
      return normalizeSafeLabel(metadata.command, 120) || 'read';
    }
    if (tool === 'web.run') {
      const parsed = parseToolCallObject(message);
      if (parsed) {
        const keys = Object.keys(parsed).filter((key) => key !== 'response_length');
        if (keys.length > 0) {
          return keys.slice(0, 4).join('+');
        }
      }
      return 'run';
    }
    const pieces = String(tool || '').split('.');
    return normalizeSafeLabel(pieces[pieces.length - 1], 120);
  }
  function getToolApp(message, tool) {
    const connector = getConnectorSafeInfo(message, tool);
    if (connector.app) {
      return connector.app;
    }
    const metadata = message && typeof message.metadata === 'object' ? message.metadata : {};
    const jit =
      metadata.jit_plugin_data &&
        typeof metadata.jit_plugin_data === 'object'
        ? metadata.jit_plugin_data
        : null;
    const body =
      jit &&
        jit.from_server &&
        typeof jit.from_server === 'object' &&
        jit.from_server.body &&
        typeof jit.from_server.body === 'object'
        ? jit.from_server.body
        : null;
    return body ? normalizeSafeLabel(body.connector_name, 80) : null;
  }
  function isConnectorTool(tool) {
    return String(tool || '').startsWith('api_tool');
  }
  function isCanmoreTool(tool) {
    return String(tool || '').startsWith('canmore.');
  }
  function getToolCallExecutionText(message, tool) {
    if (tool !== 'python') {
      return null;
    }
    const parsed = parseToolCallObject(message);
    const value = parsed && typeof parsed.code === 'string'
      ? parsed.code
      : getMessageContentText(message && message.content);
    return typeof value === 'string' && value.trim() ? value : null;
  }
  function getToolCallExecutionCode(message, tool) {
    return normalizeExecutionCode(getToolCallExecutionText(message, tool));
  }
  function buildToolInput(message, tool, context) {
    const text = tool === 'python'
      ? getToolCallExecutionText(message, tool)
      : getMessageContentText(message && message.content);
    if (!text) {
      return null;
    }
    return buildPreservedToolText(text);
  }
  function buildToolResultSources(message) {
    const sources = extractAssistantCiteSources(message);
    if (sources.length === 0) {
      return null;
    }
    return {
      source_count: sources.length,
      sources
    };
  }
  function detectKnownToolFailure(message, tool) {
    const metadata = message && typeof message.metadata === 'object' ? message.metadata : {};
    const content = message && message.content && typeof message.content === 'object'
      ? message.content
      : {};
    if (content.content_type === 'system_error') {
      return {
        kind: 'system_error',
        name: normalizeSafeLabel(content.name, 160)
      };
    }
    const canvas = metadata.canvas && typeof metadata.canvas === 'object'
      ? metadata.canvas
      : null;
    if (isCanmoreTool(tool) && canvas && canvas.is_failure === true) {
      return {
        kind: 'canvas_error',
        name: normalizeSafeLabel(canvas.error_type, 160)
      };
    }
    return null;
  }
  function buildToolOutput(message, tool, context) {
    const rawText = getMessageContentText(message && message.content);
    const result = {};
    if (rawText) {
      result.content = rawText;
    }
    const sourceResult = tool === 'web.run' ? buildToolResultSources(message) : null;
    if (sourceResult) {
      result.source_count = sourceResult.source_count;
      result.sources = sourceResult.sources;
    }
    return Object.keys(result).length > 0 ? result : null;
  }
  /*
   * 只從 tool result 的可靠結構化 metadata 建立執行 outcome。
   *
   * completion_status 只描述 handoff 是否已收到 tool result；它不代表工具本身
   * 執行成功。像 Python 即使 message.status = finished_successfully，aggregate_result
   * 仍可能是 failed_with_in_kernel_exception 或 cancelled，因此另外輸出 outcome。
   *
   * 不以 ERROR / Traceback / Exception / failed 等自由文字推斷 outcome。
   * 非 Python 工具的 aggregate_result.status=success 目前只能視為 wrapper lifecycle，
   * 除非另有工具專屬的結構化 authority，否則不輸出 outcome。
   */
  function getToolAggregateResult(message) {
    const metadata = message && typeof message.metadata === 'object' ? message.metadata : {};
    const aggregate =
      metadata.aggregate_result && typeof metadata.aggregate_result === 'object'
        ? metadata.aggregate_result
        : null;
    return aggregate && !Array.isArray(aggregate) ? aggregate : null;
  }
  function normalizeToolErrorText(value, context, maxBytes = null) {
    void context;
    void maxBytes;
    if (value === null || value === undefined) {
      return null;
    }
    if (typeof value === 'string') {
      return value.trim() ? value : null;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  function findStructuredToolErrorFallback(aggregate, context) {
    const messages = Array.isArray(aggregate && aggregate.jupyter_messages)
      ? aggregate.jupyter_messages
      : [];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const item = messages[index];
      if (!item || item.msg_type !== 'error' || !item.content || typeof item.content !== 'object') {
        continue;
      }
      const result = {};
      const name = normalizeSafeLabel(item.content.ename, 160);
      const message = normalizeToolErrorText(item.content.evalue, context);
      if (name) result.name = name;
      if (message) result.message = message;
      if (Object.keys(result).length > 0) {
        return result;
      }
    }
    return null;
  }
  function buildToolExecutionOutcome(message, tool, context) {
    const structuredFailure = detectKnownToolFailure(message, tool);
    if (structuredFailure) {
      const error = { kind: structuredFailure.kind };
      if (structuredFailure.name) error.name = structuredFailure.name;
      return { outcome: 'error', error };
    }
    if (tool !== 'python') {
      return null;
    }
    const aggregate = getToolAggregateResult(message);
    if (!aggregate) {
      return null;
    }
    const rawStatus =
      typeof aggregate.status === 'string' && aggregate.status.trim()
        ? aggregate.status.trim().toLowerCase()
        : '';
    const inKernelException =
      aggregate.in_kernel_exception && typeof aggregate.in_kernel_exception === 'object'
        ? aggregate.in_kernel_exception
        : null;
    const systemException = aggregate.system_exception ?? null;
    let outcome = null;
    if (aggregate.timeout_triggered === true) {
      outcome = 'timeout';
    } else if (rawStatus === 'cancelled' || rawStatus === 'canceled') {
      outcome = 'cancelled';
    } else if (
      rawStatus === 'failed_with_in_kernel_exception' ||
      inKernelException ||
      systemException !== null
    ) {
      outcome = 'error';
    } else if (rawStatus === 'success') {
      outcome = 'success';
    }
    if (!outcome) {
      return null;
    }
    const result = { outcome };
    if (outcome !== 'error') {
      return result;
    }
    const error = {};
    if (inKernelException) {
      error.kind = 'in_kernel_exception';
      const name = normalizeSafeLabel(inKernelException.name, 160);
      if (name) error.name = name;
      let message = null;
      if (typeof inKernelException.message === 'string' && inKernelException.message.trim()) {
        message = normalizeToolErrorText(inKernelException.message, context);
      } else if (Array.isArray(inKernelException.args) && inKernelException.args.length > 0) {
        message = normalizeToolErrorText(inKernelException.args[0], context);
      }
      if (message) error.message = message;
    } else if (systemException !== null) {
      error.kind = 'system_exception';
      if (systemException && typeof systemException === 'object') {
        const name = normalizeSafeLabel(systemException.name, 160);
        const message = normalizeToolErrorText(
          systemException.message ?? systemException.error ?? systemException.detail,
          context
        );
        if (name) error.name = name;
        if (message) error.message = message;
      } else {
        const message = normalizeToolErrorText(systemException, context);
        if (message) error.message = message;
      }
    } else {
      error.kind = 'in_kernel_exception';
      const fallback = findStructuredToolErrorFallback(aggregate, context);
      if (fallback) Object.assign(error, fallback);
    }
    result.error = error;
    return result;
  }
  function buildToolArtifacts(message, context) {
    const metadata = message && typeof message.metadata === 'object' ? message.metadata : {};
    if (!Array.isArray(metadata.attachments)) {
      return [];
    }
    const result = [];
    for (const attachment of metadata.attachments) {
      if (!attachment || typeof attachment !== 'object') {
        continue;
      }
      const rawId =
        typeof attachment.id === 'string' && attachment.id.trim()
          ? attachment.id.trim()
          : null;
      let id = rawId ? context.artifactIdByRawId.get(rawId) : null;
      if (!id) {
        id = nextArtifactId(context);
        if (rawId) {
          context.artifactIdByRawId.set(rawId, id);
        }
      }
      const item = { id };
      const name = getSafeBasename(attachment.name);
      if (name) item.name = name;
      if (typeof attachment.mime_type === 'string' && attachment.mime_type.trim()) {
        item.mime_type = attachment.mime_type.trim();
      }
      if (Number.isFinite(attachment.size)) {
        item.size = attachment.size;
      }
      if (Number.isFinite(attachment.width)) {
        item.width = attachment.width;
      }
      if (Number.isFinite(attachment.height)) {
        item.height = attachment.height;
      }
      result.push(item);
    }
    return dedupeObjects(result);
  }
  function buildApprovalFromServer(message) {
    const metadata = message && typeof message.metadata === 'object' ? message.metadata : {};
    const jit =
      metadata.jit_plugin_data &&
        typeof metadata.jit_plugin_data === 'object'
        ? metadata.jit_plugin_data
        : null;
    const fromServer = jit && jit.from_server && typeof jit.from_server === 'object'
      ? jit.from_server
      : null;
    if (!fromServer || fromServer.type !== 'confirm_action') {
      return null;
    }
    const body = fromServer.body && typeof fromServer.body === 'object' ? fromServer.body : {};
    const safety =
      body.tool_call_safety_summary && typeof body.tool_call_safety_summary === 'object'
        ? body.tool_call_safety_summary
        : {};
    const result = {};
    const app = normalizeSafeLabel(body.connector_name, 80);
    const action = normalizeSafeLabel(safety.action_name, 120);
    const title = typeof safety.title === 'string' && safety.title.trim() ? safety.title.trim() : null;
    const description =
      typeof safety.description === 'string' && safety.description.trim()
        ? safety.description.trim()
        : null;
    const dangerLevel = normalizeSafeLabel(safety.danger_level, 40);
    if (app) result.app = app;
    if (action) result.action = action;
    if (title) result.title = title;
    if (description) result.description = description;
    if (dangerLevel) result.danger_level = dangerLevel;
    result.required = true;
    return result;
  }
  function buildApprovalFromClient(message) {
    const metadata = message && typeof message.metadata === 'object' ? message.metadata : {};
    const jit =
      metadata.jit_plugin_data &&
        typeof metadata.jit_plugin_data === 'object'
        ? metadata.jit_plugin_data
        : null;
    const fromClient = jit && jit.from_client && typeof jit.from_client === 'object'
      ? jit.from_client
      : null;
    if (!fromClient || typeof fromClient.type !== 'string' || !fromClient.type.trim()) {
      return null;
    }
    const type = fromClient.type.trim().toLowerCase();
    const result = {
      decision: type
    };
    if (typeof fromClient.remember_answer === 'boolean') {
      result.remember_answer = fromClient.remember_answer;
    }
    return result;
  }
  function areToolNamesCompatible(callTool, resultTool) {
    if (callTool === resultTool) {
      return true;
    }
    if (String(callTool || '').startsWith('api_tool.') && resultTool === 'api_tool') {
      return true;
    }
    if (
      String(callTool || '').startsWith('api_tool.') &&
      String(resultTool || '').startsWith('api_tool.')
    ) {
      return true;
    }
    return false;
  }
  function normalizeExecutionCode(value) {
    const text = typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim() : '';
    return text || null;
  }
  function getToolResultExecutionText(message) {
    const aggregate = getToolAggregateResult(message);
    return aggregate && typeof aggregate.code === 'string' && aggregate.code.trim()
      ? aggregate.code
      : null;
  }
  function getToolResultExecutionCode(message) {
    return normalizeExecutionCode(getToolResultExecutionText(message));
  }
  function hasKnownTurnConflict(event, turnExchangeId) {
    return Boolean(
      turnExchangeId &&
      event &&
      event._turn_exchange_id &&
      turnExchangeId !== event._turn_exchange_id
    );
  }
  function hasKnownOperationConflict(event, resultOperation) {
    return Boolean(
      resultOperation &&
      event &&
      event._operation &&
      event._operation !== resultOperation &&
      isConnectorTool(event.tool)
    );
  }
  function hasKnownExecutionCodeConflict(event, resultCode) {
    if (!resultCode || !event || event.tool !== 'python' || !event._call_code) {
      return false;
    }
    return !(
      resultCode === event._call_code ||
      resultCode.startsWith(event._call_code)
    );
  }
  function candidateMatchesKnownResultFacts(event, resultTool, turnExchangeId, resultOperation, resultCode) {
    return Boolean(
      event &&
      !event._has_output &&
      areToolNamesCompatible(event.tool, resultTool) &&
      !hasKnownTurnConflict(event, turnExchangeId) &&
      !hasKnownOperationConflict(event, resultOperation) &&
      !hasKnownExecutionCodeConflict(event, resultCode)
    );
  }
  function createToolEventFromCall(message, nodeId, rawIndex, context) {
    const rawMessageId =
      typeof message.id === 'string' && message.id.trim()
        ? message.id.trim()
        : nodeId;
    const tool = normalizeToolName(message.recipient);
    const event = {
      id: nextExecutionId(context),
      sequence: nextHandoffSequence(context),
      type: 'tool',
      tool
    };
    const title = getReasoningTitle(message);
    const app = getToolApp(message, tool);
    const operation = inferToolOperation(tool, message);
    const createTime = toReadableTime(message.create_time);
    const input = buildToolInput(message, tool, context);
    if (title) event.title = title;
    if (app) event.app = app;
    if (operation) event.operation = operation;
    if (createTime) event.create_time = createTime;
    if (message.status && message.status !== NORMAL_MESSAGE_STATUS) {
      event.completion_status = message.status;
    } else {
      event.completion_status = 'pending_result';
    }
    if (input) {
      event.input = input;
    }
    event._raw_call_id = rawMessageId || null;
    event._turn_exchange_id = getTurnExchangeId(message);
    event._operation = operation || null;
    event._call_code = getToolCallExecutionCode(message, tool);
    event._raw_index = rawIndex;
    event._has_output = false;
    event._has_call = true;
    context.executionEventById.set(event.id, event);
    context.pendingToolEvents.push(event);
    if (rawMessageId) {
      context.rawExecutionIdByMessageId.set(rawMessageId, event.id);
    }
    if (nodeId) {
      context.rawExecutionIdByMessageId.set(nodeId, event.id);
    }
    return event;
  }
  function findToolEventForResult(message, node, rawIndex, context) {
    const resultTool = normalizeToolName(
      message && message.author && typeof message.author === 'object'
        ? message.author.name
        : null
    );
    const turnExchangeId = getTurnExchangeId(message);
    const resultOperation = inferToolOperation(resultTool, message);
    const resultCode = resultTool === 'python' ? getToolResultExecutionCode(message) : null;
    const candidates = context.pendingToolEvents.filter((event) =>
      candidateMatchesKnownResultFacts(
        event,
        resultTool,
        turnExchangeId,
        resultOperation,
        resultCode
      )
    );
    if (resultCode) {
      const exact = candidates.filter((event) => event._call_code === resultCode);
      if (exact.length === 1) {
        return exact[0];
      }
      const prefixes = candidates
        .filter((event) => event._call_code && resultCode.startsWith(event._call_code))
        .sort((left, right) => right._call_code.length - left._call_code.length);
      if (
        prefixes.length > 0 &&
        (prefixes.length === 1 || prefixes[0]._call_code.length > prefixes[1]._call_code.length)
      ) {
        return prefixes[0];
      }
    }
    const parentIds = [];
    if (node && typeof node.parent === 'string' && node.parent) {
      parentIds.push(node.parent);
    }
    const metadata = message && typeof message.metadata === 'object' ? message.metadata : {};
    if (typeof metadata.parent_id === 'string' && metadata.parent_id) {
      parentIds.push(metadata.parent_id);
    }
    const parentCandidates = [];
    for (const parentId of parentIds) {
      const executionId = context.rawExecutionIdByMessageId.get(parentId);
      const event = executionId ? context.executionEventById.get(executionId) : null;
      if (candidates.includes(event) && !parentCandidates.includes(event)) {
        parentCandidates.push(event);
      }
    }
    if (parentCandidates.length === 1) {
      return parentCandidates[0];
    }
    if (resultOperation && isConnectorTool(resultTool)) {
      const exactOperation = candidates.filter(
        (event) => event._operation && event._operation === resultOperation
      );
      const sameTurnExactOperation = exactOperation.filter(
        (event) => turnExchangeId && event._turn_exchange_id === turnExchangeId
      );
      if (sameTurnExactOperation.length === 1) {
        return sameTurnExactOperation[0];
      }
      if (exactOperation.length === 1) {
        return exactOperation[0];
      }
    }
    if (turnExchangeId) {
      const sameTurn = candidates.filter(
        (event) => event._turn_exchange_id === turnExchangeId
      );
      if (sameTurn.length === 1) {
        return sameTurn[0];
      }
    }
    const nearby = candidates.filter((event) => {
      const distance = rawIndex - event._raw_index;
      return distance >= 0 && distance <= 20;
    });
    return nearby.length === 1 ? nearby[0] : null;
  }
  function createResultOnlyToolEvent(message, nodeId, rawIndex, context) {
    const tool = normalizeToolName(
      message && message.author && typeof message.author === 'object'
        ? message.author.name
        : null
    );
    const event = {
      id: nextExecutionId(context),
      sequence: nextHandoffSequence(context),
      type: 'tool',
      tool
    };
    const title = getReasoningTitle(message);
    const app = getToolApp(message, tool);
    const operation = inferToolOperation(tool, message);
    const createTime = toReadableTime(message.create_time);
    if (title) event.title = title;
    if (app) event.app = app;
    if (operation) event.operation = operation;
    if (createTime) event.create_time = createTime;
    event.completion_status =
      message.status && message.status !== NORMAL_MESSAGE_STATUS
        ? message.status
        : 'completed';
    const output = buildToolOutput(message, tool, context);
    if (output) event.output = output;
    const artifacts = buildToolArtifacts(message, context);
    if (artifacts.length > 0) event.artifacts = artifacts;
    const executionOutcome = buildToolExecutionOutcome(message, tool, context);
    if (executionOutcome) Object.assign(event, executionOutcome);
    applyTextdocReferenceToToolEvent(event, message, context);
    event._raw_index = rawIndex;
    event._has_output = true;
    event._has_call = false;
    context.dataQuality.result_only_tool_events += 1;
    context.executionEventById.set(event.id, event);
    const rawMessageId =
      typeof message.id === 'string' && message.id.trim()
        ? message.id.trim()
        : nodeId;
    if (rawMessageId) context.rawExecutionIdByMessageId.set(rawMessageId, event.id);
    if (nodeId) context.rawExecutionIdByMessageId.set(nodeId, event.id);
    return event;
  }
  function applyToolResultToEvent(event, message, nodeId, context) {
    const tool = event.tool;
    const output = buildToolOutput(message, tool, context);
    const artifacts = buildToolArtifacts(message, context);
    const endTime = toReadableTime(message.create_time);
    const title = getReasoningTitle(message);
    if (output) event.output = output;
    if (artifacts.length > 0) event.artifacts = artifacts;
    const executionOutcome = buildToolExecutionOutcome(message, tool, context);
    if (executionOutcome) Object.assign(event, executionOutcome);
    if (!event.title && title) event.title = title;
    if (endTime) event.end_time = endTime;
    if (tool === 'python') {
      const resultCode = getToolResultExecutionCode(message);
      const resultText = getToolResultExecutionText(message);
      if (
        resultCode &&
        resultText &&
        event._call_code &&
        (resultCode === event._call_code || resultCode.startsWith(event._call_code))
      ) {
        const completed = resultCode !== event._call_code;
        const input = buildPreservedToolText(resultText);
        if (input) {
          if (completed) input.completed_from_execution_record = true;
          event.input = input;
        }
      }
    }
    applyTextdocReferenceToToolEvent(event, message, context);
    event._has_output = true;
    event.completion_status =
      message.status && message.status !== NORMAL_MESSAGE_STATUS
        ? message.status
        : 'completed';
    const rawMessageId =
      typeof message.id === 'string' && message.id.trim()
        ? message.id.trim()
        : nodeId;
    if (rawMessageId) context.rawExecutionIdByMessageId.set(rawMessageId, event.id);
    if (nodeId) context.rawExecutionIdByMessageId.set(nodeId, event.id);
  }
  function buildReasoningSummaryEvents(message, context) {
    const content = message && message.content && typeof message.content === 'object'
      ? message.content
      : null;
    if (!content || content.content_type !== 'thoughts' || !Array.isArray(content.thoughts)) {
      return [];
    }
    const metadata = message && typeof message.metadata === 'object' ? message.metadata : {};
    const sourceIds =
      metadata.inline_cot_expandable_content &&
        typeof metadata.inline_cot_expandable_content === 'object' &&
        Array.isArray(metadata.inline_cot_expandable_content.source_message_ids)
        ? metadata.inline_cot_expandable_content.source_message_ids.filter(
          (value) => typeof value === 'string' && value.trim()
        )
        : [];
    const events = [];
    const seen = new Set();
    for (const thought of content.thoughts) {
      if (!thought || typeof thought !== 'object') continue;
      const summary =
        typeof thought.summary === 'string' && thought.summary.trim()
          ? thought.summary
          : null;
      if (!summary) continue;
      const finished = typeof thought.finished === 'boolean' ? thought.finished : null;
      const dedupeKey = JSON.stringify([summary, finished, sourceIds]);
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      const event = {
        id: nextExecutionId(context),
        sequence: nextHandoffSequence(context),
        type: 'reasoning_summary',
        summary
      };
      const createTime = toReadableTime(message.create_time);
      if (createTime) event.create_time = createTime;
      if (finished !== null) event.finished = finished;
      if (sourceIds.length > 0) event._source_message_ids = [...sourceIds];
      context.executionEventById.set(event.id, event);
      const rawMessageId =
        typeof message.id === 'string' && message.id.trim()
          ? message.id.trim()
          : null;
      if (rawMessageId) context.rawExecutionIdByMessageId.set(rawMessageId, event.id);
      events.push(event);
    }
    return events;
  }
  function buildReasoningRecapEvent(message, context) {
    const content = message && message.content && typeof message.content === 'object'
      ? message.content
      : null;
    if (!content || content.content_type !== 'reasoning_recap') {
      return null;
    }
    const recap =
      typeof content.content === 'string' && content.content.trim()
        ? content.content
        : null;
    if (!recap) {
      return null;
    }
    const event = {
      id: nextExecutionId(context),
      sequence: nextHandoffSequence(context),
      type: 'reasoning_recap',
      content: recap
    };
    const createTime = toReadableTime(message.create_time);
    if (createTime) {
      event.create_time = createTime;
    }
    const metadata = message && typeof message.metadata === 'object' ? message.metadata : {};
    if (Number.isFinite(metadata.finished_duration_sec)) {
      event.duration_seconds = metadata.finished_duration_sec;
    }
    context.executionEventById.set(event.id, event);
    const rawMessageId =
      typeof message.id === 'string' && message.id.trim()
        ? message.id.trim()
        : null;
    if (rawMessageId) {
      context.rawExecutionIdByMessageId.set(rawMessageId, event.id);
    }
    return event;
  }
  function isStableToolName(tool) {
    const value = String(tool || '');
    return Boolean(
      value === 'python' ||
      value === 'file_search' ||
      value === 'web.run' ||
      value.startsWith('container.') ||
      value.startsWith('api_tool') ||
      value.startsWith('canmore.') ||
      value.startsWith('genui.')
    );
  }
  function buildOpaqueToolStatusRecapEvent(message, nodeId, context) {
    const tool = normalizeToolName(
      message && message.author && typeof message.author === 'object'
        ? message.author.name
        : null
    );
    if (isStableToolName(tool)) return null;
    if (getMessageContentText(message && message.content)) return null;
    const metadata = message && typeof message.metadata === 'object' ? message.metadata : {};
    const finishedText =
      typeof metadata.finished_text === 'string' && metadata.finished_text.trim()
        ? metadata.finished_text
        : null;
    if (!finishedText) return null;
    const event = {
      id: nextExecutionId(context),
      sequence: nextHandoffSequence(context),
      type: 'reasoning_recap',
      content: finishedText
    };
    const createTime = toReadableTime(message.create_time);
    if (createTime) event.create_time = createTime;
    if (Number.isFinite(metadata.finished_duration_sec)) {
      event.duration_seconds = metadata.finished_duration_sec;
    }
    context.executionEventById.set(event.id, event);
    const rawMessageId =
      typeof message.id === 'string' && message.id.trim()
        ? message.id.trim()
        : nodeId;
    if (rawMessageId) context.rawExecutionIdByMessageId.set(rawMessageId, event.id);
    if (nodeId) context.rawExecutionIdByMessageId.set(nodeId, event.id);
    return event;
  }
  function isEmptyOpaqueInternalToolMessage(message) {
    const tool = normalizeToolName(
      message && message.author && typeof message.author === 'object'
        ? message.author.name
        : null
    );
    if (isStableToolName(tool)) return false;
    const text = getMessageContentText(message && message.content);
    const metadata = message && typeof message.metadata === 'object' ? message.metadata : {};
    return !text && !metadata.finished_text && !metadata.citation_metadata && !metadata.canvas;
  }
  function handleApprovalToolResult(message, node, nodeId, rawIndex, context) {
    const fromServer = buildApprovalFromServer(message);
    if (fromServer) {
      const event =
        context.pendingApprovalEvent ||
        findToolEventForResult(message, node, rawIndex, context);
      const target =
        event && event.type === 'tool'
          ? event
          : context.pendingToolEvents
            .slice()
            .reverse()
            .find((candidate) => candidate && !candidate.approval);
      if (target) {
        target.approval = fromServer;
        target.completion_status = 'approval_required';
        context.pendingApprovalEvent = target;
        const rawMessageId =
          typeof message.id === 'string' && message.id.trim()
            ? message.id.trim()
            : nodeId;
        if (rawMessageId) {
          context.rawExecutionIdByMessageId.set(rawMessageId, target.id);
        }
        if (nodeId) {
          context.rawExecutionIdByMessageId.set(nodeId, target.id);
        }
        return true;
      }
    }
    const fromClient = buildApprovalFromClient(message);
    if (fromClient && context.pendingApprovalEvent) {
      const target = context.pendingApprovalEvent;
      target.approval = {
        ...(target.approval || {}),
        ...fromClient
      };
      if (fromClient.decision === 'allow') {
        target.completion_status = 'approved';
      } else if (fromClient.decision === 'deny') {
        target.completion_status = 'denied';
      }
      const rawMessageId =
        typeof message.id === 'string' && message.id.trim()
          ? message.id.trim()
          : nodeId;
      if (rawMessageId) {
        context.rawExecutionIdByMessageId.set(rawMessageId, target.id);
      }
      if (nodeId) {
        context.rawExecutionIdByMessageId.set(nodeId, target.id);
      }
      context.pendingApprovalEvent = null;
      return true;
    }
    return false;
  }
  function finalizeExecutionTrace(executionTrace, context) {
    for (const event of context.pendingToolEvents) {
      if (event && event._has_call && !event._has_output && !event.approval) {
        context.dataQuality.unresolved_tool_results += 1;
      }
    }
    for (const event of executionTrace) {
      if (event.type === 'reasoning_summary' && Array.isArray(event._source_message_ids)) {
        const refs = [];
        const seen = new Set();
        for (const rawId of event._source_message_ids) {
          const executionId = context.rawExecutionIdByMessageId.get(rawId);
          if (executionId && executionId !== event.id && !seen.has(executionId)) {
            seen.add(executionId);
            refs.push(executionId);
          } else if (!executionId) {
            context.dataQuality.unresolved_execution_refs += 1;
          }
        }
        if (refs.length > 0) {
          event.tool_event_refs = refs;
        }
      }
      delete event._source_message_ids;
      delete event._raw_call_id;
      delete event._turn_exchange_id;
      delete event._raw_index;
      delete event._has_output;
      delete event._has_call;
      delete event._operation;
      delete event._call_code;
    }
    return executionTrace.sort((left, right) => left.sequence - right.sequence);
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
  function extractMessageItem(node, context, sequence) {
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
    const contentType =
      message.content && typeof message.content === 'object'
        ? message.content.content_type
        : null;
    if (contentType === 'thoughts' || contentType === 'reasoning_recap') {
      return null;
    }
    if (EXCLUDED_CONTENT_TYPES.has(contentType)) {
      return null;
    }
    const rawText = normalizeContentToText(message.content, role);
    let content = rawText;
    if (role === 'assistant' && content) {
      const metadata = message && typeof message.metadata === 'object' ? message.metadata : {};
      content = removeInlineMarks(content, metadata.content_references);
    }
    const attachments = extractMessageAttachments(message, context);
    const richContent =
      role === 'assistant'
        ? extractAssistantRichContent(message)
        : [];
    if (!content && attachments.length === 0 && richContent.length === 0) {
      return null;
    }
    const item = {
      sequence,
      role
    };
    const createTime = toReadableTime(message.create_time);
    const updateTime = toReadableTime(message.update_time);
    if (createTime) {
      item.create_time = createTime;
    }
    if (updateTime) {
      item.update_time = updateTime;
    }
    if (role === 'assistant') {
      const phase = getMessagePhase(message);
      const model = getMessageModel(message);
      const reasoningEffort = getMessageReasoningEffort(message);
      if (phase) item.phase = phase;
      if (model) item.model = model;
      if (reasoningEffort) item.reasoning_effort = reasoningEffort;
    }
    if (
      typeof message.status === 'string' &&
      message.status.trim() &&
      message.status !== NORMAL_MESSAGE_STATUS
    ) {
      item.status = message.status.trim();
    }
    if (content) {
      item.content = content;
    }
    if (attachments.length > 0) {
      item.attachments = attachments;
    }
    if (role === 'assistant') {
      const citeSources = extractAssistantCiteSources(message);
      if (citeSources.length > 0) {
        item.cite_sources = citeSources;
      }
      const fileReferences = extractAssistantFileReferences(message, context);
      if (fileReferences.length > 0) {
        item.file_references = fileReferences;
      }
      if (richContent.length > 0) {
        item.rich_content = richContent;
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
  function getOrderedTextdocEntries(textdocs, lifecycleById = new Map()) {
    if (!Array.isArray(textdocs)) {
      return [];
    }
    return textdocs
      .map((textdoc, originalIndex) => {
        const sourceId = textdoc && typeof textdoc.id === 'string' ? textdoc.id : null;
        const lifecycle = sourceId ? lifecycleById.get(sourceId) : null;
        const sortValue =
          lifecycle && lifecycle.created_at
            ? getTimeSortValue(lifecycle.created_at)
            : getTimeSortValue(textdoc && textdoc.updated_at);
        return { textdoc, originalIndex, sortValue };
      })
      .sort((left, right) => {
        if (left.sortValue !== right.sortValue) return left.sortValue - right.sortValue;
        return left.originalIndex - right.originalIndex;
      });
  }
  function populateTextdocSyntheticIdMap(context, textdocs, lifecycleById = new Map()) {
    const ordered = getOrderedTextdocEntries(textdocs, lifecycleById);
    for (let index = 0; index < ordered.length; index += 1) {
      const textdoc = ordered[index].textdoc;
      const rawId = textdoc && typeof textdoc.id === 'string' && textdoc.id.trim()
        ? textdoc.id.trim()
        : null;
      if (rawId) {
        context.textdocSyntheticIdByRawId.set(
          rawId,
          `td${String(index + 1).padStart(2, '0')}`
        );
      }
    }
  }
  function applyTextdocReferenceToToolEvent(event, message, context) {
    if (!event || !message || !context) return;
    const metadata = message && typeof message.metadata === 'object' ? message.metadata : {};
    const canvas = metadata.canvas && typeof metadata.canvas === 'object' ? metadata.canvas : null;
    if (!canvas || typeof canvas.textdoc_id !== 'string' || !canvas.textdoc_id.trim()) {
      return;
    }
    const ref = context.textdocSyntheticIdByRawId.get(canvas.textdoc_id.trim());
    if (!ref) return;
    event.textdoc_ref = ref;
    if (Number.isFinite(canvas.version)) {
      event.textdoc_version = canvas.version;
    }
  }
  function buildHandoffTextdocs(textdocs, lifecycleById = new Map()) {
    const orderedTextdocs = getOrderedTextdocEntries(textdocs, lifecycleById);
    return orderedTextdocs.map(({ textdoc }, index) => {
      const sourceId = typeof textdoc.id === 'string' ? textdoc.id : null;
      const lifecycle = sourceId ? lifecycleById.get(sourceId) : null;
      const result = {
        id: `td${String(index + 1).padStart(2, '0')}`,
        version: Number.isFinite(textdoc.version) ? textdoc.version : null,
        title: typeof textdoc.title === 'string' ? textdoc.title : null,
        textdoc_type: typeof textdoc.textdoc_type === 'string' ? textdoc.textdoc_type : null
      };
      if (lifecycle && lifecycle.created_at) result.created_at = lifecycle.created_at;
      if (typeof textdoc.updated_at === 'string' && textdoc.updated_at.trim()) {
        result.updated_at = toReadableTime(textdoc.updated_at);
      }
      if (lifecycle && lifecycle.create_source) result.create_source = lifecycle.create_source;
      const lifecycleSummary = buildTextdocLifecycleSummary(textdoc, lifecycle);
      if (Object.keys(lifecycleSummary).length > 0) result.lifecycle = lifecycleSummary;
      result.content = typeof textdoc.content === 'string' ? textdoc.content : '';
      if (isNonEmptyObject(textdoc.metadata)) result.metadata = textdoc.metadata;
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
   * 建立 handoff JSON schema 2.0。
   *
   * 核心結構：
   *   - messages：user / assistant 可讀對話、附件、reply、引用與來源關聯。
   *   - execution_trace：reasoning summary / recap 與正規化 tool event。
   *   - textdocs：Canvas / textdoc 的主要完整內容位置。
   *   - data_quality：未解析 linkage、來源樹省略與相容性計數；正式 handoff 文字不做截斷 / 遮蔽。
   *
   * messages 與 execution_trace 共用 main-path sequence，讓新對話可還原
   * 使用者可理解的工作順序，同時排除 raw tracking ID、private reasoning body
   * 與敏感驗證資訊。
   */
  function buildHandoff(
    conversation,
    textdocs = [],
    {
      exportedAt = new Date(),
      textdocsStatus = 'unavailable'
    } = {}
  ) {
    const mapping = getMapping(conversation);
    const currentNode = conversation.current_node;
    const pathNodeIds = resolveMainPath(mapping, currentNode);
    const context = createHandoffBuildContext(
      conversation,
      pathNodeIds,
      textdocsStatus
    );
    const textdocLifecycleById = extractTextdocLifecycle(conversation, pathNodeIds);
    populateTextdocSyntheticIdMap(context, textdocs, textdocLifecycleById);
    const messages = [];
    const executionTrace = [];
    let userIndex = 0;
    let assistantIndex = 0;
    for (let rawIndex = 0; rawIndex < pathNodeIds.length; rawIndex += 1) {
      const nodeId = pathNodeIds[rawIndex];
      const node = mapping[nodeId];
      if (!node || typeof node !== 'object') {
        continue;
      }
      const message = node.message && typeof node.message === 'object' ? node.message : null;
      if (!message) {
        continue;
      }
      const author = message.author && typeof message.author === 'object' ? message.author : {};
      const role = author.role;
      const contentType =
        message.content && typeof message.content === 'object'
          ? message.content.content_type
          : null;
      if (role === 'assistant' && contentType === 'thoughts') {
        const events = buildReasoningSummaryEvents(message, context);
        executionTrace.push(...events);
        continue;
      }
      if (role === 'assistant' && contentType === 'reasoning_recap') {
        const event = buildReasoningRecapEvent(message, context);
        if (event) {
          executionTrace.push(event);
        }
        continue;
      }
      if (role === 'assistant' && hasAssistantToolRecipient(message)) {
        const event = createToolEventFromCall(
          message,
          nodeId,
          rawIndex,
          context
        );
        executionTrace.push(event);
        continue;
      }
      if (role === 'tool') {
        indexToolFileCitationMetadata(message, context);
        const opaqueStatus = buildOpaqueToolStatusRecapEvent(message, nodeId, context);
        if (opaqueStatus) {
          executionTrace.push(opaqueStatus);
          continue;
        }
        if (isEmptyOpaqueInternalToolMessage(message)) {
          context.dataQuality.omitted_internal_events += 1;
          continue;
        }
        if (handleApprovalToolResult(message, node, nodeId, rawIndex, context)) {
          continue;
        }
        const event = findToolEventForResult(
          message,
          node,
          rawIndex,
          context
        );
        if (event) {
          applyToolResultToEvent(event, message, nodeId, context);
        } else {
          const resultOnlyEvent = createResultOnlyToolEvent(
            message,
            nodeId,
            rawIndex,
            context
          );
          executionTrace.push(resultOnlyEvent);
        }
        continue;
      }
      /*
       * 一般 user / assistant message 只有在確定會輸出後才正式消耗 sequence，
       * 避免跳過的內部節點造成 handoff sequence 缺口。
       */
      const candidateSequence = context.sequence + 1;
      const item = extractMessageItem(node, context, candidateSequence);
      if (!item) {
        continue;
      }
      context.sequence = candidateSequence;
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
      const rawMessageId =
        typeof message.id === 'string' && message.id.trim()
          ? message.id.trim()
          : nodeId;
      if (rawMessageId) {
        context.messageIdByRawId.set(rawMessageId, messageId);
      }
      if (nodeId) {
        context.messageIdByRawId.set(nodeId, messageId);
      }
      /*
       * reply_to 來源通常在前面，但少數 raw 結構可能在 message ID 映射建立後
       * 才能補齊，因此再做一次安全重建。
       */
      const replyTo = extractReplyTo(message, context);
      if (replyTo) {
        item.reply_to = replyTo;
      }
      messages.push({
        id: messageId,
        ...item
      });
    }
    const finalizedExecutionTrace = finalizeExecutionTrace(
      executionTrace,
      context
    );
    const exportDate =
      exportedAt instanceof Date && Number.isFinite(exportedAt.getTime())
        ? exportedAt
        : new Date();
    const result = {
      title: conversation.title ?? null,
      create_time: toReadableTime(conversation.create_time),
      update_time: toReadableTime(conversation.update_time),
      conversation_id: conversation.conversation_id ?? null,
      handoff_schema_version: HANDOFF_SCHEMA_VERSION,
      exporter_version: EXPORTER_VERSION,
      exported_at: toUtcIsoString(exportDate),
      source_context: buildSourceContext(conversation)
    };
    const conversationSettings = buildConversationSettings(conversation);
    if (Object.keys(conversationSettings).length > 0) {
      result.conversation_settings = conversationSettings;
    }
    const executionProfile = buildExecutionProfile(conversation, pathNodeIds);
    if (Object.keys(executionProfile).length > 0) {
      result.execution_profile = executionProfile;
    }
    result.messages = messages;
    result.execution_trace = finalizedExecutionTrace;
    result.textdocs = buildHandoffTextdocs(
      textdocs,
      textdocLifecycleById
    );
    result.data_quality = context.dataQuality;
    return result;
  }
  function hasMeaningfulHandoffMessagePayload(message) {
    return Boolean(
      (typeof message.content === 'string' && message.content.trim()) ||
      (Array.isArray(message.attachments) && message.attachments.length > 0) ||
      (Array.isArray(message.rich_content) && message.rich_content.length > 0)
    );
  }
  /*
   * 檢查 handoff schema v2 轉換結果是否合理。
   *
   * 驗證重點：
   *   - messages 與 execution_trace 使用同一套正整數 sequence。
   *   - attachment-only / rich-content-only message 合法。
   *   - reasoning summary、recap 與 tool event 必須符合各自最低語意契約。
   */
  function validateHandoffOrThrow(handoff, sourceConversation) {
    const problems = [];
    const usedSequences = new Set();
    const usedMessageIds = new Set();
    const usedExecutionIds = new Set();
    if (!handoff || typeof handoff !== 'object') {
      problems.push('handoff 不是有效物件。');
    }
    if (handoff.handoff_schema_version !== HANDOFF_SCHEMA_VERSION) {
      problems.push(
        `handoff_schema_version 不正確：${String(handoff.handoff_schema_version)}`
      );
    }
    if (handoff.exporter_version !== EXPORTER_VERSION) {
      problems.push(
        `exporter_version 不正確：${String(handoff.exporter_version)}`
      );
    }
    if (typeof handoff.exported_at !== 'string' || !handoff.exported_at.trim()) {
      problems.push('handoff 缺少 exported_at。');
    }
    if (!Array.isArray(handoff.messages)) {
      problems.push('handoff.messages 不是陣列。');
    } else {
      if (handoff.messages.length === 0) {
        problems.push('handoff.messages 為空。');
      }
      for (const [index, message] of handoff.messages.entries()) {
        if (!message || typeof message !== 'object') {
          problems.push(`第 ${index + 1} 則訊息不是有效物件。`);
          continue;
        }
        if (typeof message.id !== 'string' || !message.id) {
          problems.push(`第 ${index + 1} 則訊息缺少 id。`);
        } else if (usedMessageIds.has(message.id)) {
          problems.push(`第 ${index + 1} 則訊息 id 重複：${message.id}`);
        } else {
          usedMessageIds.add(message.id);
        }
        if (message.role !== 'user' && message.role !== 'assistant') {
          problems.push(`第 ${index + 1} 則訊息 role 不合法：${String(message.role)}`);
        }
        if (!Number.isInteger(message.sequence) || message.sequence <= 0) {
          problems.push(`第 ${index + 1} 則訊息 sequence 不合法。`);
        } else if (usedSequences.has(message.sequence)) {
          problems.push(`sequence 重複：${message.sequence}`);
        } else {
          usedSequences.add(message.sequence);
        }
        if (!hasMeaningfulHandoffMessagePayload(message)) {
          problems.push(`第 ${index + 1} 則訊息沒有可交接 payload。`);
        }
        if (
          Object.prototype.hasOwnProperty.call(message, 'content') &&
          (typeof message.content !== 'string' || !message.content.trim())
        ) {
          problems.push(`第 ${index + 1} 則訊息 content 型別或內容不合法。`);
        }
        if (
          Object.prototype.hasOwnProperty.call(message, 'attachments') &&
          (!Array.isArray(message.attachments) || message.attachments.length === 0)
        ) {
          problems.push(`第 ${index + 1} 則訊息 attachments 不合法。`);
        }
      }
    }
    if (!Array.isArray(handoff.execution_trace)) {
      problems.push('handoff.execution_trace 不是陣列。');
    } else {
      for (const [index, event] of handoff.execution_trace.entries()) {
        if (!event || typeof event !== 'object') {
          problems.push(`第 ${index + 1} 個 execution event 不是有效物件。`);
          continue;
        }
        if (typeof event.id !== 'string' || !event.id) {
          problems.push(`第 ${index + 1} 個 execution event 缺少 id。`);
        } else if (usedExecutionIds.has(event.id)) {
          problems.push(`execution event id 重複：${event.id}`);
        } else {
          usedExecutionIds.add(event.id);
        }
        if (!Number.isInteger(event.sequence) || event.sequence <= 0) {
          problems.push(`第 ${index + 1} 個 execution event sequence 不合法。`);
        } else if (usedSequences.has(event.sequence)) {
          problems.push(`sequence 重複：${event.sequence}`);
        } else {
          usedSequences.add(event.sequence);
        }
        if (
          event.type !== 'reasoning_summary' &&
          event.type !== 'reasoning_recap' &&
          event.type !== 'tool'
        ) {
          problems.push(`第 ${index + 1} 個 execution event type 不合法：${String(event.type)}`);
          continue;
        }
        if (
          event.type === 'reasoning_summary' &&
          (typeof event.summary !== 'string' || !event.summary.trim())
        ) {
          problems.push(`第 ${index + 1} 個 reasoning_summary 缺少 summary。`);
        }
        if (
          event.type === 'reasoning_recap' &&
          (typeof event.content !== 'string' || !event.content.trim())
        ) {
          problems.push(`第 ${index + 1} 個 reasoning_recap 缺少 content。`);
        }
        if (
          event.type === 'tool' &&
          (typeof event.tool !== 'string' || !event.tool.trim())
        ) {
          problems.push(`第 ${index + 1} 個 tool event 缺少 tool。`);
        }
        if (event.type === 'tool' && Object.prototype.hasOwnProperty.call(event, 'outcome')) {
          if (!['success', 'error', 'cancelled', 'timeout'].includes(event.outcome)) {
            problems.push(`第 ${index + 1} 個 tool event outcome 不合法：${String(event.outcome)}`);
          }
          if (event.outcome === 'error') {
            if (!event.error || typeof event.error !== 'object' || Array.isArray(event.error)) {
              problems.push(`第 ${index + 1} 個 error tool event 缺少 error 物件。`);
            } else if (typeof event.error.kind !== 'string' || !event.error.kind.trim()) {
              problems.push(`第 ${index + 1} 個 error tool event 缺少 error.kind。`);
            }
          } else if (Object.prototype.hasOwnProperty.call(event, 'error')) {
            problems.push(`第 ${index + 1} 個非 error tool event 不應包含 error。`);
          }
        }
      }
    }
    if (!Array.isArray(handoff.textdocs)) {
      problems.push('handoff.textdocs 不是陣列。');
    }
    const attachmentIds = new Set();
    const fileReferenceTargets = [];
    for (const message of Array.isArray(handoff.messages) ? handoff.messages : []) {
      for (const attachment of Array.isArray(message.attachments) ? message.attachments : []) {
        if (attachment && typeof attachment.id === 'string' && attachment.id) {
          attachmentIds.add(attachment.id);
        }
      }
      for (const ref of Array.isArray(message.file_references) ? message.file_references : []) {
        if (ref && typeof ref.file_id === 'string' && ref.file_id) {
          fileReferenceTargets.push(ref.file_id);
        }
      }
    }
    for (const fileId of fileReferenceTargets) {
      if (!attachmentIds.has(fileId)) {
        problems.push(`file_references 指向不存在的 attachment：${fileId}`);
      }
    }
    const textdocIds = new Set(
      (Array.isArray(handoff.textdocs) ? handoff.textdocs : [])
        .filter((item) => item && typeof item.id === 'string')
        .map((item) => item.id)
    );
    for (const event of Array.isArray(handoff.execution_trace) ? handoff.execution_trace : []) {
      if (Array.isArray(event.tool_event_refs)) {
        for (const ref of event.tool_event_refs) {
          if (!usedExecutionIds.has(ref)) {
            problems.push(`tool_event_refs 指向不存在的 execution event：${String(ref)}`);
          }
        }
      }
      if (
        typeof event.textdoc_ref === 'string' &&
        event.textdoc_ref &&
        !textdocIds.has(event.textdoc_ref)
      ) {
        problems.push(`textdoc_ref 指向不存在的 textdoc：${event.textdoc_ref}`);
      }
    }
    const totalSequencedItems =
      (Array.isArray(handoff.messages) ? handoff.messages.length : 0) +
      (Array.isArray(handoff.execution_trace) ? handoff.execution_trace.length : 0);
    for (let sequence = 1; sequence <= totalSequencedItems; sequence += 1) {
      if (!usedSequences.has(sequence)) {
        problems.push(`sequence 缺號：${sequence}`);
        break;
      }
    }
    if (!handoff.data_quality || typeof handoff.data_quality !== 'object') {
      problems.push('handoff.data_quality 不是有效物件。');
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
   * 將目前 conversation ID 寫到按鈕上，供 click handler 防止 SPA 切換後
   * 殘留的按鈕狀態或 listener 觸發匯出。
   */
  function setButtonConversationId(buttonId, conversationId) {
    const button = document.querySelector(`#${buttonId}`);
    if (!button) {
      return;
    }
    if (conversationId) {
      if (button.getAttribute('data-cgpt-export-conversation-id') !== conversationId) {
        button.setAttribute('data-cgpt-export-conversation-id', conversationId);
      }
      return;
    }
    button.removeAttribute('data-cgpt-export-conversation-id');
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
   * 同步設定單一對話匯出選單觸發按鈕的 busy 狀態。
   *
   * 選單項目不在 Header 常駐，因此匯出期間只需要鎖住觸發按鈕；
   * 已開啟的選單會在開始匯出前關閉。
   */
  function setAllButtonsBusy(isBusy) {
    setButtonBusy(EXPORT_MENU_BUTTON_ID, isBusy);
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
   * callback 可透過 updateProgress() 更新目前階段，讓三種單一對話匯出動作共用相同的 UI 狀態管理。
   */
  async function runExportFlow({ buttonId, initialProgressText, errorLogMessage, operation, triggerEvent = null }) {
    closeExportMenu({ restoreFocus: false });
    const triggerButton = triggerEvent && triggerEvent.currentTarget
      ? triggerEvent.currentTarget
      : document.querySelector(`#${buttonId}`);
    try {
      assertButtonConversationMatchesCurrent(triggerButton);
    } catch (error) {
      logError(errorLogMessage, error);
      showErrorAlert(error);
      updateButtonState();
      return;
    }
    const conversationId = getConversationIdFromUrl();
    if (!conversationId) {
      const rawConversationId = getRawConversationIdFromUrl();
      const temporaryIdMessage = rawConversationId && !isExportableConversationId(rawConversationId)
        ? `目前網址中的 ID「${rawConversationId}」尚不是可匯出的正式 conversation ID。\n\n`
        : '';
      alert(
        '目前不是可匯出的 ChatGPT 對話頁。\n\n' +
        temporaryIdMessage +
        '請確認目前頁面是已建立完成的 ChatGPT 對話，且網址包含正式 UUID 格式的 /c/{conversation_id}。\n' +
        '如果你剛點選「在新聊天中分支」，請先等待新聊天建立完成後再試。'
      );
      return;
    }
    const updateProgress = (text) => {
      setExportProgress(buttonId, text);
    };
    try {
      setExportInProgress(buttonId, initialProgressText);
      assertConversationStillCurrent(conversationId, '匯出開始前');
      await operation(conversationId, updateProgress);
      assertConversationStillCurrent(conversationId, '匯出完成前');
    } catch (error) {
      logError(errorLogMessage, error);
      showErrorAlert(error);
    } finally {
      clearExportInProgress();
    }
  }
  /*
   * 建立單一匯出觸發按鈕 tooltip。
   *
   * tooltip 只顯示目前「匯出」入口、對話標題、conversation ID 與捕捉時間，
   * 不顯示 headers 或 raw JSON。
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
   * 根據目前頁面狀態更新單一「匯出」觸發按鈕文字與 tooltip。
   *
   * Header 平時只顯示「匯出」；實際 raw / handoff / complete 動作由彈出選單
   * 提供。匯出進行中時仍沿用既有進度文字，避免失去目前工作階段提示。
   */
  function updateButtonState() {
    const { conversationId, capture, replayRequest } = getCurrentState();
    const isExporting = applyExportInProgressState();
    if (!isConversationPage() || !conversationId) {
      setButtonConversationId(EXPORT_MENU_BUTTON_ID, null);
      if (!isExporting) {
        setButtonText(EXPORT_MENU_BUTTON_ID, '匯出');
        setButtonTooltip(EXPORT_MENU_BUTTON_ID, '');
        setAllButtonsBusy(false);
      }
      return;
    }
    setButtonConversationId(EXPORT_MENU_BUTTON_ID, conversationId);
    if (!isExporting) {
      setButtonText(EXPORT_MENU_BUTTON_ID, '匯出');
      setAllButtonsBusy(false);
    }
    setButtonTooltip(
      EXPORT_MENU_BUTTON_ID,
      buildBaseTooltip({
        actionName: '匯出目前對話 JSON',
        conversationId,
        capture,
        replayRequest
      })
    );
  }
  /*
   * 離開對話頁時移除單一匯出觸發按鈕與彈出選單。
   *
   * ChatGPT 是 SPA，網址切換時不一定重新載入頁面，因此需要主動清理既有 UI 狀態。
   * 同時清除 v1.5.10 以前可能殘留的三顆單一匯出 Header 按鈕。
   */
  function removeButtonsIfNeeded() {
    stopObservingHeaderActionLayout();
    closeExportMenu({ restoreFocus: false });
    const exportButton = document.querySelector(`#${EXPORT_MENU_BUTTON_ID}`);
    if (exportButton) {
      exportButton.remove();
    }
    for (const legacyButtonId of LEGACY_SINGLE_EXPORT_BUTTON_IDS) {
      for (const legacyButton of document.querySelectorAll(`#${legacyButtonId}`)) {
        legacyButton.remove();
      }
    }
    clearCurrentAppShellHeaderMarkers();
  }
  /*
   * 建立和 ChatGPT header action 風格接近的按鈕。
   */
  function createHeaderButton({
    id,
    label,
    ariaLabel,
    testId,
    iconSvg,
    onClick,
    onKeyDown = null
  }) {
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
    if (typeof onKeyDown === 'function') {
      button.addEventListener('keydown', onKeyDown);
    }
    button.setAttribute('data-cgpt-export-listener-version', EXPORT_BUTTON_LISTENER_VERSION);
    return button;
  }
  /*
   * 單一對話匯出選單直接沿用目前 ChatGPT 原生 Radix menu content 的
   * DOM attribute 與既有 utility class；不另外注入 <style>，也不新增
   * Exporter 專用選單樣式。
   *
   * 目的：
   *   - ChatGPT 自己的 menu 樣式直接生效。
   *   - 專案現有針對 div[data-radix-menu-content][role="menu"] 的 CSS
   *     自動套用，不需要另外維護一套 Exporter 選單規則。
   *   - data-cgpt-* 只保留作為腳本辨識、互動與清理錨點。
   */
  const NATIVE_EXPORT_MENU_CLASS = [
    'no-drag',
    'z-50',
    'm-px',
    'flex',
    'select-none',
    'flex-col',
    'overflow-y-auto',
    'bg-surface-elevated-secondary/90',
    'text-default',
    'ring-border',
    'ring-[0.5px]',
    'shadow-xl-spread',
    'backdrop-blur-sm',
    'rounded-2xl',
    'p-[var(--app-menu-gutter,var(--spacing))]',
    'min-w-[var(--app-menu-min-width,220px)]'
  ].join(' ');
  const NATIVE_EXPORT_MENU_ITEM_CLASS = [
    'no-drag',
    'outline-hidden',
    'flex',
    'min-h-[var(--app-menu-item-height,0px)]',
    'shrink-0',
    'items-center',
    'justify-center',
    'p-[var(--app-menu-item-padding,var(--padding-row-y)_var(--padding-row-x))]',
    'text-(length:--app-menu-item-font-size,var(--text-sm))',
    'leading-(--app-menu-item-line-height,var(--text-sm--line-height))',
    'rounded-xl',
    'text-default',
    'group',
    'hover:bg-primary-ghost-hover',
    'focus:bg-primary-ghost-hover',
    'focus-visible:bg-primary-ghost-hover',
    'data-[highlighted]:bg-primary-ghost-hover',
    'cursor-interaction',
    'flex-col'
  ].join(' ');
  /*
   * 將匯出選單的 popper wrapper 放在 Header 觸發按鈕附近。
   *
   * wrapper / menu 的 attribute 與目前 ChatGPT 原生 Radix DropdownMenu
   * 結構一致；定位仍由 userscript 自己計算，避免依賴 React / Radix runtime。
   */
  function positionExportMenu(menu, triggerButton) {
    if (!menu?.isConnected || !triggerButton?.isConnected) {
      return;
    }
    const wrapper = menu.closest('[data-cgpt-export-menu-wrapper="true"]');
    if (!wrapper) {
      return;
    }
    const triggerRect = triggerButton.getBoundingClientRect();
    if (triggerRect.width <= 0 || triggerRect.height <= 0) {
      return;
    }
    const viewportEdge = 8;
    const triggerGap = 1;
    const menuRect = menu.getBoundingClientRect();
    const menuWidth = Math.max(menuRect.width, 1);
    const menuHeight = Math.max(menuRect.height, 1);
    let left = triggerRect.left;
    left = Math.min(left, window.innerWidth - menuWidth - viewportEdge);
    left = Math.max(viewportEdge, left);
    const spaceBelow = window.innerHeight - triggerRect.bottom - viewportEdge;
    const spaceAbove = triggerRect.top - viewportEdge;
    let top;
    let side = 'bottom';
    if (spaceBelow >= menuHeight || spaceBelow >= spaceAbove) {
      top = triggerRect.bottom + triggerGap;
    } else {
      side = 'top';
      top = triggerRect.top - menuHeight - triggerGap;
    }
    top = Math.min(top, window.innerHeight - menuHeight - viewportEdge);
    top = Math.max(viewportEdge, top);
    menu.dataset.side = side;
    menu.dataset.align = 'start';
    wrapper.style.transform = `translate(${Math.round(left * 100) / 100}px, ${Math.round(top * 100) / 100}px)`;
    wrapper.style.setProperty(
      '--radix-popper-available-width',
      `${Math.max(0, window.innerWidth - viewportEdge * 2)}px`
    );
    wrapper.style.setProperty(
      '--radix-popper-available-height',
      `${Math.max(0, window.innerHeight - viewportEdge * 2)}px`
    );
    wrapper.style.setProperty('--radix-popper-anchor-width', `${triggerRect.width}px`);
    wrapper.style.setProperty('--radix-popper-anchor-height', `${triggerRect.height}px`);
  }
  /*
   * 關閉匯出選單並清理暫時 listener / popper wrapper。
   */
  function closeExportMenu({ restoreFocus = false } = {}) {
    if (exportMenuAbortController) {
      exportMenuAbortController.abort();
      exportMenuAbortController = null;
    }
    const menu = document.getElementById(EXPORT_MENU_ID);
    const wrapper = menu?.closest('[data-cgpt-export-menu-wrapper="true"]') || null;
    if (wrapper) {
      wrapper.remove();
    } else if (menu) {
      menu.remove();
    }
    const triggerButton = exportMenuTriggerNode || document.getElementById(EXPORT_MENU_BUTTON_ID);
    exportMenuTriggerNode = null;
    if (triggerButton) {
      triggerButton.setAttribute('aria-expanded', 'false');
      triggerButton.setAttribute('data-state', 'closed');
      triggerButton.removeAttribute('aria-controls');
      if (restoreFocus && triggerButton.isConnected && !triggerButton.disabled) {
        triggerButton.focus({ preventScroll: true });
      }
    }
  }
  function setExportMenuHighlightedItem(item) {
    const menu = item?.closest?.(`#${EXPORT_MENU_ID}`);
    if (!menu) {
      return;
    }
    for (const sibling of menu.querySelectorAll(
      '[data-cgpt-export-menu-item="true"][data-highlighted]'
    )) {
      if (sibling !== item) {
        sibling.removeAttribute('data-highlighted');
      }
    }
    item.setAttribute('data-highlighted', '');
  }
  /*
   * 建立目前 ChatGPT 原生 action menu 同型的單一選單項目。
   * 三個 inline SVG 直接沿用 v1.5.10 既有圖示，不修改圖形本身。
   */
  function createExportMenuItem({ label, iconSvg, onSelect, conversationId }) {
    const item = document.createElement('div');
    item.setAttribute('role', 'menuitem');
    item.setAttribute('tabindex', '-1');
    item.setAttribute('data-orientation', 'vertical');
    item.setAttribute('data-radix-collection-item', '');
    item.setAttribute('data-cgpt-export-menu-item', 'true');
    item.className = NATIVE_EXPORT_MENU_ITEM_CLASS;
    if (conversationId) {
      item.setAttribute('data-cgpt-export-conversation-id', conversationId);
    }
    item.innerHTML = `
      <div data-menu-row-content="true" data-cgpt-export-menu-row="true" class="flex w-full min-w-0 items-center gap-[var(--spacing-menu-item-content,calc(var(--spacing)*1.5))]">
        <span class="flex-1 min-w-0 truncate">
          <span class="flex w-full items-center gap-1.5">
            <span data-cgpt-export-menu-icon="true" class="flex h-[var(--icon-leading-size)] w-[var(--icon-leading-size)] shrink-0 items-center justify-center">${iconSvg || ''}</span>
            <span data-cgpt-export-menu-label="true" class="truncate">${label}</span>
          </span>
        </span>
      </div>
    `;
    item.addEventListener('mouseenter', () => {
      setExportMenuHighlightedItem(item);
    });
    item.addEventListener('focus', () => {
      setExportMenuHighlightedItem(item);
    });
    item.addEventListener('mouseleave', () => {
      if (document.activeElement !== item) {
        item.removeAttribute('data-highlighted');
      }
    });
    item.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const triggerButton = document.getElementById(EXPORT_MENU_BUTTON_ID);
      closeExportMenu({ restoreFocus: false });
      if (!triggerButton || triggerButton.disabled) {
        return;
      }
      onSelect({ currentTarget: triggerButton });
    });
    return item;
  }
  /*
   * 匯出選單鍵盤操作：
   * ArrowUp / ArrowDown、Home / End、Enter / Space、Escape。
   */
  function handleExportMenuKeyDown(event) {
    const menu = document.getElementById(EXPORT_MENU_ID);
    if (!menu) {
      return;
    }
    const items = Array.from(
      menu.querySelectorAll('[data-cgpt-export-menu-item="true"]')
    );
    if (!items.length) {
      return;
    }
    const currentIndex = items.indexOf(document.activeElement);
    let nextIndex = currentIndex;
    if (event.key === 'ArrowDown') {
      nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % items.length;
    } else if (event.key === 'ArrowUp') {
      nextIndex = currentIndex < 0
        ? items.length - 1
        : (currentIndex - 1 + items.length) % items.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = items.length - 1;
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeExportMenu({ restoreFocus: true });
      return;
    } else if (event.key === 'Enter' || event.key === ' ') {
      if (currentIndex >= 0) {
        event.preventDefault();
        items[currentIndex].click();
      }
      return;
    } else if (event.key === 'Tab') {
      closeExportMenu({ restoreFocus: false });
      return;
    } else {
      return;
    }
    event.preventDefault();
    items[nextIndex].focus({ preventScroll: true });
  }
  /*
   * 開啟單一對話匯出選單。
   */
  function openExportMenu(triggerButton, { focusLast = false } = {}) {
    if (
      !triggerButton?.isConnected ||
      triggerButton.disabled ||
      !isConversationPage()
    ) {
      return;
    }
    closeExportMenu({ restoreFocus: false });
    const conversationId = getConversationIdFromUrl();
    const direction = document.documentElement.dir || 'ltr';
    const wrapper = document.createElement('div');
    wrapper.setAttribute('data-radix-popper-content-wrapper', '');
    wrapper.setAttribute('data-cgpt-export-menu-wrapper', 'true');
    wrapper.dir = direction;
    Object.assign(wrapper.style, {
      position: 'fixed',
      left: '0px',
      top: '0px',
      transform: 'translate(0px, 0px)',
      minWidth: 'max-content',
      willChange: 'transform',
      zIndex: '50'
    });
    wrapper.style.setProperty('--radix-popper-transform-origin', '0% 0px');
    const menu = document.createElement('div');
    menu.id = EXPORT_MENU_ID;
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-orientation', 'vertical');
    menu.setAttribute('aria-labelledby', triggerButton.id);
    menu.setAttribute('tabindex', '-1');
    menu.setAttribute('data-state', 'open');
    menu.setAttribute('data-radix-menu-content', '');
    menu.setAttribute('data-orientation', 'vertical');
    menu.setAttribute('data-cgpt-export-menu', 'true');
    menu.dir = direction;
    menu.className = NATIVE_EXPORT_MENU_CLASS;
    Object.assign(menu.style, {
      outline: 'none',
      maxWidth: 'min(var(--radix-dropdown-menu-content-available-width), calc(100vw - 16px))',
      maxHeight: 'min(var(--radix-dropdown-menu-content-available-height), calc(100vh - 16px))'
    });
    menu.style.setProperty(
      '--radix-dropdown-menu-content-transform-origin',
      'var(--radix-popper-transform-origin)'
    );
    menu.style.setProperty(
      '--radix-dropdown-menu-content-available-width',
      'var(--radix-popper-available-width)'
    );
    menu.style.setProperty(
      '--radix-dropdown-menu-content-available-height',
      'var(--radix-popper-available-height)'
    );
    menu.style.setProperty(
      '--radix-dropdown-menu-trigger-width',
      'var(--radix-popper-anchor-width)'
    );
    menu.style.setProperty(
      '--radix-dropdown-menu-trigger-height',
      'var(--radix-popper-anchor-height)'
    );
    const itemConfigs = [
      {
        label: '下載原始 JSON',
        iconSvg: RAW_JSON_ICON_SVG,
        onSelect: handleDownloadRawClick
      },
      {
        label: '下載交接 JSON',
        iconSvg: HANDOFF_ICON_SVG,
        onSelect: handleDownloadHandoffClick
      },
      {
        label: '下載完整 JSON',
        iconSvg: COMPLETE_JSON_ICON_SVG,
        onSelect: handleDownloadCompleteClick
      }
    ];
    for (const config of itemConfigs) {
      menu.append(
        createExportMenuItem({
          ...config,
          conversationId
        })
      );
    }
    wrapper.append(menu);
    document.body.append(wrapper);
    exportMenuTriggerNode = triggerButton;
    triggerButton.setAttribute('aria-haspopup', 'menu');
    triggerButton.setAttribute('aria-expanded', 'true');
    triggerButton.setAttribute('aria-controls', EXPORT_MENU_ID);
    triggerButton.setAttribute('data-state', 'open');
    positionExportMenu(menu, triggerButton);
    exportMenuAbortController = new AbortController();
    const { signal } = exportMenuAbortController;
    document.addEventListener(
      'pointerdown',
      (event) => {
        const target = event.target;
        if (
          menu.contains(target) ||
          triggerButton.contains(target)
        ) {
          return;
        }
        closeExportMenu({ restoreFocus: false });
      },
      { capture: true, signal }
    );
    window.addEventListener(
      'resize',
      () => {
        positionExportMenu(menu, triggerButton);
      },
      { passive: true, signal }
    );
    window.addEventListener(
      'scroll',
      () => {
        positionExportMenu(menu, triggerButton);
      },
      { capture: true, passive: true, signal }
    );
    menu.addEventListener('keydown', handleExportMenuKeyDown, { signal });
    const items = Array.from(
      menu.querySelectorAll('[data-cgpt-export-menu-item="true"]')
    );
    const focusTarget = focusLast ? items.at(-1) : items[0];
    if (focusTarget) {
      requestAnimationFrame(() => {
        if (menu.isConnected) {
          focusTarget.focus({ preventScroll: true });
        }
      });
    }
  }
  /*
   * Header「匯出」觸發按鈕 click / keyboard 行為。
   */
  function toggleExportMenu(event) {
    const triggerButton = event.currentTarget;
    const existingMenu = document.getElementById(EXPORT_MENU_ID);
    if (existingMenu) {
      closeExportMenu({ restoreFocus: false });
      return;
    }
    openExportMenu(triggerButton);
  }
  function handleExportMenuTriggerKeyDown(event) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
      return;
    }
    event.preventDefault();
    const triggerButton = event.currentTarget;
    const existingMenu = document.getElementById(EXPORT_MENU_ID);
    if (existingMenu) {
      const items = Array.from(
        existingMenu.querySelectorAll('[data-cgpt-export-menu-item="true"]')
      );
      const target = event.key === 'ArrowUp' ? items.at(-1) : items[0];
      target?.focus({ preventScroll: true });
      return;
    }
    openExportMenu(triggerButton, {
      focusLast: event.key === 'ArrowUp'
    });
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
    assertSnapshotConversationMatches(snapshot, conversationId, '下載原始 JSON 前');
    assertConversationStillCurrent(conversationId, '下載原始 JSON 前');
    updateProgress('正在下載原始 JSON…');
    downloadRawConversation(snapshot, conversationId, exportTimestamp);
    updateProgress('正在擷取 textdocs…');
    assertConversationStillCurrent(conversationId, '擷取 textdocs 前');
    const textdocs = await getLatestTextdocs(conversationId);
    assertConversationStillCurrent(conversationId, '擷取 textdocs 後');
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
    const result = await createHandoffPayloadForConversationId(conversationId, {
      enforceCurrentPage: true,
      onStage(stage) {
        if (stage === 'conversation-start') {
          updateProgress('正在擷取原始 JSON…');
        } else if (stage === 'textdocs-start') {
          updateProgress('正在擷取 textdocs…');
        } else if (stage === 'handoff-build') {
          updateProgress('正在產出交接 JSON…');
        } else if (stage === 'handoff-ready') {
          updateProgress('正在下載交接 JSON…');
        }
      }
    });
    downloadHandoffPayload(result.handoffPayload);
  }
  /*
   * 執行「下載完整 JSON」。
   *
   * 使用 createCompletePayloadForConversationId() 取得同一份 authoritative
   * conversation / textdocs snapshot，再依序觸發三種獨立檔案下載：
   *   - raw conversation JSON
   *   - textdocs JSON（有內容時）
   *   - handoff JSON
   *
   * 單一對話完整匯出不建立 ZIP，也不壓縮。
   */
  async function exportCompleteConversationFiles(conversationId, updateProgress) {
    const result = await createCompletePayloadForConversationId(conversationId, {
      onStage(stage) {
        if (stage === 'conversation-start') {
          updateProgress('正在擷取原始 JSON…');
        } else if (stage === 'textdocs-start') {
          updateProgress('正在擷取 textdocs…');
        } else if (stage === 'raw-build') {
          updateProgress('正在產出原始 JSON…');
        } else if (stage === 'handoff-build') {
          updateProgress('正在產出交接 JSON…');
        } else if (stage === 'complete-ready') {
          updateProgress('正在準備下載完整 JSON…');
        }
      }
    });
    assertConversationStillCurrent(conversationId, '下載完整 JSON 前');
    updateProgress('正在下載原始 JSON…');
    downloadTextFile(result.rawPayload.text, result.rawPayload.filename);
    if (result.textdocsPayload) {
      assertConversationStillCurrent(conversationId, '下載 textdocs 前');
      updateProgress('正在下載 textdocs…');
      downloadTextFile(result.textdocsPayload.text, result.textdocsPayload.filename);
    }
    assertConversationStillCurrent(conversationId, '下載交接 JSON 前');
    updateProgress('正在下載交接 JSON…');
    downloadHandoffPayload(result.handoffPayload);
  }
  /*
   * 點擊「下載原始 JSON」。
   *
   * raw JSON 會輸出為 4 空白縮排，方便閱讀與版本管理。
   */
  async function handleDownloadRawClick(event) {
    await runExportFlow({
      buttonId: EXPORT_MENU_BUTTON_ID,
      initialProgressText: '正在擷取原始 JSON…',
      errorLogMessage: '下載原始 JSON 失敗。',
      operation: exportRawConversationFiles,
      triggerEvent: event
    });
  }
  /*
   * 點擊「下載交接 JSON」。
   *
   * UI 狀態與錯誤處理由 runExportFlow() 統一處理，
   * 實際轉換與下載工作交給 exportHandoffFile()。
   */
  async function handleDownloadHandoffClick(event) {
    await runExportFlow({
      buttonId: EXPORT_MENU_BUTTON_ID,
      initialProgressText: '正在擷取原始 JSON…',
      errorLogMessage: '下載交接 JSON 失敗。',
      operation: exportHandoffFile,
      triggerEvent: event
    });
  }
  /*
   * 點擊「下載完整 JSON」。
   *
   * 三份資料分別以一般 JSON 檔下載，不經 ZIP。
   */
  async function handleDownloadCompleteClick(event) {
    await runExportFlow({
      buttonId: EXPORT_MENU_BUTTON_ID,
      initialProgressText: '正在擷取原始 JSON…',
      errorLogMessage: '下載完整 JSON 失敗。',
      operation: exportCompleteConversationFiles,
      triggerEvent: event
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
   * 取得目前 Header action 中的原生分享按鈕。
   *
   * 舊版優先使用固定 data-testid；新版 App Shell 則使用 userscript 自己標記的
   * native share button。若 marker 尚未建立，最後才依「更多」action 前一個原生
   * action 的結構關係辨識，避免把介面語言文案當成主要 selector。
   */
  function findNativeShareButton(headerActions) {
    if (!headerActions) {
      return null;
    }
    const legacyShareButton = headerActions.querySelector(SHARE_BUTTON_SELECTOR);
    if (legacyShareButton) {
      return legacyShareButton;
    }
    const markedShareButton = headerActions.querySelector(
      'button[data-cgpt-native-share-button="true"]'
    );
    if (markedShareButton) {
      return markedShareButton;
    }
    const optionsButton = headerActions.querySelector('button[aria-haspopup="menu"]');
    const optionsAction = getDirectChildWithin(headerActions, optionsButton);
    let candidateAction = optionsAction?.previousElementSibling || null;
    while (candidateAction?.matches?.('[data-cgpt-export-button="true"]')) {
      candidateAction = candidateAction.previousElementSibling;
    }
    const candidateButton = candidateAction?.matches?.('button')
      ? candidateAction
      : candidateAction?.querySelector?.('button');
    if (candidateButton && !candidateButton.hasAttribute('data-cgpt-export-button')) {
      return candidateButton;
    }
    return null;
  }
  /*
   * 在新版 App Shell Header 上建立 userscript 專用 marker。
   *
   * marker 只標記目前已由穩定 App Shell 結構辨識出的 action group 與原生分享按鈕，
   * 讓 CSS 與後續量測不必依賴模組 class 或本地化文字。
   */
  function markCurrentAppShellHeaderActions(headerActions) {
    if (!headerActions) {
      return headerActions;
    }
    headerActions.setAttribute('data-cgpt-export-header-actions', 'true');
    const shareButton = findNativeShareButton(headerActions);
    if (shareButton) {
      shareButton.setAttribute('data-cgpt-native-share-button', 'true');
    }
    return headerActions;
  }
  /*
   * 離開對話頁時清除新版 App Shell 專用 marker。
   */
  function clearCurrentAppShellHeaderMarkers() {
    for (const shareButton of document.querySelectorAll('[data-cgpt-native-share-button="true"]')) {
      shareButton.removeAttribute('data-cgpt-native-share-button');
    }
    for (const headerActions of document.querySelectorAll(CURRENT_HEADER_ACTIONS_SELECTOR)) {
      headerActions.removeAttribute('data-cgpt-header-compact');
      headerActions.removeAttribute('data-cgpt-export-header-actions');
    }
  }
  /*
   * 判斷新版 App Shell Header action group 是否目前可用。
   *
   * ChatGPT 在 SPA 對話切換期間可能短暫同時保留舊、新多組 titlebar。
   * 舊節點即使仍 connected，也可能已經是 0 × 0、隱藏或位於 aria-hidden / inert
   * 的退場 surface；這些節點不能再作為匯出按鈕的掛載目標。
   */
  function isUsableCurrentAppShellHeaderActions(actionGroup) {
    if (!actionGroup?.isConnected) {
      return false;
    }
    if (actionGroup.closest('[aria-hidden="true"], [inert]')) {
      return false;
    }
    const style = getComputedStyle(actionGroup);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      Number.parseFloat(style.opacity || '1') === 0
    ) {
      return false;
    }
    const rect = actionGroup.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }
  /*
   * 取得新版 App Shell 對話頁右側 action group。
   *
   * 先掃描所有 App Shell titlebar，而不是只取 DOM 中第一個 titlebar；
   * SPA 對話切換時 ChatGPT 可能同時保留多組新舊 Header。
   * 每個候選仍只使用固定的 context-menu surface / obstacle attribute 與原生
   * menu button 反推同列 action group，並排除退場、隱藏或 0 × 0 的舊節點。
   * 不依賴 build/module class，也不使用「分享」「更多」等介面文案作主要錨點。
   */
  function findCurrentAppShellHeaderActionsContainer() {
    const titlebars = Array.from(
      document.querySelectorAll('header[data-app-shell-titlebar="true"]')
    );
    for (const titlebar of titlebars) {
      const surfaces = Array.from(
        titlebar.querySelectorAll(
          '[data-testid="app-shell-header-context-menu-surface"]'
        )
      );
      for (const surface of surfaces) {
        if (
          !surface.isConnected ||
          surface.getAttribute('aria-hidden') === 'true' ||
          surface.hasAttribute('inert')
        ) {
          continue;
        }
        const obstacles = Array.from(
          surface.querySelectorAll('[data-app-shell-header-obstacle="true"]')
        );
        for (const obstacle of obstacles) {
          const optionsButton = obstacle.querySelector('button[aria-haspopup="menu"]');
          const actionGroup = optionsButton?.parentElement || null;
          if (
            !actionGroup ||
            !obstacle.contains(actionGroup) ||
            !isUsableCurrentAppShellHeaderActions(actionGroup)
          ) {
            continue;
          }
          return markCurrentAppShellHeaderActions(actionGroup);
        }
      }
    }
    return null;
  }
  /*
   * 取得匯出按鈕應插入的 header action 容器。
   *
   * 先保留舊版 #conversation-header-actions 與 thread header fallback；
   * 若舊路徑不存在，再使用 2026-09 App Shell 的穩定結構建立 current branch。
   */
  function findHeaderActionsContainer() {
    const legacySelectors = [
      LEGACY_HEADER_ACTIONS_SELECTOR,
      '[data-testid="thread-header-right-actions"]',
      '[data-testid="thread-header-right-actions-container"]',
      '#page-header'
    ];
    for (const selector of legacySelectors) {
      const element = document.querySelector(selector);
      if (element) {
        return element;
      }
    }
    return findCurrentAppShellHeaderActionsContainer();
  }
  /*
   * 取得或建立指定匯出按鈕。
   *
   * 若按鈕已存在，會檢查節點的 listener 標記；標記不一致時重建按鈕，
   * 以避免殘留的 click listener 或 conversation 狀態。
   */
  function getOrCreateExportButton(config) {
    const existingButton = document.querySelector(`#${config.id}`);
    if (existingButton) {
      if (existingButton.getAttribute('data-cgpt-export-listener-version') !== EXPORT_BUTTON_LISTENER_VERSION) {
        if (config.id === EXPORT_MENU_BUTTON_ID) {
          closeExportMenu({ restoreFocus: false });
        }
        const replacementButton = createHeaderButton(config);
        const existingCompact = existingButton.getAttribute('data-cgpt-export-compact');
        const existingConversationId = existingButton.getAttribute('data-cgpt-export-conversation-id');
        if (existingCompact) {
          replacementButton.setAttribute('data-cgpt-export-compact', existingCompact);
        }
        if (existingConversationId) {
          replacementButton.setAttribute('data-cgpt-export-conversation-id', existingConversationId);
        }
        existingButton.replaceWith(replacementButton);
        return replacementButton;
      }
      /*
       * 補上 CSS 相依的識別屬性。
       * 這可避免 SPA 頁面中按鈕被重用時，CSS selector 無法命中。
       */
      existingButton.setAttribute('data-cgpt-export-button', 'true');
      existingButton.setAttribute('data-testid', config.testId);
      existingButton.setAttribute('aria-label', config.ariaLabel);
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
   * 將單一「匯出」觸發按鈕放到 ChatGPT header 的適當位置。
   *
   * 目標順序：
   *   分享 → 匯出 → 更多選單
   *
   * 使用 header action 的直接子元素作為插入錨點，避免匯出按鈕被放到
   * ChatGPT 原生按鈕的內層 wrapper 裡。
   *
   * 若找不到分享按鈕或更多選單，仍會把匯出觸發按鈕插入 action 容器中，
   * 避免 ChatGPT DOM 結構小幅變動時按鈕直接消失。
   */
  function placeExportButton(headerActions, exportButton) {
    const shareButton = findNativeShareButton(headerActions);
    const optionsButton =
      headerActions.querySelector('[data-testid="conversation-options-button"]') ||
      (headerActions.matches(CURRENT_HEADER_ACTIONS_SELECTOR)
        ? headerActions.querySelector('button[aria-haspopup="menu"]:not([data-cgpt-export-button="true"])')
        : null);
    const shareAction = getDirectChildWithin(headerActions, shareButton);
    const optionsAction = getDirectChildWithin(headerActions, optionsButton);
    if (shareAction) {
      if (shareAction.nextElementSibling !== exportButton) {
        shareAction.insertAdjacentElement('afterend', exportButton);
      }
    } else if (optionsAction) {
      if (optionsAction.previousElementSibling !== exportButton) {
        optionsAction.insertAdjacentElement('beforebegin', exportButton);
      }
    } else if (exportButton.parentElement !== headerActions) {
      headerActions.append(exportButton);
    }
  }
  /*
   * 新版 App Shell 中沿用原生分享按鈕的 class，讓匯出按鈕維持同一套 toolbar 外觀。
   *
   * 只同步 className，不複製原生 event listener、ARIA menu 狀態或其他互動屬性。
   */
  function syncCurrentHeaderButtonPresentation(headerActions, ...buttons) {
    if (!headerActions?.matches?.(CURRENT_HEADER_ACTIONS_SELECTOR)) {
      return;
    }
    const shareButton = findNativeShareButton(headerActions);
    if (!shareButton?.className) {
      return;
    }
    for (const button of buttons) {
      if (!button) {
        continue;
      }
      button.className = shareButton.className;
    }
  }
  /*
   * Header action 版面同步用的暫存資源。
   *
   * MutationObserver：監看 ChatGPT React 重建分享按鈕、文字節點或 wrapper。
   * ResizeObserver：監看 page header 與右側 action 區實際寬度。
   * window resize：作為舊環境與瀏覽器縮放的輕量備援。
   */
  let headerActionLayoutTimer = null;
  let headerActionLayoutObserver = null;
  let headerActionLayoutResizeObserver = null;
  let headerActionLayoutResizeHandler = null;
  let observedHeaderActionLayoutTargets = null;
  /*
   * 將 compact 狀態同步寫入 action 容器與單一匯出觸發按鈕。
   *
   * data-cgpt-header-compact：分享 + 匯出觸發按鈕共用的版面狀態。
   * data-cgpt-export-compact：保留既有 CSS 相依介面，避免舊規則失效。
   */
  function setHeaderActionsCompact(
    headerActions,
    exportButton,
    isCompact
  ) {
    const value = isCompact ? 'true' : 'false';
    if (headerActions.getAttribute('data-cgpt-header-compact') !== value) {
      headerActions.setAttribute('data-cgpt-header-compact', value);
    }
    if (
      exportButton &&
      exportButton.getAttribute('data-cgpt-export-compact') !== value
    ) {
      exportButton.setAttribute('data-cgpt-export-compact', value);
    }
  }
  /*
   * 正規化文字，供原生分享標籤比對使用。
   */
  function normalizeUiText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }
  /*
   * 只在分享按鈕自己的 subtree 內搜尋符合 selector 的節點。
   *
   * ChatGPT 開啟 Dialog 時會把背景 Header 設為 aria-hidden="true"，但 Header
   * 仍維持可見。若直接使用 Element.closest()，搜尋會越過 shareButton 命中
   * 背景 Header，進而把原生「分享」文字誤判為隱藏並建立重複 fallback。
   */
  function closestWithinShareButton(element, shareButton, selector) {
    let current = element;
    while (current && current !== shareButton) {
      if (current.matches(selector)) {
        return current;
      }
      current = current.parentElement;
    }
    return null;
  }
  /*
   * 判斷 element 是否為可接管顯示狀態的原生分享文字元素。
   *
   * 只接受 span / div / p 等文字容器，不把 button、SVG、aria-hidden 或
   * sr-only 輔助文字當成可見標籤，避免誤改圖示或無障礙節點。
   */
  function isUsableNativeShareLabelElement(element, shareButton) {
    if (!element || !shareButton || !shareButton.contains(element)) {
      return false;
    }
    if (element.matches('[data-cgpt-share-label="fallback"]')) {
      return false;
    }
    if (
      closestWithinShareButton(
        element,
        shareButton,
        'svg, [aria-hidden="true"], .sr-only, [hidden]'
      )
    ) {
      return false;
    }
    if (!element.matches('span, div, p, strong, em')) {
      return false;
    }
    if (element.querySelector('svg')) {
      return false;
    }
    return normalizeUiText(element.textContent) !== '';
  }
  /*
   * 尋找 ChatGPT 原生分享文字容器。
   *
   * 優先沿用先前已標記的 native 節點，再搜尋常見文字容器。若 ChatGPT
   * 日後重新加入「分享」文字，這裡會找到它並撤回 userscript fallback。
   */
  function findNativeShareLabelElement(shareButton, expectedText) {
    const candidates = [
      ...shareButton.querySelectorAll('[data-cgpt-share-label="native"]'),
      ...shareButton.querySelectorAll('span, div, p, strong, em')
    ];
    const seen = new Set();
    const usableCandidates = [];
    for (const candidate of candidates) {
      if (seen.has(candidate)) {
        continue;
      }
      seen.add(candidate);
      if (!isUsableNativeShareLabelElement(candidate, shareButton)) {
        continue;
      }
      const candidateText = normalizeUiText(candidate.textContent);
      if (
        candidateText === expectedText ||
        expectedText.includes(candidateText) ||
        candidateText.includes(expectedText)
      ) {
        return candidate;
      }
      usableCandidates.push(candidate);
    }
    return usableCandidates.length === 1 ? usableCandidates[0] : null;
  }
  /*
   * 尋找分享按鈕 subtree 中的原生可見文字節點，並只包住文字本身。
   *
   * ChatGPT 目前可能把 SVG 與「分享」裸文字放在同一個內層 div；
   * 若直接標記整個 div，compact CSS 會連 SVG 一起隱藏。因此這裡使用
   * TreeWalker 找實際 Text node，不依賴固定 DOM 深度，也不複製文字內容。
   */
  function wrapNativeShareTextNode(shareButton, expectedText) {
    const walker = document.createTreeWalker(shareButton, NodeFilter.SHOW_TEXT);
    let textNode = walker.nextNode();
    while (textNode) {
      const candidateText = normalizeUiText(textNode.nodeValue);
      const parentElement = textNode.parentElement;
      const matchesExpectedText = Boolean(
        candidateText &&
        (
          candidateText === expectedText ||
          expectedText.includes(candidateText) ||
          candidateText.includes(expectedText)
        )
      );
      const excluded = !parentElement || Boolean(
        closestWithinShareButton(
          parentElement,
          shareButton,
          '[data-cgpt-share-label="fallback"], svg, [aria-hidden="true"], .sr-only, [hidden]'
        )
      );
      if (matchesExpectedText && !excluded) {
        const existingNative = parentElement.closest('[data-cgpt-share-label="native"]');
        if (existingNative && shareButton.contains(existingNative)) {
          return existingNative;
        }
        const wrapper = document.createElement('span');
        wrapper.setAttribute('data-cgpt-share-label', 'native');
        wrapper.setAttribute('data-cgpt-share-label-wrapper', 'true');
        textNode.replaceWith(wrapper);
        wrapper.append(textNode);
        return wrapper;
      }
      textNode = walker.nextNode();
    }
    return null;
  }
  /*
   * 讓分享按鈕永遠只有一個可控制的文字標籤。
   *
   * - 原生文字存在：標記為 native，移除所有 fallback。
   * - 原生文字不存在：建立或重用唯一 fallback。
   * - 重複 fallback：只保留第一個，其餘移除。
   *
   * fallback 使用 aria-hidden，因為按鈕本身已有 aria-label；這可避免
   * 螢幕閱讀器把可見文字與 aria-label 重複朗讀。
   */
  function reconcileShareButtonLabel(headerActions) {
    const shareButton = findNativeShareButton(headerActions);
    if (!shareButton) {
      return null;
    }
    const expectedText = normalizeUiText(shareButton.getAttribute('aria-label')) || '分享';
    const fallbackLabels = Array.from(
      shareButton.querySelectorAll('[data-cgpt-share-label="fallback"]')
    );
    for (const duplicateFallback of fallbackLabels.slice(1)) {
      duplicateFallback.remove();
    }
    const nativeLabel =
      findNativeShareLabelElement(shareButton, expectedText) ||
      wrapNativeShareTextNode(shareButton, expectedText);
    for (const markedNative of shareButton.querySelectorAll('[data-cgpt-share-label="native"]')) {
      if (markedNative !== nativeLabel) {
        markedNative.removeAttribute('data-cgpt-share-label');
      }
    }
    if (nativeLabel) {
      nativeLabel.setAttribute('data-cgpt-share-label', 'native');
      fallbackLabels[0]?.remove();
      return nativeLabel;
    }
    let fallbackLabel = fallbackLabels[0];
    if (!fallbackLabel) {
      fallbackLabel = document.createElement('span');
      fallbackLabel.setAttribute('data-cgpt-share-label', 'fallback');
      fallbackLabel.setAttribute('aria-hidden', 'true');
      shareButton.append(fallbackLabel);
    }
    if (fallbackLabel.textContent !== expectedText) {
      fallbackLabel.textContent = expectedText;
    }
    return fallbackLabel;
  }
  /*
   * 移除 userscript 自己加入的分享 fallback 與共用 compact 狀態。
   *
   * 只刪除帶有 fallback marker 的節點，不碰 ChatGPT 原生文字。
   */
  function cleanupHeaderActionLayoutDom() {
    for (const fallbackLabel of document.querySelectorAll('[data-cgpt-share-label="fallback"]')) {
      fallbackLabel.remove();
    }
    for (const wrapper of document.querySelectorAll('[data-cgpt-share-label-wrapper="true"]')) {
      wrapper.replaceWith(...wrapper.childNodes);
    }
    for (const nativeLabel of document.querySelectorAll('[data-cgpt-share-label="native"]')) {
      nativeLabel.removeAttribute('data-cgpt-share-label');
    }
    for (const headerActions of document.querySelectorAll(
      `${LEGACY_HEADER_ACTIONS_SELECTOR}[data-cgpt-header-compact], ` +
      `${CURRENT_HEADER_ACTIONS_SELECTOR}[data-cgpt-header-compact]`
    )) {
      headerActions.removeAttribute('data-cgpt-header-compact');
    }
  }
  /*
   * 取得 page header 左右主要區塊，供 expanded 狀態的實際碰撞檢查使用。
   */
  function getHeaderLayoutParts(headerActions) {
    const legacyPageHeader = headerActions?.closest('header#page-header');
    if (legacyPageHeader) {
      const rightActions = headerActions.closest('[data-testid="thread-header-right-actions"]');
      const rightActionsContainer = headerActions.closest(
        '[data-testid="thread-header-right-actions-container"]'
      );
      const rightRegion = getDirectChildWithin(
        legacyPageHeader,
        rightActionsContainer || rightActions || headerActions
      );
      const leftRegion = Array.from(legacyPageHeader.children).find((child) => {
        if (child === rightRegion) {
          return false;
        }
        const style = getComputedStyle(child);
        const rect = child.getBoundingClientRect();
        return style.position !== 'absolute' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      }) || null;
      return {
        pageHeader: legacyPageHeader,
        rightActions,
        rightActionsContainer,
        rightRegion,
        leftRegion
      };
    }
    const appShellSurface = headerActions?.closest(
      '[data-testid="app-shell-header-context-menu-surface"]'
    );
    if (!appShellSurface) {
      return null;
    }
    const rightRegion = headerActions.closest('[data-app-shell-header-obstacle="true"]');
    const leftRegion = rightRegion?.previousElementSibling || null;
    return {
      pageHeader: appShellSurface,
      rightActions: headerActions,
      rightActionsContainer: rightRegion,
      rightRegion,
      leftRegion
    };
  }
  /*
   * 量測 Header 左側文字在目前 clone 狀態下的裁切壓力。
   *
   * 不依賴專案名稱文案或特定 class；只掃描左側 region 中實際含文字的
   * DOM 節點，記錄 scrollWidth / clientWidth 與 scrollHeight / clientHeight。
   * compact 與 expanded 使用同一份 clone DOM，因此可用節點順序穩定比對。
   */
  function measureLeftHeaderTextPressure(leftRegion) {
    if (!leftRegion) {
      return [];
    }
    const elements = [leftRegion, ...leftRegion.querySelectorAll('*')];
    const samples = [];
    for (let index = 0; index < elements.length; index += 1) {
      const element = elements[index];
      if (!normalizeUiText(element.textContent)) {
        continue;
      }
      const style = getComputedStyle(element);
      if (style.display === 'none') {
        continue;
      }
      const clientWidth = element.clientWidth;
      const clientHeight = element.clientHeight;
      const scrollWidth = element.scrollWidth;
      const scrollHeight = element.scrollHeight;
      samples.push({
        index,
        horizontalOverflow: Math.max(0, scrollWidth - clientWidth),
        verticalOverflow: Math.max(0, scrollHeight - clientHeight)
      });
    }
    return samples;
  }
  /*
   * 判斷 expanded 是否比 compact 額外擠壓左側 Header 文字。
   *
   * 左側內容若在 compact 本來就因自身 max-width 或視窗極窄而截斷，
   * 不會單憑「已截斷」就永遠維持 compact；只有 expanded 讓裁切量進一步
   * 增加超過量測容差時，才視為右側文字造成的版面壓力。
   */
  function hasExpandedLeftHeaderPressure(compactPressure, expandedPressure) {
    if (!compactPressure?.length || !expandedPressure?.length) {
      return false;
    }
    const compactByIndex = new Map(
      compactPressure.map((sample) => [sample.index, sample])
    );
    for (const expandedSample of expandedPressure) {
      const compactSample = compactByIndex.get(expandedSample.index);
      if (!compactSample) {
        continue;
      }
      if (
        expandedSample.horizontalOverflow > compactSample.horizontalOverflow + HEADER_LAYOUT_TOLERANCE ||
        expandedSample.verticalOverflow > compactSample.verticalOverflow + HEADER_LAYOUT_TOLERANCE
      ) {
        return true;
      }
    }
    return false;
  }
  /*
   * 將離屏 clone 的分享 + 單一匯出 Header action 切成指定版面狀態。
   *
   * 只修改 clone 上既有的 data attribute；正式頁面的 DOM 不會在量測過程
   * 中切換，因此不會造成可見閃動或 ResizeObserver 回授迴圈。
   */
  function setClonedHeaderActionsCompact(headerActions, isCompact) {
    const value = isCompact ? 'true' : 'false';
    headerActions.setAttribute('data-cgpt-header-compact', value);
    for (const cloneExportButton of headerActions.querySelectorAll('[data-cgpt-export-button="true"]')) {
      cloneExportButton.setAttribute('data-cgpt-export-compact', value);
    }
  }
  /*
   * 判斷離屏 expanded clone 是否造成實際版面壓力。
   *
   * 判定來源：
   *   1. 右側 action 容器實際 overflow。
   *   2. 右側 region 超出 Header 合法邊界（含原生負 margin 補償）。
   *   3. 左右 Header region 實際重疊。
   *   4. expanded 相較 compact 新增左側文字裁切 / 截斷。
   */
  function isExpandedHeaderLayoutConflicting(parts, headerActions, compactLeftPressure) {
    const measurableContainers = [
      headerActions,
      parts.rightActions,
      parts.rightActionsContainer
    ].filter(Boolean);
    if (
      measurableContainers.some(
        (element) =>
          element.clientWidth > 0 &&
          element.scrollWidth > element.clientWidth + HEADER_LAYOUT_TOLERANCE
      )
    ) {
      return true;
    }
    const headerRect = parts.pageHeader.getBoundingClientRect();
    const rightTarget = parts.rightRegion || headerActions;
    const rightRect = rightTarget.getBoundingClientRect();
    const headerStyle = getComputedStyle(parts.pageHeader);
    const rightStyle = getComputedStyle(rightTarget);
    const paddingStart = Number.parseFloat(headerStyle.paddingInlineStart) || 0;
    const paddingEnd = Number.parseFloat(headerStyle.paddingInlineEnd) || 0;
    const negativeMarginLeft = Math.min(0, Number.parseFloat(rightStyle.marginLeft) || 0);
    const negativeMarginRight = Math.min(0, Number.parseFloat(rightStyle.marginRight) || 0);
    /*
     * ChatGPT 原生 Header action wrapper 可能用負 margin 抵銷自身 padding。
     * 這類合法外延不應被視為 expanded 版面越界；邊界只額外放寬實際的負 margin。
     */
    const allowedLeft =
      headerRect.left + paddingStart + negativeMarginLeft - HEADER_LAYOUT_TOLERANCE;
    const allowedRight =
      headerRect.right - paddingEnd - negativeMarginRight + HEADER_LAYOUT_TOLERANCE;
    if (rightRect.left < allowedLeft || rightRect.right > allowedRight) {
      return true;
    }
    if (parts.leftRegion && parts.rightRegion) {
      const leftRect = parts.leftRegion.getBoundingClientRect();
      const directRightRect = parts.rightRegion.getBoundingClientRect();
      if (leftRect.right > directRightRect.left + HEADER_LAYOUT_TOLERANCE) {
        return true;
      }
    }
    const expandedLeftPressure = measureLeftHeaderTextPressure(parts.leftRegion);
    return hasExpandedLeftHeaderPressure(compactLeftPressure, expandedLeftPressure);
  }
  /*
   * 依 Header 實際版面壓力決定 compact 狀態，不使用固定 viewport / Header 寬度門檻。
   *
   * 先在同一份離屏 clone 量測 compact 基準，再切成 expanded 量測候選狀態。
   * 只要 expanded 沒有造成 overflow、越界、左右重疊或新增左側文字裁切，
   * 就維持文字顯示；即使視窗較窄也不會因固定 breakpoint 強制 compact。
   */
  function shouldUseCompactHeaderLayout(headerActions) {
    const parts = getHeaderLayoutParts(headerActions);
    if (!parts) {
      return true;
    }
    const headerRect = parts.pageHeader.getBoundingClientRect();
    if (headerRect.width <= 0 || headerRect.height <= 0) {
      return true;
    }
    /*
     * 使用離屏 clone 量測 compact / expanded，避免在原始 Header 上暫時切換尺寸。
     */
    const headerClone = parts.pageHeader.cloneNode(true);
    headerClone.setAttribute('aria-hidden', 'true');
    headerClone.setAttribute('inert', '');
    headerClone.style.setProperty('position', 'fixed', 'important');
    headerClone.style.setProperty('left', '-100000px', 'important');
    headerClone.style.setProperty('top', '0', 'important');
    headerClone.style.setProperty('width', `${headerRect.width}px`, 'important');
    headerClone.style.setProperty('height', `${Math.max(headerRect.height, 1)}px`, 'important');
    headerClone.style.setProperty('visibility', 'hidden', 'important');
    headerClone.style.setProperty('pointer-events', 'none', 'important');
    headerClone.style.setProperty('contain', 'layout paint', 'important');
    const cloneHeaderActions = headerClone.querySelector(HEADER_ACTIONS_SELECTOR);
    if (!cloneHeaderActions) {
      return true;
    }
    document.body.append(headerClone);
    try {
      const cloneParts = getHeaderLayoutParts(cloneHeaderActions);
      if (!cloneParts) {
        return true;
      }
      setClonedHeaderActionsCompact(cloneHeaderActions, true);
      const compactLeftPressure = measureLeftHeaderTextPressure(cloneParts.leftRegion);
      setClonedHeaderActionsCompact(cloneHeaderActions, false);
      return isExpandedHeaderLayoutConflicting(
        cloneParts,
        cloneHeaderActions,
        compactLeftPressure
      );
    } finally {
      headerClone.remove();
    }
  }
  /*
   * 排程分享 fallback reconciliation 與單一匯出觸發按鈕的共用版面狀態同步。
   */
  function syncHeaderActionLayout(
    headerActions,
    exportButton
  ) {
    if (!headerActions || !exportButton) {
      return;
    }
    if (headerActionLayoutTimer !== null) {
      cancelAnimationFrame(headerActionLayoutTimer);
    }
    headerActionLayoutTimer = requestAnimationFrame(() => {
      headerActionLayoutTimer = null;
      if (
        !headerActions.isConnected ||
        !exportButton.isConnected
      ) {
        closeExportMenu({ restoreFocus: false });
        return;
      }
      reconcileShareButtonLabel(headerActions);
      const isCompact = shouldUseCompactHeaderLayout(headerActions);
      setHeaderActionsCompact(
        headerActions,
        exportButton,
        isCompact
      );
      const menu = document.getElementById(EXPORT_MENU_ID);
      if (menu) {
        positionExportMenu(menu, exportButton);
      }
    });
  }
  /*
   * 停止 Header action 同步，清除 observer、listener、pending frame 與 fallback。
   */
  function stopObservingHeaderActionLayout() {
    if (headerActionLayoutTimer !== null) {
      cancelAnimationFrame(headerActionLayoutTimer);
      headerActionLayoutTimer = null;
    }
    if (headerActionLayoutObserver) {
      headerActionLayoutObserver.disconnect();
      headerActionLayoutObserver = null;
    }
    if (headerActionLayoutResizeObserver) {
      headerActionLayoutResizeObserver.disconnect();
      headerActionLayoutResizeObserver = null;
    }
    if (headerActionLayoutResizeHandler) {
      window.removeEventListener('resize', headerActionLayoutResizeHandler);
      headerActionLayoutResizeHandler = null;
    }
    observedHeaderActionLayoutTargets = null;
    cleanupHeaderActionLayoutDom();
  }
  /*
   * 開始觀察 Header action DOM 與寬度。
   *
   * 若 insertButtonsOnce() 的低頻補救再次命中同一組節點，直接沿用既有
   * observer；DOM 與尺寸變化會由 MutationObserver / ResizeObserver 觸發同步，
   * 避免每秒重建 observer 或重做離屏寬度測量。
   */
  function observeHeaderActionLayout(
    headerActions,
    exportButton
  ) {
    if (!headerActions || !exportButton) {
      return;
    }
    if (
      observedHeaderActionLayoutTargets &&
      observedHeaderActionLayoutTargets.headerActions === headerActions &&
      observedHeaderActionLayoutTargets.exportButton === exportButton
    ) {
      return;
    }
    stopObservingHeaderActionLayout();
    if (headerActions.closest('[data-testid="app-shell-header-context-menu-surface"]')) {
      markCurrentAppShellHeaderActions(headerActions);
    }
    observedHeaderActionLayoutTargets = {
      headerActions,
      exportButton
    };
    const parts = getHeaderLayoutParts(headerActions);
    const mutationRoot = parts?.pageHeader || headerActions;
    headerActionLayoutObserver = new MutationObserver(() => {
      syncHeaderActionLayout(headerActions, exportButton);
    });
    headerActionLayoutObserver.observe(mutationRoot, {
      attributes: true,
      childList: true,
      subtree: true,
      characterData: true,
      attributeFilter: [
        'class',
        'style',
        'hidden',
        'aria-hidden',
        'aria-label',
        'data-state',
        'data-fixed-header'
      ]
    });
    if (typeof ResizeObserver === 'function') {
      headerActionLayoutResizeObserver = new ResizeObserver(() => {
        syncHeaderActionLayout(headerActions, exportButton);
      });
      const resizeTargets = new Set([
        parts?.pageHeader,
        parts?.leftRegion,
        parts?.rightRegion,
        parts?.rightActionsContainer,
        parts?.rightActions,
        headerActions
      ]);
      for (const target of resizeTargets) {
        if (target) {
          headerActionLayoutResizeObserver.observe(target);
        }
      }
    }
    headerActionLayoutResizeHandler = () => {
      syncHeaderActionLayout(headerActions, exportButton);
    };
    window.addEventListener('resize', headerActionLayoutResizeHandler, {
      passive: true
    });
    syncHeaderActionLayout(headerActions, exportButton);
  }
  /*
   * 將單一「匯出」選單觸發按鈕插入 ChatGPT 對話頁 header。
   *
   * 這個函式同時負責建立、去重、搬移與狀態更新。
   * ChatGPT header 若因 SPA 導航或 React 重繪被重建，下一次 ensureButtonsSoon()
   * 會把按鈕放回正確位置。
   */
  function insertButtonsOnce() {
    if (!isConversationPage()) {
      removeButtonsIfNeeded();
      return;
    }
    removeDuplicateButtons(EXPORT_MENU_BUTTON_ID);
    for (const legacyButtonId of LEGACY_SINGLE_EXPORT_BUTTON_IDS) {
      for (const legacyButton of document.querySelectorAll(`#${legacyButtonId}`)) {
        legacyButton.remove();
      }
    }
    const headerActions = findHeaderActionsContainer();
    if (!headerActions) {
      return;
    }
    const exportButton = getOrCreateExportButton({
      id: EXPORT_MENU_BUTTON_ID,
      label: '匯出',
      ariaLabel: '匯出目前對話 JSON',
      testId: 'conversation-export-menu-button',
      iconSvg: HANDOFF_ICON_SVG,
      onClick: toggleExportMenu,
      onKeyDown: handleExportMenuTriggerKeyDown
    });
    exportButton.setAttribute('aria-haspopup', 'menu');
    if (!document.getElementById(EXPORT_MENU_ID)) {
      exportButton.setAttribute('aria-expanded', 'false');
      exportButton.setAttribute('data-state', 'closed');
      exportButton.removeAttribute('aria-controls');
    }
    if (
      document.getElementById(EXPORT_MENU_ID) &&
      exportMenuTriggerNode &&
      exportMenuTriggerNode !== exportButton
    ) {
      closeExportMenu({ restoreFocus: false });
    }
    syncCurrentHeaderButtonPresentation(
      headerActions,
      exportButton
    );
    placeExportButton(
      headerActions,
      exportButton
    );
    updateButtonState();
    observeHeaderActionLayout(
      headerActions,
      exportButton
    );
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
  // ============================================================
  // 六-A、批次匯出 UI、可追加佇列與延後打包
  // ============================================================
  /*
   * selectedConversations 是尚未加入 session 的 draft selection。
   * sessionTargets / pendingQueue / completedPayloads 則是已由使用者明確確認加入的項目。
   * 同一個 session 鎖定 raw、handoff 或 complete，concurrency 固定為 1。
   * 已完成 payload 只暫存在目前頁面記憶體；使用者按「打包」才建立 STORE ZIP。
   */
  const BATCH_SCOPE_GENERAL = 'general';
  const BATCH_SCOPE_PROJECT = 'project';
  const BATCH_EXPORT_RAW = 'raw';
  const BATCH_EXPORT_HANDOFF = 'handoff';
  const BATCH_EXPORT_COMPLETE = 'complete';
  const BATCH_PHASE_IDLE = 'idle';
  const BATCH_PHASE_SELECTING = 'selecting';
  const BATCH_PHASE_CONFIRMING = 'confirming';
  const BATCH_PHASE_SESSION = 'session';
  const BATCH_PHASE_PACKAGING = 'packaging';
  const BATCH_ITEM_PENDING = 'pending';
  const BATCH_ITEM_EXPORTING = 'exporting';
  const BATCH_ITEM_SUCCESS = 'success';
  const BATCH_ITEM_FAILED = 'failed';
  const BATCH_ITEM_SKIPPED = 'skipped';
  const BATCH_STYLE_ID = 'cgpt-batch-export-selection-style';
  const BATCH_GENERAL_CONTROLS_ID = 'cgpt-batch-export-general-controls';
  const BATCH_PROJECT_CONTROLS_ID = 'cgpt-batch-export-project-controls';
  const BATCH_DIALOG_ID = 'cgpt-batch-export-confirmation-dialog';
  const BATCH_CANCEL_JOB_DIALOG_ID = 'cgpt-batch-cancel-job-confirmation-dialog';
  const BATCH_SELECTED_COLOR = 'rgba(96, 165, 250, 0.24)';
  const BATCH_SELECTED_HOVER_COLOR = 'rgba(96, 165, 250, 0.32)';
  const BATCH_PROGRESS_FILL_COLOR = 'rgba(59, 130, 246, 0.42)';
  const BATCH_SUCCESS_COLOR = 'rgba(34, 197, 94, 0.28)';
  const BATCH_FAILED_COLOR = 'rgba(127, 29, 29, 0.76)';
  const BATCH_SKIPPED_COLOR = 'rgba(107, 114, 128, 0.28)';
  const BATCH_ROW_COLOR_TRANSITION_MS = 180;
  const BATCH_MOTION_TRANSITION_MS = 160;
  const BATCH_PROGRESS_CONVERSATION_START = 0.03;
  const BATCH_PROGRESS_CONVERSATION_END = 0.76;
  const BATCH_PROGRESS_TEXTDOCS_START = 0.82;
  const BATCH_PROGRESS_TEXTDOCS_END = 0.93;
  const BATCH_PROGRESS_HANDOFF_BUILD = 0.96;
  const BATCH_PROGRESS_HANDOFF_READY = 0.99;
  function createBatchSelectionState(scope) {
    return {
      scope,
      phase: BATCH_PHASE_IDLE,
      selectedConversations: new Map(),
      manuallyExcludedIds: new Set(),
      selectAllMode: false,
      rangeAnchorConversationId: null,
      selectionOrder: 0,
      routePathname: null,
      exportKind: null,
      sessionStartedAt: null,
      sessionUpdatedAt: null,
      sessionBlockedReason: '',
      sessionTargets: [],
      sessionConversationIds: new Set(),
      pendingQueue: [],
      workerRunning: false,
      currentConversationId: null,
      removedWhileProcessingIds: new Set(),
      itemRuntime: new Map(),
      completedPayloads: new Map(),
      sessionResults: new Map(),
      zipFilename: null,
      lastBatchResults: null,
      listRoot: null,
      listObserver: null,
      listClickHandler: null,
      listDblclickHandler: null,
      listKeydownHandler: null,
      listDragstartHandler: null,
      originalDraggableByLink: new Map(),
      closingMode: false
    };
  }
  const batchSelectionStates = new Map([
    [BATCH_SCOPE_GENERAL, createBatchSelectionState(BATCH_SCOPE_GENERAL)],
    [BATCH_SCOPE_PROJECT, createBatchSelectionState(BATCH_SCOPE_PROJECT)]
  ]);
  function getBatchSelectionState(scope) {
    return batchSelectionStates.get(scope) || null;
  }
  const batchRowDecorationCleanupTimers = new Map();
  let batchRequestSchedulerRunning = false;
  let batchRequestSchedulerLastScope = null;
  const batchMotionLifecycles = new WeakMap();
  let batchBeforeUnloadGuardAttached = false;
  let allowBatchUnloadOnce = false;
  let batchProjectTabObserver = null;
  let batchProjectObservedTablist = null;
  const BATCH_ENTRY_ICON_SVG = `
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20" data-icon-shape="non-circular" focusable="false" aria-hidden="true" class="icon-sm" fill="none">
          <rect x="3.25" y="3.25" width="13.5" height="13.5" rx="2.25" stroke="currentColor" stroke-width="1.5"/>
          <path d="M6.5 7.25h4.25M6.5 10h7M6.5 12.75h5.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          <path d="M13.5 6.25l1 1 1.75-2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
  `;
  const BATCH_CANCEL_ICON_SVG = `
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20" data-icon-shape="non-circular" focusable="false" aria-hidden="true" class="icon-sm" fill="none">
          <path d="M5.25 5.25l9.5 9.5M14.75 5.25l-9.5 9.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
        </svg>
  `;
  const BATCH_EXPORT_ICON_SVG = `
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20" data-icon-shape="non-circular" focusable="false" aria-hidden="true" class="icon-sm" fill="none">
          <path d="M10 3.25v8.5M6.75 8.75L10 12l3.25-3.25" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M4 13.25v1.5A1.25 1.25 0 0 0 5.25 16h9.5A1.25 1.25 0 0 0 16 14.75v-1.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
        </svg>
  `;
  const BATCH_SELECT_ALL_ICON_SVG = `
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20" data-icon-shape="non-circular" focusable="false" aria-hidden="true" class="icon-sm" fill="none">
          <rect x="5.25" y="5.25" width="10.5" height="10.5" rx="2" stroke="currentColor" stroke-width="1.5"/>
          <path d="M7.75 10.25l1.6 1.6 3.15-3.35" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M3.25 12V5A1.75 1.75 0 0 1 5 3.25h7" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/>
        </svg>
  `;
  const BATCH_PACKAGE_ICON_SVG = `
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20" data-icon-shape="non-circular" focusable="false" aria-hidden="true" class="icon-sm" fill="none">
          <path d="M4 6.25 10 3l6 3.25v7.5L10 17l-6-3.25z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
          <path d="m4.35 6.45 5.65 3.1 5.65-3.1M10 9.55V17" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
        </svg>
  `;
  const BATCH_STOP_ICON_SVG = `
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20" data-icon-shape="non-circular" focusable="false" aria-hidden="true" class="icon-sm" fill="none">
          <circle cx="10" cy="10" r="7" stroke="currentColor" stroke-width="1.5"/>
          <path d="M7.4 7.4l5.2 5.2M12.6 7.4l-5.2 5.2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
        </svg>
  `;
  function hasActiveBatchSession(state) {
    return Boolean(state && state.exportKind && state.sessionStartedAt);
  }
  /*
   * 只要一般聊天或專案聊天任一 scope 還有尚未安全結束的批次狀態，
   * 就視為離頁可能造成資料遺失：
   *   - 尚未加入 queue 的目前選取；
   *   - 已建立且尚未打包完成的 batch session；
   *   - 正在 packaging 的 session。
   *
   * 單純開啟批次面板但尚未選任何 conversation，不需要攔截離頁。
   */
  function hasUnsafeBatchUnloadState() {
    return [
      BATCH_SCOPE_GENERAL,
      BATCH_SCOPE_PROJECT
    ].some((scope) => {
      const state = getBatchSelectionState(scope);
      if (!state) {
        return false;
      }
      return (
        state.selectedConversations.size > 0 ||
        hasActiveBatchSession(state) ||
        state.phase === BATCH_PHASE_PACKAGING
      );
    });
  }
  function handleBatchBeforeUnload(event) {
    if (
      allowBatchUnloadOnce ||
      !hasUnsafeBatchUnloadState()
    ) {
      return;
    }
    /*
     * Chromium 目前只允許顯示瀏覽器提供的通用離頁警告文案；
     * event.returnValue 的具體文字不會呈現在 UI 中。
     */
    event.preventDefault();
    event.returnValue = '';
    return '';
  }
  function syncBatchBeforeUnloadGuard() {
    const shouldAttach = hasUnsafeBatchUnloadState();
    if (shouldAttach && !batchBeforeUnloadGuardAttached) {
      window.addEventListener(
        'beforeunload',
        handleBatchBeforeUnload
      );
      batchBeforeUnloadGuardAttached = true;
      return;
    }
    if (!shouldAttach && batchBeforeUnloadGuardAttached) {
      window.removeEventListener(
        'beforeunload',
        handleBatchBeforeUnload
      );
      batchBeforeUnloadGuardAttached = false;
      allowBatchUnloadOnce = false;
    }
  }
  function isBatchListLockedPhase(phase) {
    return [
      BATCH_PHASE_SELECTING,
      BATCH_PHASE_CONFIRMING,
      BATCH_PHASE_SESSION,
      BATCH_PHASE_PACKAGING
    ].includes(phase);
  }
  function isBatchSelectionEditableState(state) {
    if (
      !state ||
      state.closingMode ||
      state.phase === BATCH_PHASE_CONFIRMING ||
      state.phase === BATCH_PHASE_PACKAGING
    ) {
      return false;
    }
    if (state.phase === BATCH_PHASE_SELECTING) {
      return true;
    }
    return state.phase === BATCH_PHASE_SESSION && !state.sessionBlockedReason;
  }
  function getBatchExportKindLabel(exportKind) {
    if (exportKind === BATCH_EXPORT_RAW) return '原始 JSON';
    if (exportKind === BATCH_EXPORT_HANDOFF) return '交接 JSON';
    if (exportKind === BATCH_EXPORT_COMPLETE) return '完整 JSON';
    return '未知 JSON';
  }
  function getBatchExportKindIconSvg(exportKind) {
    if (exportKind === BATCH_EXPORT_RAW) return RAW_JSON_ICON_SVG;
    if (exportKind === BATCH_EXPORT_HANDOFF) return HANDOFF_ICON_SVG;
    return BATCH_EXPORT_ICON_SVG;
  }
  function countBatchStatus(state, status) {
    let count = 0;
    for (const runtime of state?.itemRuntime.values() || []) {
      if (runtime.status === status) {
        count += 1;
      }
    }
    return count;
  }
  function getBatchSessionResultArray(state) {
    return state.sessionTargets
      .map((target) => state.sessionResults.get(target.conversationId))
      .filter(Boolean);
  }
  function canPackageBatchSession(state) {
    return Boolean(
      hasActiveBatchSession(state) &&
      state.phase === BATCH_PHASE_SESSION &&
      !state.workerRunning &&
      state.pendingQueue.length === 0 &&
      state.selectedConversations.size === 0 &&
      state.sessionTargets.length > 0
    );
  }
  function ensureBatchSelectionStyles() {
    if (document.getElementById(BATCH_STYLE_ID)) {
      return;
    }
    const style = document.createElement('style');
    style.id = BATCH_STYLE_ID;
    style.textContent = `
      @property --cgpt-batch-progress {
        syntax: '<percentage>';
        inherits: false;
        initial-value: 0%;
      }
      [data-cgpt-batch-selection-row="true"][data-cgpt-batch-row-state="selected"] {
        background-color: ${BATCH_SELECTED_COLOR} !important;
      }
      [data-cgpt-batch-selection-row="true"][data-cgpt-batch-row-state="selected"]:hover {
        background-color: ${BATCH_SELECTED_HOVER_COLOR} !important;
      }
      [data-cgpt-batch-selection-row="true"][data-cgpt-batch-row-state="queued"] {
        position: relative !important;
        background-color: ${BATCH_SELECTED_COLOR} !important;
        background-image:
          repeating-linear-gradient(
            135deg,
            rgba(255,255,255,0.14) 0 8px,
            rgba(255,255,255,0.035) 8px 16px
          ),
          linear-gradient(
            to right,
            transparent 0 100%
          ) !important;
        background-size: 28px 28px, 100% 100% !important;
        background-repeat: repeat, no-repeat !important;
      }
      [data-cgpt-batch-selection-row="true"][data-cgpt-batch-row-state="exporting"] {
        position: relative !important;
        --cgpt-batch-progress: 0%;
        background-color: ${BATCH_SELECTED_COLOR} !important;
        background-image:
          repeating-linear-gradient(135deg, rgba(255,255,255,0.14) 0 8px, rgba(255,255,255,0.035) 8px 16px),
          linear-gradient(to right, ${BATCH_PROGRESS_FILL_COLOR} 0 var(--cgpt-batch-progress), transparent var(--cgpt-batch-progress) 100%) !important;
        background-size: 28px 28px, 100% 100% !important;
        background-repeat: repeat, no-repeat !important;
      }
      [data-cgpt-batch-selection-row="true"][data-cgpt-batch-row-state="success"] {
        background-color: ${BATCH_SUCCESS_COLOR} !important;
        background-image: none !important;
      }
      [data-cgpt-batch-selection-row="true"][data-cgpt-batch-row-state="failed"] {
        background-color: ${BATCH_FAILED_COLOR} !important;
        background-image: none !important;
      }
      [data-cgpt-batch-selection-row="true"][data-cgpt-batch-row-state="skipped"] {
        background-color: ${BATCH_SKIPPED_COLOR} !important;
        background-image: none !important;
      }
      [data-cgpt-batch-row-spinner] {
        position: absolute;
        inset-inline-end: 0.65rem;
        top: 50%;
        z-index: 3;
        width: 0.9rem;
        height: 0.9rem;
        margin-top: -0.45rem;
        border: 2px solid rgba(255,255,255,0.34);
        border-top-color: currentColor;
        border-radius: 9999px;
        pointer-events: none;
      }
      [data-cgpt-batch-selection-header="true"] [data-trailing-button] {
        opacity: 1 !important;
      }
      [data-cgpt-batch-selection-header="true"] [data-trailing-button]:not([data-cgpt-batch-action]) {
        transition-property: none !important;
        transition-duration: 0ms !important;
      }
      [data-cgpt-batch-selection-list="true"][data-cgpt-batch-selection-scope="general"]
        a[data-sidebar-item="true"][href^="/c/"] > .trailing {
        display: none !important;
      }
      /* Current App Shell：批次模式時隱藏 conversation row 自己的 hover actions。 */
      [data-cgpt-batch-selection-list="true"][data-cgpt-batch-selection-scope="general"]
        [data-sidebar-chatgpt-conversation-key] [data-hover-card-open-immediately="true"] {
        display: none !important;
      }
      [data-cgpt-batch-selection-list="true"][data-cgpt-batch-selection-scope="project"]
        [data-testid="project-conversation-overflow-menu"] {
        display: none !important;
      }
      [data-cgpt-batch-selection-list="true"][data-cgpt-batch-selection-scope="project"]
        [data-testid="project-conversation-overflow-date"] {
        opacity: 1 !important;
      }
      /* Current project list：保留日期，但隱藏列尾原生 menu button。 */
      [data-cgpt-batch-selection-row="true"][data-cgpt-batch-selection-scope="project"]
        button[aria-haspopup="menu"] {
        display: none !important;
      }
      [data-cgpt-batch-selection-row="true"][data-cgpt-batch-selection-scope="project"]
        > :last-child > span[aria-hidden="true"] {
        opacity: 1 !important;
      }
      [data-cgpt-batch-controls="general"][data-cgpt-batch-general-mode="panel"] {
        max-height: 24rem;
        margin: 0.35rem 0.5rem 0.55rem;
        padding: 0.4rem;
        border: 1px solid color-mix(in srgb, currentColor 20%, transparent);
        border-radius: var(--custom-large-radius, 12px);
        background: color-mix(in srgb, currentColor 4%, transparent);
        opacity: 1;
        transform: translateY(0);
        overflow: hidden;
        transition:
          max-height ${BATCH_MOTION_TRANSITION_MS}ms cubic-bezier(0.2,0,0,1),
          margin-block ${BATCH_MOTION_TRANSITION_MS}ms cubic-bezier(0.2,0,0,1),
          padding-block ${BATCH_MOTION_TRANSITION_MS}ms cubic-bezier(0.2,0,0,1),
          opacity ${BATCH_MOTION_TRANSITION_MS}ms ease,
          transform ${BATCH_MOTION_TRANSITION_MS}ms cubic-bezier(0.2,0,0,1),
          border-color ${BATCH_MOTION_TRANSITION_MS}ms ease,
          background-color ${BATCH_MOTION_TRANSITION_MS}ms ease;
      }
      [data-cgpt-batch-controls="general"][data-cgpt-batch-general-mode="panel"][data-cgpt-motion-state="open"] {
        animation:
          cgpt-batch-general-panel-enter
          ${BATCH_MOTION_TRANSITION_MS}ms
          cubic-bezier(0.2,0,0,1);
      }
      [data-cgpt-batch-controls="general"][data-cgpt-batch-general-mode="panel"][data-cgpt-motion-state="closed"] {
        max-height: 0;
        margin-block: 0;
        padding-block: 0;
        border-color: transparent;
        background-color: transparent;
        opacity: 0;
        transform: translateY(-4px);
        pointer-events: none;
      }
      [data-cgpt-batch-general-panel-header] {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.5rem;
        min-width: 0;
        padding: 0.35rem 0.45rem 0.45rem 0.6rem;
      }
      [data-cgpt-batch-general-panel-title] {
        min-width: 0;
        font-size: 1rem;
        line-height: 1.35;
        font-weight: 600;
        color: var(--text-primary);
      }
      [data-cgpt-batch-general-panel-status-list] {
        margin-top: 0.28rem;
        padding-inline-start: 1.1rem;
        list-style: disc;
        font-size: 0.75rem;
        line-height: 1.45;
        font-weight: 400;
        color: var(--text-tertiary);
      }
      [data-cgpt-batch-general-panel-status-list] > li {
        padding-block: 0.03rem;
      }
      [data-cgpt-batch-general-panel-actions] {
        display: flex;
        flex-direction: column;
        gap: 0;
      }
      [data-cgpt-batch-action-slot] {
        min-width: 0;
      }
      [data-cgpt-batch-action-slot][data-cgpt-batch-action-placement="general-panel"] {
        overflow: hidden;
        max-height: 3rem;
        margin-top: 0.15rem;
        opacity: 1;
        transform: translateY(0);
        transition:
          max-height ${BATCH_MOTION_TRANSITION_MS}ms cubic-bezier(0.2,0,0,1),
          margin-top ${BATCH_MOTION_TRANSITION_MS}ms cubic-bezier(0.2,0,0,1),
          opacity ${BATCH_MOTION_TRANSITION_MS}ms ease,
          transform ${BATCH_MOTION_TRANSITION_MS}ms cubic-bezier(0.2,0,0,1);
      }
      [data-cgpt-batch-action-slot][data-cgpt-batch-action-placement="general-panel"][data-cgpt-motion-state="closed"] {
        max-height: 0;
        margin-top: 0;
        opacity: 0;
        transform: translateY(-3px);
        pointer-events: none;
      }
      [data-cgpt-batch-general-action] {
        display: flex;
        width: 100%;
        min-height: 2.3rem;
        align-items: center;
        gap: 0.7rem;
        padding: 0.42rem 0.65rem;
        border-radius: var(--custom-large-radius, 12px);
        color: var(--text-primary);
        font-size: 0.8125rem;
        line-height: 1.3;
        text-align: start;
        transition: background-color 120ms ease, opacity 120ms ease;
      }
      [data-cgpt-batch-general-action]:not(:disabled):hover {
        background: color-mix(in srgb, currentColor 9%, transparent);
      }
      [data-cgpt-batch-general-action] svg {
        flex: 0 0 auto;
      }
      [data-cgpt-batch-general-action-label] {
        min-width: 0;
        flex: 1 1 auto;
      }
      [data-cgpt-batch-action="cancel-job"]:not(:disabled) {
        color: rgb(239 68 68);
      }
      [data-cgpt-batch-general-panel-close] {
        display: inline-flex;
        width: 2rem;
        height: 2rem;
        align-items: center;
        justify-content: center;
        border-radius: 0.5rem;
        color: var(--text-secondary);
        opacity: 1;
        scale: 1;
        transition:
          opacity ${BATCH_MOTION_TRANSITION_MS}ms ease,
          scale ${BATCH_MOTION_TRANSITION_MS}ms cubic-bezier(0.2,0,0,1);
      }
      [data-cgpt-batch-general-panel-close][data-cgpt-motion-state="closed"] {
        opacity: 0;
        scale: 0.92;
        pointer-events: none;
      }
      [data-cgpt-batch-general-panel-close]:hover {
        background: color-mix(in srgb, currentColor 9%, transparent);
        color: var(--text-primary);
      }
      [data-cgpt-batch-controls="project"] {
        display: flex;
        flex: 0 1 auto;
        min-width: 0;
        max-width: 52rem;
        align-items: center;
        gap: 0;
        margin-inline: 0.125rem;
        overflow: hidden;
        opacity: 1;
        transform: translateX(0);
        white-space: nowrap;
        transition:
          max-width ${BATCH_MOTION_TRANSITION_MS}ms cubic-bezier(0.2,0,0,1),
          margin-inline ${BATCH_MOTION_TRANSITION_MS}ms cubic-bezier(0.2,0,0,1),
          opacity ${BATCH_MOTION_TRANSITION_MS}ms ease,
          transform ${BATCH_MOTION_TRANSITION_MS}ms cubic-bezier(0.2,0,0,1);
      }
      [data-cgpt-batch-controls="project"][data-cgpt-motion-state="closed"] {
        max-width: 0;
        margin-inline: 0;
        opacity: 0;
        transform: translateX(-4px);
        pointer-events: none;
      }
      [data-cgpt-batch-controls="project"] [data-cgpt-batch-action] > div {
        gap: 0.4rem;
      }
      /* 專案頁整組 batch action（入口、匯出、全選、取消選取、打包、取消作業、關閉）統一縮小一號。 */
      [data-cgpt-batch-controls="project"] [data-cgpt-batch-action] {
        font-size: 0.8125rem;
        line-height: 1.125rem;
      }
      [data-cgpt-batch-action-slot][data-cgpt-batch-action-placement="project"] {
        display: inline-flex;
        flex: 0 0 auto;
        overflow: hidden;
        max-width: 18rem;
        margin-inline-end: 0.35rem;
        opacity: 1;
        transform: translateX(0);
        transition:
          max-width ${BATCH_MOTION_TRANSITION_MS}ms cubic-bezier(0.2,0,0,1),
          margin-inline-end ${BATCH_MOTION_TRANSITION_MS}ms cubic-bezier(0.2,0,0,1),
          opacity ${BATCH_MOTION_TRANSITION_MS}ms ease,
          transform ${BATCH_MOTION_TRANSITION_MS}ms cubic-bezier(0.2,0,0,1);
      }
      [data-cgpt-batch-action-slot][data-cgpt-batch-action-placement="project"][data-cgpt-motion-state="closed"] {
        max-width: 0;
        margin-inline-end: 0;
        opacity: 0;
        transform: translateX(-4px);
        pointer-events: none;
      }
      /*
       * Current App Shell 已不再提供舊版 .btn / .btn-secondary 的基礎幾何。
       * 批次確認視窗仍保留那些 class 作 legacy 相容，但在本 dialog 內自行補回
       * 舊版 ChatGPT .btn 的 36px / text-sm / px-3 比例，避免目前 build 只剩
       * 顏色覆寫而讓文字、padding、邊框與取消按鈕比例失真。
       */
      [data-cgpt-batch-dialog-button="true"] {
        pointer-events: auto;
        min-height: 2.25rem;
        padding-inline: 0.75rem;
        border-style: solid;
        border-width: 1px;
        border-color: var(--border-medium, rgba(255,255,255,0.14));
        border-radius: 9999px;
        background-color: var(--bg-primary, var(--main-surface-primary, transparent));
        color: var(--text-primary, currentColor);
        box-sizing: border-box;
        display: inline-flex;
        flex: 0 0 auto;
        align-items: center;
        justify-content: center;
        font-size: var(--text-sm, 0.875rem);
        line-height: var(--text-sm--line-height, 1.25rem);
        font-weight: var(--font-weight-medium, 500);
        white-space: nowrap;
      }
      [data-cgpt-batch-dialog-button="true"] > div {
        display: flex;
        min-width: 0;
        align-items: center;
        justify-content: center;
        gap: 0.5rem;
      }
      [data-cgpt-batch-dialog-button="true"] svg {
        flex: 0 0 auto;
      }
      [data-cgpt-batch-dialog-button="true"]:not([data-cgpt-batch-dialog-download="true"]):not([data-cgpt-batch-dialog-danger="true"]):is(:hover,:focus-visible) {
        background-color: var(--main-surface-secondary, rgba(255,255,255,0.08));
      }
      [data-cgpt-batch-dialog-button="true"]:active:not(:disabled) {
        opacity: 0.8;
      }
      [data-cgpt-batch-dialog-button="true"]:disabled {
        cursor: not-allowed;
        opacity: 0.5;
      }
      [data-cgpt-batch-dialog-download="true"] {
        background-color: #ffffff !important;
        color: #000000 !important;
        border-color: rgba(0,0,0,0.14) !important;
      }
      [data-cgpt-batch-dialog-download="true"]:is(:hover,:focus-visible) {
        background-color: #f2f2f2 !important;
        color: #000000 !important;
      }
      [data-cgpt-batch-dialog-download="true"]:active {
        background-color: #e8e8e8 !important;
        color: #000000 !important;
      }
      [data-cgpt-batch-dialog-download="true"] :is(svg,path,span,div) {
        color: inherit !important;
      }
      [data-cgpt-batch-dialog-danger="true"] {
        background-color: rgb(220 38 38) !important;
        color: #fff !important;
        border-color: rgb(220 38 38) !important;
      }
      [data-cgpt-batch-dialog-danger="true"]:hover {
        background-color: rgb(185 28 28) !important;
      }
      [data-cgpt-batch-dialog-list] {
        max-height: min(50vh,420px);
        overflow-y: auto;
        scrollbar-width: thin;
      }
      [data-cgpt-batch-dialog-shell] [data-cgpt-batch-dialog-backdrop]::before {
        opacity: 1;
        transition: opacity ${BATCH_MOTION_TRANSITION_MS}ms ease;
      }
      [data-cgpt-batch-dialog-shell] [data-cgpt-batch-dialog-surface] {
        opacity: 1;
        scale: 1;
        transition:
          opacity ${BATCH_MOTION_TRANSITION_MS}ms ease,
          scale ${BATCH_MOTION_TRANSITION_MS}ms cubic-bezier(0.2,0,0,1);
      }
      [data-cgpt-batch-dialog-shell][data-cgpt-motion-state="closed"] {
        pointer-events: none;
      }
      [data-cgpt-batch-dialog-shell][data-cgpt-motion-state="closed"] [data-cgpt-batch-dialog-backdrop]::before {
        opacity: 0;
      }
      [data-cgpt-batch-dialog-shell][data-cgpt-motion-state="closed"] [data-cgpt-batch-dialog-surface] {
        opacity: 0;
        scale: 0.985;
      }
      /*
       * 新建立 finite-motion UI 的 entry 起始值。
       * 由 Chromium @starting-style 建立 before-change style，
       * 避免 JS 在 click handler 中同步讀取 layout。
       */
      @starting-style {
        [data-cgpt-batch-action-slot][data-cgpt-batch-action-placement="general-panel"][data-cgpt-motion-state="open"] {
          max-height: 0;
          margin-top: 0;
          opacity: 0;
          transform: translateY(-3px);
        }
        [data-cgpt-batch-general-panel-close][data-cgpt-motion-state="open"] {
          opacity: 0;
          scale: 0.92;
        }
        [data-cgpt-batch-controls="project"][data-cgpt-motion-state="open"] {
          max-width: 0;
          margin-inline: 0;
          opacity: 0;
          transform: translateX(-4px);
        }
        [data-cgpt-batch-action-slot][data-cgpt-batch-action-placement="project"][data-cgpt-motion-state="open"] {
          max-width: 0;
          margin-inline-end: 0;
          opacity: 0;
          transform: translateX(-4px);
        }
        [data-cgpt-batch-dialog-shell][data-cgpt-motion-state="open"] [data-cgpt-batch-dialog-backdrop]::before {
          opacity: 0;
        }
        [data-cgpt-batch-dialog-shell][data-cgpt-motion-state="open"] [data-cgpt-batch-dialog-surface] {
          opacity: 0;
          scale: 0.985;
        }
      }
      @keyframes cgpt-batch-general-panel-enter {
        from {
          max-height: 0;
          margin-block: 0;
          padding-block: 0;
          border-color: transparent;
          background-color: transparent;
          opacity: 0;
          transform: translateY(-4px);
        }
        to {
          max-height: 24rem;
          margin-block: 0.35rem 0.55rem;
          padding-block: 0.4rem;
          border-color: color-mix(in srgb, currentColor 20%, transparent);
          background-color: color-mix(in srgb, currentColor 4%, transparent);
          opacity: 1;
          transform: translateY(0);
        }
      }
      @keyframes cgpt-batch-progress-stripes {
        from { background-position: 0 0, 0 0; }
        to { background-position: 28px 0, 0 0; }
      }
      @keyframes cgpt-batch-row-spinner {
        to { transform: rotate(360deg); }
      }
      @media (prefers-reduced-motion: no-preference) {
        [data-cgpt-batch-selection-row="true"] {
          transition:
            --cgpt-batch-progress 120ms linear,
            background-color ${BATCH_ROW_COLOR_TRANSITION_MS}ms ease;
        }
        [data-cgpt-batch-selection-row="true"]:is(
          [data-cgpt-batch-row-state="queued"],
          [data-cgpt-batch-row-state="exporting"]
        ) {
          animation: cgpt-batch-progress-stripes 620ms linear infinite;
        }
        [data-cgpt-batch-row-spinner] {
          animation: cgpt-batch-row-spinner 720ms linear infinite;
        }
      }
      @media (prefers-reduced-motion: reduce) {
        [data-cgpt-batch-controls="general"][data-cgpt-batch-general-mode="panel"],
        [data-cgpt-batch-general-panel-close],
        [data-cgpt-batch-action-slot],
        [data-cgpt-batch-controls="project"],
        [data-cgpt-batch-dialog-backdrop]::before,
        [data-cgpt-batch-dialog-surface] {
          transition: none !important;
        }
        [data-cgpt-batch-controls="general"][data-cgpt-batch-general-mode="panel"] {
          animation: none !important;
        }
      }
    `;
    document.head.append(style);
  }
  function getConversationIdFromHref(href) {
    try {
      const parsedUrl = new URL(href, location.origin);
      if (parsedUrl.origin !== location.origin) {
        return null;
      }
      const match = parsedUrl.pathname.match(/\/c\/([^/?#]+)\/?$/);
      if (!match) {
        return null;
      }
      const conversationId = decodeURIComponent(match[1]);
      return isExportableConversationId(conversationId) ? conversationId : null;
    } catch {
      return null;
    }
  }
  function findLegacyGeneralBatchUiContext() {
    const history = document.getElementById('history');
    if (!history || !history.parentElement) {
      return null;
    }
    let header = history.previousElementSibling;
    if (header?.id === BATCH_GENERAL_CONTROLS_ID) {
      header = header.previousElementSibling;
    }
    if (!header || !header.parentElement) {
      return null;
    }
    const actionHost = header.lastElementChild;
    if (!actionHost || actionHost === header.firstElementChild) {
      return null;
    }
    return {
      scope: BATCH_SCOPE_GENERAL,
      layout: 'legacy',
      active: true,
      controlsHost: actionHost,
      panelHost: history.parentElement,
      header,
      listRoot: history
    };
  }
  function findCurrentGeneralBatchUiContext() {
    /*
     * Current App Shell 沒有 #history。
     * 由實際 conversation listitem 往上找 role=list 與同一個 sidebar section，
     * 再從 section toggle 找到 header / action host。這避免依賴「最近項目」文字或語系。
     */
    const conversationRow = document.querySelector(
      '[data-sidebar-chatgpt-conversation-key][role="listitem"]'
    );
    if (!conversationRow) {
      return null;
    }
    const listRoot = conversationRow.closest('[role="list"]');
    const section = conversationRow.closest('section[data-app-action-sidebar-section]');
    if (!listRoot || !section || !section.contains(listRoot)) {
      return null;
    }
    const toggle = section.querySelector('[data-app-action-sidebar-section-toggle]');
    const header = toggle?.closest?.('[data-state][aria-expanded]') || null;
    const actionHost = header?.lastElementChild || null;
    const panelHost = listRoot.parentElement;
    if (
      !header ||
      !actionHost ||
      actionHost === header.firstElementChild ||
      !panelHost
    ) {
      return null;
    }
    return {
      scope: BATCH_SCOPE_GENERAL,
      layout: 'current',
      active: true,
      controlsHost: actionHost,
      panelHost,
      header,
      listRoot
    };
  }
  function findGeneralBatchUiContext() {
    return (
      findLegacyGeneralBatchUiContext() ||
      findCurrentGeneralBatchUiContext()
    );
  }
  function getProjectTabsFromTablist(tablist, mode) {
    if (!tablist) {
      return null;
    }
    if (mode === 'legacy') {
      const chatTab = tablist.querySelector('[role="tab"][id$="-chats"]');
      const sourcesTab = tablist.querySelector('[role="tab"][id$="-sources"]');
      return chatTab && sourcesTab
        ? { chatTab, sourcesTab }
        : null;
    }
    const tabs = Array.from(
      tablist.querySelectorAll('[role="tab"][aria-controls]')
    );
    const chatTab = tabs.find((tab) =>
      /-chats$/.test(tab.getAttribute('aria-controls') || '')
    ) || null;
    const sourcesTab = tabs.find((tab) =>
      /-sources$/.test(tab.getAttribute('aria-controls') || '')
    ) || null;
    return chatTab && sourcesTab
      ? { chatTab, sourcesTab }
      : null;
  }
  function buildProjectBatchUiContext(tablist, tabs, layout) {
    if (!tablist || !tabs?.chatTab || !tabs?.sourcesTab) {
      return null;
    }
    const { chatTab, sourcesTab } = tabs;
    const panelId = chatTab.getAttribute('aria-controls');
    const panel = panelId ? document.getElementById(panelId) : null;
    const listRoot = panel ? panel.querySelector('section > ol') : null;
    const active =
      (
        chatTab.getAttribute('data-state') === 'active' ||
        chatTab.getAttribute('aria-selected') === 'true'
      ) &&
      Boolean(listRoot);
    const sourcesTabSlot =
      sourcesTab.parentElement?.parentElement === tablist
        ? sourcesTab.parentElement
        : sourcesTab;
    return {
      scope: BATCH_SCOPE_PROJECT,
      layout,
      active,
      controlsHost: tablist,
      tablist,
      chatTab,
      sourcesTab,
      sourcesTabSlot,
      listRoot
    };
  }
  function findProjectBatchUiContext() {
    // Legacy project-home-tabs branch first, for rollback compatibility.
    const legacyTablist = document.querySelector(
      '[role="tablist"][id^="project-home-tabs-"]'
    );
    const legacyTabs = getProjectTabsFromTablist(
      legacyTablist,
      'legacy'
    );
    if (legacyTabs) {
      return buildProjectBatchUiContext(
        legacyTablist,
        legacyTabs,
        'legacy'
      );
    }
    /*
     * Current project home：
     * tablist id 是 React generated / may be absent；tab 本身改成 *-chats-tab，
     * 但 aria-controls 仍穩定指向 *-chats / *-sources panel。
     * 因此只以 role + aria-controls 的語意配對，不依賴中文 tab 文字。
     */
    for (const tablist of document.querySelectorAll('[role="tablist"]')) {
      const currentTabs = getProjectTabsFromTablist(
        tablist,
        'current'
      );
      if (!currentTabs) {
        continue;
      }
      const context = buildProjectBatchUiContext(
        tablist,
        currentTabs,
        'current'
      );
      if (context) {
        return context;
      }
    }
    return null;
  }
  function getBatchUiContext(scope) {
    return scope === BATCH_SCOPE_GENERAL
      ? findGeneralBatchUiContext()
      : scope === BATCH_SCOPE_PROJECT
        ? findProjectBatchUiContext()
        : null;
  }
  function getGeneralBatchConversationLink(row) {
    if (!row) {
      return null;
    }
    if (
      row.matches?.(
        'a[data-sidebar-item="true"][href^="/c/"], ' +
        'a[data-interactive-row-link="true"][href^="/c/"]'
      )
    ) {
      return row;
    }
    return row.querySelector?.(
      'a[data-interactive-row-link="true"][href^="/c/"], a[href^="/c/"]'
    ) || null;
  }
  function getBatchConversationRows(context) {
    if (!context?.listRoot) {
      return [];
    }
    if (context.scope === BATCH_SCOPE_GENERAL) {
      if (context.layout === 'current') {
        return Array.from(
          context.listRoot.querySelectorAll(
            '[data-sidebar-chatgpt-conversation-key][role="listitem"]'
          )
        ).filter((row) => Boolean(getGeneralBatchConversationLink(row)));
      }
      return Array.from(
        context.listRoot.querySelectorAll('a[data-sidebar-item="true"][href^="/c/"]')
      );
    }
    return Array.from(context.listRoot.querySelectorAll('li')).filter((row) => {
      return Boolean(row.querySelector('a[href*="/c/"]'));
    });
  }
  function getBatchConversationInfo(row, scope) {
    if (!row) {
      return null;
    }
    const link = scope === BATCH_SCOPE_GENERAL
      ? getGeneralBatchConversationLink(row)
      : row.querySelector('a[href*="/c/"]');
    if (!link) {
      return null;
    }
    const conversationId = getConversationIdFromHref(
      link.getAttribute('href') || link.href || ''
    );
    if (!conversationId) {
      return null;
    }
    let title = '';
    if (scope === BATCH_SCOPE_GENERAL) {
      title = String(
        link.getAttribute('aria-label') ||
        row.querySelector?.('[data-thread-title="true"]')?.textContent ||
        ''
      ).replace(/\s+/g, ' ').trim();
    } else {
      title = String(
        link.querySelector('.text-sm.font-medium')?.textContent || ''
      ).replace(/\s+/g, ' ').trim();
    }
    if (!title) {
      title = getKnownConversationTitle(conversationId) || conversationId;
    }
    return {
      conversationId,
      title,
      hrefPath: new URL(
        link.getAttribute('href') || link.href || '',
        location.origin
      ).pathname
    };
  }
  function rememberBatchConversation(state, info) {
    if (
      !state ||
      !info ||
      state.sessionConversationIds.has(info.conversationId) ||
      state.removedWhileProcessingIds.has(info.conversationId) ||
      state.selectedConversations.has(info.conversationId)
    ) {
      return;
    }
    state.selectionOrder += 1;
    state.selectedConversations.set(info.conversationId, {
      ...info,
      selectionOrder: state.selectionOrder
    });
  }
  function forgetBatchConversation(state, conversationId) {
    state?.selectedConversations.delete(conversationId);
  }
  function clearPendingBatchRowDecorationCleanup(scope) {
    const timer = batchRowDecorationCleanupTimers.get(scope);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      batchRowDecorationCleanupTimers.delete(scope);
    }
  }
  function removeBatchRowSpinner(row) {
    row?.querySelector(':scope > [data-cgpt-batch-row-spinner]')?.remove();
  }
  function ensureBatchRowSpinner(row) {
    if (!row || row.querySelector(':scope > [data-cgpt-batch-row-spinner]')) {
      return;
    }
    const spinner = document.createElement('span');
    spinner.setAttribute('data-cgpt-batch-row-spinner', 'true');
    spinner.setAttribute('aria-hidden', 'true');
    row.append(spinner);
  }
  function clearBatchRowVisualAttributes(row) {
    if (!row) {
      return;
    }
    row.removeAttribute('data-cgpt-batch-row-state');
    row.removeAttribute('data-cgpt-batch-progress-mode');
    row.removeAttribute('data-cgpt-batch-progress-stage');
    row.style.removeProperty('--cgpt-batch-progress');
    removeBatchRowSpinner(row);
  }
  function finalizeBatchConversationRowDecorations(scope) {
    clearPendingBatchRowDecorationCleanup(scope);
    const selector =
      `[data-cgpt-batch-selection-row="true"][data-cgpt-batch-selection-scope="${scope}"]`;
    for (const row of document.querySelectorAll(selector)) {
      clearBatchRowVisualAttributes(row);
      row.removeAttribute('data-cgpt-batch-selection-row');
      row.removeAttribute('data-cgpt-batch-selection-scope');
    }
  }
  function applyBatchSelectionContextMarkers(context) {
    if (!context?.listRoot) {
      return;
    }
    context.listRoot.setAttribute('data-cgpt-batch-selection-list', 'true');
    context.listRoot.setAttribute('data-cgpt-batch-selection-scope', context.scope);
    if (context.scope === BATCH_SCOPE_GENERAL && context.header) {
      context.header.setAttribute('data-cgpt-batch-selection-header', 'true');
    }
  }
  function clearBatchSelectionContextMarkers(scope) {
    if (scope === BATCH_SCOPE_GENERAL) {
      for (const header of document.querySelectorAll('[data-cgpt-batch-selection-header="true"]')) {
        header.removeAttribute('data-cgpt-batch-selection-header');
      }
    }
    const selector =
      `[data-cgpt-batch-selection-list="true"][data-cgpt-batch-selection-scope="${scope}"]`;
    for (const list of document.querySelectorAll(selector)) {
      list.removeAttribute('data-cgpt-batch-selection-list');
      list.removeAttribute('data-cgpt-batch-selection-scope');
    }
  }
  function disableGeneralBatchRowDragging(state, row) {
    if (!state || state.scope !== BATCH_SCOPE_GENERAL || !row) {
      return;
    }
    const link = getGeneralBatchConversationLink(row);
    if (!link) {
      return;
    }
    if (!state.originalDraggableByLink.has(link)) {
      state.originalDraggableByLink.set(link, {
        hadAttribute: link.hasAttribute('draggable'),
        value: link.getAttribute('draggable')
      });
    }
    link.setAttribute('draggable', 'false');
    link.setAttribute('data-cgpt-batch-drag-disabled', 'true');
  }
  function restoreGeneralBatchRowDragging(state) {
    if (!state) {
      return;
    }
    for (const [link, original] of state.originalDraggableByLink.entries()) {
      try {
        if (original.hadAttribute) {
          link.setAttribute('draggable', original.value ?? '');
        } else {
          link.removeAttribute('draggable');
        }
        link.removeAttribute('data-cgpt-batch-drag-disabled');
      } catch { }
    }
    state.originalDraggableByLink.clear();
  }
  function getBatchConversationVisualState(state, conversationId) {
    const runtime = state?.itemRuntime.get(conversationId);
    if (runtime) {
      if (runtime.status === BATCH_ITEM_EXPORTING) return BATCH_ITEM_EXPORTING;
      if (runtime.status === BATCH_ITEM_SUCCESS) return BATCH_ITEM_SUCCESS;
      if (runtime.status === BATCH_ITEM_FAILED) return BATCH_ITEM_FAILED;
      if (runtime.status === BATCH_ITEM_SKIPPED) return BATCH_ITEM_SKIPPED;
      if (runtime.status === BATCH_ITEM_PENDING) return 'queued';
    }
    return state?.selectedConversations.has(conversationId) ? 'selected' : null;
  }
  function applyBatchConversationRowVisualState(row, info, state) {
    if (!row || !info || !state) {
      return;
    }
    row.setAttribute('data-cgpt-batch-selection-row', 'true');
    row.setAttribute('data-cgpt-batch-selection-scope', state.scope);
    if (state.scope === BATCH_SCOPE_GENERAL && isBatchListLockedPhase(state.phase)) {
      disableGeneralBatchRowDragging(state, row);
    }
    const visualState = getBatchConversationVisualState(state, info.conversationId);
    if (!visualState) {
      clearBatchRowVisualAttributes(row);
      return;
    }
    row.setAttribute('data-cgpt-batch-row-state', visualState);
    const runtime = state.itemRuntime.get(info.conversationId);
    if (visualState === BATCH_ITEM_EXPORTING && runtime) {
      const progress = Math.min(1, Math.max(0, Number(runtime.progress) || 0));
      row.style.setProperty('--cgpt-batch-progress', `${(progress * 100).toFixed(2)}%`);
      row.setAttribute(
        'data-cgpt-batch-progress-mode',
        runtime.progressMode === 'determinate' ? 'determinate' : 'indeterminate'
      );
      row.setAttribute('data-cgpt-batch-progress-stage', runtime.stage || 'working');
      ensureBatchRowSpinner(row);
    } else if (visualState === 'queued') {
      row.style.removeProperty('--cgpt-batch-progress');
      row.setAttribute('data-cgpt-batch-progress-mode', 'indeterminate');
      row.setAttribute('data-cgpt-batch-progress-stage', 'queued');
      removeBatchRowSpinner(row);
    } else {
      row.style.removeProperty('--cgpt-batch-progress');
      row.removeAttribute('data-cgpt-batch-progress-mode');
      row.removeAttribute('data-cgpt-batch-progress-stage');
      removeBatchRowSpinner(row);
    }
  }
  function syncBatchConversationRows(scope, { autoSelectNew = false } = {}) {
    const state = getBatchSelectionState(scope);
    if (!state || !isBatchListLockedPhase(state.phase)) {
      return;
    }
    const context = getBatchUiContext(scope);
    if (!context?.listRoot) {
      return;
    }
    for (const row of getBatchConversationRows(context)) {
      const info = getBatchConversationInfo(row, context.scope);
      if (!info) {
        continue;
      }
      if (
        isBatchSelectionEditableState(state) &&
        autoSelectNew &&
        state.selectAllMode &&
        !state.manuallyExcludedIds.has(info.conversationId) &&
        !state.sessionConversationIds.has(info.conversationId)
      ) {
        rememberBatchConversation(state, info);
      }
      applyBatchConversationRowVisualState(row, info, state);
    }
    renderBatchControls();
  }
  function syncSingleBatchConversationRow(scope, conversationId) {
    const state = getBatchSelectionState(scope);
    const context = getBatchUiContext(scope);
    if (!state || !context?.listRoot) {
      return;
    }
    for (const row of getBatchConversationRows(context)) {
      const info = getBatchConversationInfo(row, context.scope);
      if (info?.conversationId === conversationId) {
        applyBatchConversationRowVisualState(row, info, state);
        return;
      }
    }
  }
  function clearBatchConversationRowDecorations(scope, { animate = true } = {}) {
    clearPendingBatchRowDecorationCleanup(scope);
    const selector =
      `[data-cgpt-batch-selection-row="true"][data-cgpt-batch-selection-scope="${scope}"]`;
    const rows = Array.from(document.querySelectorAll(selector));
    for (const row of rows) {
      clearBatchRowVisualAttributes(row);
    }
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (!animate || reduced || rows.length === 0) {
      finalizeBatchConversationRowDecorations(scope);
      return;
    }
    const timer = window.setTimeout(() => {
      batchRowDecorationCleanupTimers.delete(scope);
      finalizeBatchConversationRowDecorations(scope);
    }, BATCH_ROW_COLOR_TRANSITION_MS + 30);
    batchRowDecorationCleanupTimers.set(scope, timer);
  }
  function getBatchConversationRowFromEventTarget(target, context) {
    if (!(target instanceof Element) || !context?.listRoot) {
      return null;
    }
    if (context.scope === BATCH_SCOPE_GENERAL) {
      if (context.layout === 'current') {
        const row = target.closest(
          '[data-sidebar-chatgpt-conversation-key][role="listitem"]'
        );
        return (
          row &&
          context.listRoot.contains(row) &&
          getGeneralBatchConversationLink(row)
        )
          ? row
          : null;
      }
      const row = target.closest('a[data-sidebar-item="true"][href^="/c/"]');
      return row && context.listRoot.contains(row) ? row : null;
    }
    const row = target.closest('li');
    return row && context.listRoot.contains(row) && row.querySelector('a[href*="/c/"]')
      ? row
      : null;
  }
  function removeConversationFromBatchSession(scope, conversationId) {
    const state = getBatchSelectionState(scope);
    if (
      !state ||
      !hasActiveBatchSession(state) ||
      !state.sessionConversationIds.has(conversationId)
    ) {
      return false;
    }
    const isCurrentlyProcessing =
      state.workerRunning &&
      state.currentConversationId === conversationId;
    state.sessionConversationIds.delete(conversationId);
    state.sessionTargets = state.sessionTargets.filter(
      (target) => target.conversationId !== conversationId
    );
    state.pendingQueue = state.pendingQueue.filter(
      (target) => target.conversationId !== conversationId
    );
    state.completedPayloads.delete(conversationId);
    state.sessionResults.delete(conversationId);
    state.itemRuntime.delete(conversationId);
    state.manuallyExcludedIds.add(conversationId);
    if (isCurrentlyProcessing) {
      state.removedWhileProcessingIds.add(conversationId);
    }
    if (state.rangeAnchorConversationId === conversationId) {
      state.rangeAnchorConversationId = null;
    }
    state.sessionUpdatedAt = Date.now();
    syncSingleBatchConversationRow(scope, conversationId);
    renderBatchControls();
    return true;
  }
  function toggleBatchConversationRow(scope, row, context) {
    const state = getBatchSelectionState(scope);
    const info = getBatchConversationInfo(row, context.scope);
    if (!state || !info) {
      return;
    }
    if (state.sessionConversationIds.has(info.conversationId)) {
      removeConversationFromBatchSession(scope, info.conversationId);
      return;
    }
    if (state.removedWhileProcessingIds.has(info.conversationId)) {
      return;
    }
    if (state.selectedConversations.has(info.conversationId)) {
      forgetBatchConversation(state, info.conversationId);
      if (state.selectAllMode) {
        state.manuallyExcludedIds.add(info.conversationId);
      }
    } else {
      state.manuallyExcludedIds.delete(info.conversationId);
      rememberBatchConversation(state, info);
    }
    state.rangeAnchorConversationId = info.conversationId;
    syncBatchConversationRows(scope);
  }
  function selectBatchConversationRange(scope, row, context) {
    const state = getBatchSelectionState(scope);
    const targetInfo = getBatchConversationInfo(row, context.scope);
    if (
      !state ||
      !targetInfo ||
      state.sessionConversationIds.has(targetInfo.conversationId) ||
      state.removedWhileProcessingIds.has(targetInfo.conversationId)
    ) {
      return;
    }
    const anchorId = state.rangeAnchorConversationId;
    if (!anchorId) {
      toggleBatchConversationRow(scope, row, context);
      return;
    }
    const items = getBatchConversationRows(context)
      .map((candidateRow) => ({
        info: getBatchConversationInfo(candidateRow, context.scope)
      }))
      .filter((item) => Boolean(item.info));
    const anchorIndex = items.findIndex((item) => item.info.conversationId === anchorId);
    const targetIndex = items.findIndex(
      (item) => item.info.conversationId === targetInfo.conversationId
    );
    if (anchorIndex < 0 || targetIndex < 0) {
      toggleBatchConversationRow(scope, row, context);
      return;
    }
    const from = Math.min(anchorIndex, targetIndex);
    const to = Math.max(anchorIndex, targetIndex);
    for (let index = from; index <= to; index += 1) {
      const info = items[index].info;
      if (
        state.sessionConversationIds.has(info.conversationId) ||
        state.removedWhileProcessingIds.has(info.conversationId)
      ) {
        continue;
      }
      state.manuallyExcludedIds.delete(info.conversationId);
      rememberBatchConversation(state, info);
    }
    syncBatchConversationRows(scope);
  }
  function handleBatchListClick(scope, event) {
    const state = getBatchSelectionState(scope);
    if (!state || !isBatchListLockedPhase(state.phase)) {
      return;
    }
    const context = getBatchUiContext(scope);
    const row = getBatchConversationRowFromEventTarget(event.target, context);
    if (!row) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    const info = getBatchConversationInfo(row, context.scope);
    if (info && state.sessionConversationIds.has(info.conversationId)) {
      removeConversationFromBatchSession(scope, info.conversationId);
      return;
    }
    if (!isBatchSelectionEditableState(state)) {
      return;
    }
    if (event.shiftKey) {
      selectBatchConversationRange(scope, row, context);
    } else {
      toggleBatchConversationRow(scope, row, context);
    }
  }
  function handleBatchListDblClick(scope, event) {
    if (scope !== BATCH_SCOPE_GENERAL) {
      return;
    }
    const state = getBatchSelectionState(scope);
    if (!state || !isBatchListLockedPhase(state.phase)) {
      return;
    }
    const context = getBatchUiContext(scope);
    const row = getBatchConversationRowFromEventTarget(event.target, context);
    if (!row) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  }
  function handleBatchListKeydown(scope, event) {
    const state = getBatchSelectionState(scope);
    if (
      !state ||
      !isBatchListLockedPhase(state.phase) ||
      (event.key !== 'Enter' && event.key !== ' ')
    ) {
      return;
    }
    const context = getBatchUiContext(scope);
    const row = getBatchConversationRowFromEventTarget(event.target, context);
    if (!row) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    const info = getBatchConversationInfo(row, context.scope);
    if (info && state.sessionConversationIds.has(info.conversationId)) {
      removeConversationFromBatchSession(scope, info.conversationId);
      return;
    }
    if (!isBatchSelectionEditableState(state)) {
      return;
    }
    if (event.shiftKey) {
      selectBatchConversationRange(scope, row, context);
    } else {
      toggleBatchConversationRow(scope, row, context);
    }
  }
  function handleBatchListDragStart(scope, event) {
    const state = getBatchSelectionState(scope);
    if (scope !== BATCH_SCOPE_GENERAL || !state || !isBatchListLockedPhase(state.phase)) {
      return;
    }
    const context = getBatchUiContext(scope);
    if (!getBatchConversationRowFromEventTarget(event.target, context)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  }
  function detachBatchSelectionListBinding(scope) {
    const state = getBatchSelectionState(scope);
    if (!state) {
      return;
    }
    clearBatchSelectionContextMarkers(scope);
    if (state.listRoot && state.listClickHandler) {
      state.listRoot.removeEventListener('click', state.listClickHandler, true);
    }
    if (state.listRoot && state.listDblclickHandler) {
      state.listRoot.removeEventListener('dblclick', state.listDblclickHandler, true);
    }
    if (state.listRoot && state.listKeydownHandler) {
      state.listRoot.removeEventListener('keydown', state.listKeydownHandler, true);
    }
    if (state.listRoot && state.listDragstartHandler) {
      state.listRoot.removeEventListener('dragstart', state.listDragstartHandler, true);
    }
    if (state.listObserver) {
      state.listObserver.disconnect();
    }
    restoreGeneralBatchRowDragging(state);
    state.listRoot = null;
    state.listObserver = null;
    state.listClickHandler = null;
    state.listDblclickHandler = null;
    state.listKeydownHandler = null;
    state.listDragstartHandler = null;
  }
  function bindBatchSelectionList(context) {
    const state = getBatchSelectionState(context?.scope);
    if (!context?.listRoot || !state || !isBatchListLockedPhase(state.phase)) {
      return;
    }
    if (state.listRoot === context.listRoot) {
      applyBatchSelectionContextMarkers(context);
      syncBatchConversationRows(context.scope, {
        autoSelectNew: isBatchSelectionEditableState(state) && state.selectAllMode
      });
      return;
    }
    detachBatchSelectionListBinding(context.scope);
    applyBatchSelectionContextMarkers(context);
    state.listRoot = context.listRoot;
    state.listClickHandler = (event) => handleBatchListClick(context.scope, event);
    state.listDblclickHandler = (event) => handleBatchListDblClick(context.scope, event);
    state.listKeydownHandler = (event) => handleBatchListKeydown(context.scope, event);
    state.listDragstartHandler = (event) => handleBatchListDragStart(context.scope, event);
    context.listRoot.addEventListener('click', state.listClickHandler, true);
    if (context.scope === BATCH_SCOPE_GENERAL) {
      context.listRoot.addEventListener('dblclick', state.listDblclickHandler, true);
    }
    context.listRoot.addEventListener('keydown', state.listKeydownHandler, true);
    if (context.scope === BATCH_SCOPE_GENERAL) {
      context.listRoot.addEventListener('dragstart', state.listDragstartHandler, true);
    }
    state.listObserver = new MutationObserver(() => {
      syncBatchConversationRows(context.scope, {
        autoSelectNew: isBatchSelectionEditableState(state) && state.selectAllMode
      });
    });
    state.listObserver.observe(context.listRoot, { childList: true, subtree: true });
    syncBatchConversationRows(context.scope, {
      autoSelectNew: isBatchSelectionEditableState(state) && state.selectAllMode
    });
  }
  function createBatchActionButton({
    scope,
    action,
    label,
    iconSvg,
    disabled = false,
    placement = 'auto'
  }) {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('data-cgpt-batch-action', action);
    button.disabled = disabled;
    const actualPlacement = placement === 'auto'
      ? (scope === BATCH_SCOPE_GENERAL ? 'header' : 'project')
      : placement;
    if (actualPlacement === 'header') {
      button.className = [
        'disabled:text-token-text-tertiary',
        'pointer-events-auto',
        'disabled:pointer-events-none',
        'touch:min-h-10',
        'keyboard-focused:*:focus-ring',
        'relative',
        'isolate',
        'flex',
        'min-h-9',
        'items-center',
        'self-stretch',
        'rounded-e-[10px]',
        'focus:outline-none',
        '-my-2',
        '-ms-1',
        'ps-1',
        '-me-2.5',
        'pe-1.5',
        'text-inherit',
        'interactive-label-secondary',
        'data-[state=open]:text-(--interactive-label-hover-secondary)',
        'transition-opacity',
        'focus-visible:opacity-100',
        'can-hover:opacity-0',
        'can-hover:group-hover/sidebar-expando-section-header:opacity-100',
        'group-hover/nav-section-title:opacity-100',
        'group-focus-within/nav-section-title:opacity-100',
        'cant-hover:opacity-100'
      ].join(' ');
      button.setAttribute('data-trailing-button', '');
      button.setAttribute('aria-label', label);
      button.title = label;
      button.innerHTML =
        `<div class="flex items-center justify-center rounded-lg p-1">${iconSvg}</div>`;
      return button;
    }
    if (actualPlacement === 'general-panel') {
      button.className = 'focus:outline-none';
      button.setAttribute('data-cgpt-batch-general-action', 'true');
      button.setAttribute('aria-label', label);
      button.title = label;
      button.innerHTML =
        `${iconSvg}<span data-cgpt-batch-general-action-label>${label}</span>`;
      return button;
    }
    button.className = [
      'btn',
      'relative',
      'group-focus-within/dialog:focus-visible:[outline-width:1.5px]',
      'group-focus-within/dialog:focus-visible:[outline-offset:2.5px]',
      'group-focus-within/dialog:focus-visible:[outline-style:solid]',
      'group-focus-within/dialog:focus-visible:[outline-color:var(--text-primary)]',
      'btn-secondary',
      'touch:h-10',
      'h-9',
      'px-3'
    ].join(' ');
    button.setAttribute('aria-label', label);
    button.title = label;
    button.innerHTML =
      `<div class="flex items-center justify-center">${iconSvg}<span>${label}</span></div>`;
    return button;
  }
  function applyCurrentGeneralBatchEntryAppearance(button, context, iconSvg) {
    if (!button || context?.layout !== 'current') {
      return;
    }
    /*
     * Current App Shell 的三顆原生 header action 都包在會於 hover/focus 才展開的
     * wrapper 內。自訂批次入口刻意放在該 wrapper 之後，並直接沿用其中一顆
     * secondary / transparent 原生按鈕的外觀，讓它永遠顯示、維持最右側，
     * 顏色與原生按鈕一致，同時不把另外三顆原生按鈕強制顯示。
     */
    const nativeButton = context.controlsHost?.querySelector?.(
      'button[data-color="secondary"][data-variant="transparent"]'
    ) || null;
    if (nativeButton) {
      button.className = nativeButton.className;
      for (const attributeName of [
        'data-color',
        'data-size',
        'data-icon-size',
        'data-uniform',
        'data-variant'
      ]) {
        if (nativeButton.hasAttribute(attributeName)) {
          button.setAttribute(
            attributeName,
            nativeButton.getAttribute(attributeName) ?? ''
          );
        } else {
          button.removeAttribute(attributeName);
        }
      }
      const nativeInner = nativeButton.firstElementChild;
      if (nativeInner instanceof Element) {
        const inner = nativeInner.cloneNode(false);
        inner.innerHTML = iconSvg;
        button.replaceChildren(inner);
      } else {
        button.innerHTML = iconSvg;
      }
    } else {
      /*
       * 若未來 header 原生 action 暫時不存在，至少解除 legacy hover-only
       * opacity class，並使用目前 secondary 文字 token 作保守 fallback。
       */
      for (const className of [
        'can-hover:opacity-0',
        'can-hover:group-hover/sidebar-expando-section-header:opacity-100',
        'group-hover/nav-section-title:opacity-100',
        'group-focus-within/nav-section-title:opacity-100'
      ]) {
        button.classList.remove(className);
      }
      button.style.opacity = '1';
      button.style.color = 'var(--text-secondary)';
    }
    button.removeAttribute('data-trailing-button');
  }
  function getOrCreateBatchControls(scope) {
    const id = scope === BATCH_SCOPE_GENERAL
      ? BATCH_GENERAL_CONTROLS_ID
      : BATCH_PROJECT_CONTROLS_ID;
    let controls = document.getElementById(id);
    if (!controls) {
      controls = document.createElement('div');
      controls.id = id;
      controls.setAttribute('data-cgpt-batch-controls', scope);
    }
    return controls;
  }
  function placeBatchControls(
    scope,
    controls,
    context,
    state
  ) {
    if (scope === BATCH_SCOPE_GENERAL) {
      if (state.phase === BATCH_PHASE_IDLE) {
        clearBatchMotionLifecycle(controls);
        controls.removeAttribute(
          'data-cgpt-motion-state'
        );
        controls.removeAttribute('inert');
        controls.removeAttribute('aria-hidden');
        controls.setAttribute(
          'data-cgpt-batch-general-mode',
          'header'
        );
        controls.className = 'contents';
        if (context.layout === 'current') {
          if (
            controls.parentElement !==
            context.controlsHost ||
            context.controlsHost.lastElementChild !==
            controls
          ) {
            context.controlsHost.appendChild(
              controls
            );
          }
        } else if (
          controls.parentElement !==
          context.controlsHost ||
          context.controlsHost.firstElementChild !==
          controls
        ) {
          context.controlsHost.insertBefore(
            controls,
            context.controlsHost.firstElementChild
          );
        }
      } else {
        const enteringPanel =
          controls.getAttribute(
            'data-cgpt-batch-general-mode'
          ) !== 'panel';
        controls.setAttribute(
          'data-cgpt-batch-general-mode',
          'panel'
        );
        controls.className = '';
        if (enteringPanel) {
          setBatchMotionStateImmediately(
            controls,
            false
          );
        }
        if (
          controls.parentElement !==
          context.panelHost ||
          controls.nextElementSibling !==
          context.listRoot
        ) {
          context.panelHost.insertBefore(
            controls,
            context.listRoot
          );
        }
        if (enteringPanel) {
          transitionBatchMotionState(
            controls,
            true
          );
        }
      }
      return;
    }
    controls.className = '';
    controls.setAttribute('role', 'presentation');
    controls.removeAttribute(
      'data-cgpt-batch-general-mode'
    );
    if (
      !controls.hasAttribute(
        'data-cgpt-motion-state'
      )
    ) {
      setBatchMotionStateImmediately(
        controls,
        false
      );
    }
    const projectInsertBefore =
      context.sourcesTabSlot ||
      context.sourcesTab;
    if (
      controls.parentElement !== context.tablist ||
      controls.nextElementSibling !==
      projectInsertBefore
    ) {
      context.tablist.insertBefore(
        controls,
        projectInsertBefore
      );
    }
  }
  function removeBatchControlsIfContextMissing(scope) {
    const state = getBatchSelectionState(scope);
    if (hasActiveBatchSession(state)) {
      return;
    }
    const id = scope === BATCH_SCOPE_GENERAL
      ? BATCH_GENERAL_CONTROLS_ID
      : BATCH_PROJECT_CONTROLS_ID;
    document.getElementById(id)?.remove();
  }
  function getBatchPanelStatusItems(state) {
    const draftCount = state.selectedConversations.size;
    if (!hasActiveBatchSession(state)) {
      return [`目前選取：${draftCount}`];
    }
    const items = [`類型：${getBatchExportKindLabel(state.exportKind)}`];
    const success = countBatchStatus(state, BATCH_ITEM_SUCCESS);
    const failed = countBatchStatus(state, BATCH_ITEM_FAILED);
    if (success > 0) items.push(`成功：${success}`);
    if (failed > 0) items.push(`失敗：${failed}`);
    if (state.workerRunning) items.push('處理中：1');
    if (state.pendingQueue.length > 0) items.push(`佇列：${state.pendingQueue.length}`);
    if (draftCount > 0) items.push(`目前選取：${draftCount}`);
    if (
      !state.workerRunning &&
      state.pendingQueue.length === 0 &&
      draftCount === 0 &&
      state.sessionTargets.length > 0
    ) {
      items.push('狀態：可打包');
    }
    return items;
  }
  function prefersReducedBatchMotion() {
    return Boolean(
      window.matchMedia?.(
        '(prefers-reduced-motion: reduce)'
      ).matches
    );
  }
  function clearBatchMotionLifecycle(element) {
    const lifecycle = batchMotionLifecycles.get(element);
    if (!lifecycle) {
      return;
    }
    if (lifecycle.timer !== null) {
      window.clearTimeout(lifecycle.timer);
    }
    if (
      lifecycle.transitionElement &&
      lifecycle.transitionHandler
    ) {
      lifecycle.transitionElement.removeEventListener(
        'transitionend',
        lifecycle.transitionHandler
      );
    }
    batchMotionLifecycles.delete(element);
  }
  function applyBatchMotionAccessibility(
    element,
    open
  ) {
    const isOpen = Boolean(open);
    element.toggleAttribute('inert', !isOpen);
    if (isOpen) {
      element.removeAttribute('aria-hidden');
    } else {
      element.setAttribute('aria-hidden', 'true');
    }
  }
  function setBatchMotionStateImmediately(
    element,
    open
  ) {
    if (!element) {
      return;
    }
    clearBatchMotionLifecycle(element);
    element.setAttribute(
      'data-cgpt-motion-state',
      open ? 'open' : 'closed'
    );
    applyBatchMotionAccessibility(
      element,
      open
    );
  }
  /*
   * 統一有限狀態動畫 lifecycle：
   *
   *   初次 mount：
   *     JS 直接切到目標 state；CSS @starting-style 提供 before-change style。
   *
   *   已存在 DOM：
   *     JS 直接切換 open / closed，交由既有 CSS transition 自然反向。
   *
   * 一般側邊欄 controls 從 header 變成 panel 時，元素本身不是新 DOM，
   * 因此 entry 由 CSS keyframe 處理。整個 lifecycle 不再同步讀取
   * getBoundingClientRect / offsetWidth，不強迫瀏覽器在 click handler 中
   * 立即結算全頁 style / layout。
   *
   * 退場仍保留 DOM 到 transitionend 後才 cleanup。
   * JS 只管理 state / accessibility / cleanup，不使用 WAAPI。
   * setTimeout 只作 transitionend 未送達時的保險 fallback。
   */
  function transitionBatchMotionState(
    element,
    open,
    {
      transitionElement = element,
      transitionProperty = null,
      onSettled = null
    } = {}
  ) {
    if (!element) {
      if (typeof onSettled === 'function') {
        onSettled();
      }
      return;
    }
    const targetState = open ? 'open' : 'closed';
    const existing = batchMotionLifecycles.get(element);
    if (existing?.targetState === targetState) {
      return;
    }
    clearBatchMotionLifecycle(element);
    let currentState = element.getAttribute(
      'data-cgpt-motion-state'
    );
    if (currentState === targetState) {
      applyBatchMotionAccessibility(
        element,
        open
      );
      if (typeof onSettled === 'function') {
        window.queueMicrotask(onSettled);
      }
      return;
    }
    /*
     * 若是剛建立、尚未有 motion state 的 DOM，先標記與目標相反的
     * 邏輯 state；若同一 task 內隨即切 open，初次 render 的視覺起始值
     * 由 CSS @starting-style 接手，不需要同步 layout flush。
     */
    if (!currentState) {
      currentState = open ? 'closed' : 'open';
      element.setAttribute(
        'data-cgpt-motion-state',
        currentState
      );
      applyBatchMotionAccessibility(
        element,
        !open
      );
    }
    /*
     * 退場一開始就停止新的互動，但 DOM / layout 仍保留到 transition 完成。
     */
    if (!open) {
      applyBatchMotionAccessibility(
        element,
        false
      );
    }
    if (
      prefersReducedBatchMotion() ||
      !element.isConnected
    ) {
      element.setAttribute(
        'data-cgpt-motion-state',
        targetState
      );
      applyBatchMotionAccessibility(
        element,
        open
      );
      if (typeof onSettled === 'function') {
        onSettled();
      }
      return;
    }
    const lifecycle = {
      targetState,
      timer: null,
      transitionElement: null,
      transitionHandler: null
    };
    batchMotionLifecycles.set(
      element,
      lifecycle
    );
    const settle = () => {
      if (
        batchMotionLifecycles.get(element) !==
        lifecycle
      ) {
        return;
      }
      clearBatchMotionLifecycle(element);
      if (typeof onSettled === 'function') {
        onSettled();
      }
    };
    if (
      typeof onSettled === 'function' &&
      transitionElement
    ) {
      lifecycle.transitionElement =
        transitionElement;
      lifecycle.transitionHandler = (event) => {
        if (event.target !== transitionElement) {
          return;
        }
        if (
          transitionProperty &&
          event.propertyName !== transitionProperty
        ) {
          return;
        }
        settle();
      };
      transitionElement.addEventListener(
        'transitionend',
        lifecycle.transitionHandler
      );
    }
    element.setAttribute(
      'data-cgpt-motion-state',
      targetState
    );
    if (open) {
      applyBatchMotionAccessibility(
        element,
        true
      );
    }
    if (typeof onSettled === 'function') {
      lifecycle.timer = window.setTimeout(
        settle,
        BATCH_MOTION_TRANSITION_MS + 120
      );
    } else {
      batchMotionLifecycles.delete(element);
    }
  }
  function getOrCreateBatchActionSlot(
    target,
    action,
    placement
  ) {
    let slot = Array.from(target.children).find(
      (candidate) =>
        candidate instanceof HTMLElement &&
        candidate.getAttribute(
          'data-cgpt-batch-action-slot'
        ) === action
    );
    if (!slot) {
      slot = document.createElement('div');
      slot.setAttribute(
        'data-cgpt-batch-action-slot',
        action
      );
      slot.setAttribute(
        'data-cgpt-batch-action-placement',
        placement
      );
      setBatchMotionStateImmediately(
        slot,
        false
      );
      target.append(slot);
    }
    return slot;
  }
  function syncBatchActionSlots(
    target,
    definitions,
    placement
  ) {
    const expectedActions = new Set(
      definitions.map(
        (definition) => definition.action
      )
    );
    definitions.forEach(
      (definition, definitionIndex) => {
        const slot = getOrCreateBatchActionSlot(
          target,
          definition.action,
          placement
        );
        const currentAtIndex =
          target.children[definitionIndex] || null;
        if (currentAtIndex !== slot) {
          target.insertBefore(
            slot,
            currentAtIndex
          );
        }
        const shouldShow = Boolean(
          definition.visible
        );
        let button = slot.querySelector(
          ':scope > [data-cgpt-batch-action]'
        );
        /*
         * action 的 label / icon / handler 對同一 action 是穩定的。
         * DOM 只在第一次建立，後續只更新 title；退場時不拆 DOM。
         */
        if (!button) {
          button = createBatchActionButton({
            scope: definition.scope,
            action: definition.action,
            label: definition.label,
            iconSvg: definition.iconSvg,
            disabled: false,
            placement
          });
          if (
            typeof definition.onClick === 'function'
          ) {
            button.addEventListener(
              'click',
              definition.onClick
            );
          }
          slot.append(button);
        }
        button.title =
          definition.title || definition.label;
        transitionBatchMotionState(
          slot,
          shouldShow
        );
      }
    );
    for (const child of Array.from(target.children)) {
      if (
        !(child instanceof HTMLElement) ||
        !child.hasAttribute(
          'data-cgpt-batch-action-slot'
        )
      ) {
        continue;
      }
      const action = child.getAttribute(
        'data-cgpt-batch-action-slot'
      );
      if (!expectedActions.has(action)) {
        transitionBatchMotionState(
          child,
          false
        );
      }
    }
  }
  function buildBatchActionDefinitions(scope, state) {
    const draftCount = state.selectedConversations.size;
    const sessionActive = hasActiveBatchSession(state);
    const packaging =
      state.phase === BATCH_PHASE_PACKAGING;
    const editable = isBatchSelectionEditableState(state);
    const blocked = Boolean(state.sessionBlockedReason);
    return [
      {
        scope,
        action: 'export',
        label: '匯出',
        iconSvg: BATCH_EXPORT_ICON_SVG,
        visible:
          draftCount > 0 &&
          editable &&
          !blocked,
        title: sessionActive
          ? `把目前選取的 ${draftCount} 個對話加入既有批次`
          : `確認要批次匯出的 ${draftCount} 個對話`,
        onClick: () => {
          showBatchConfirmationDialog(scope);
        }
      },
      {
        scope,
        action: 'select-all',
        label: '全選',
        iconSvg: BATCH_SELECT_ALL_ICON_SVG,
        visible:
          editable &&
          !blocked,
        title: state.selectAllMode
          ? '重新全選目前列表，並繼續自動選取後續載入的對話'
          : '全選目前列表，並自動選取後續載入的對話',
        onClick: () => {
          selectAllBatchConversations(scope);
        }
      },
      {
        scope,
        action: 'clear-current-selection',
        label: '取消目前選取',
        iconSvg: BATCH_CANCEL_ICON_SVG,
        visible:
          draftCount > 0 &&
          editable,
        title:
          '只清除尚未加入佇列的目前藍色選取',
        onClick: () => {
          clearCurrentBatchSelection(scope);
        }
      },
      {
        scope,
        action: 'package',
        label: '打包',
        iconSvg: BATCH_PACKAGE_ICON_SVG,
        visible: canPackageBatchSession(state),
        title:
          '把目前 session 已取得的結果封裝成 STORE ZIP 並下載。',
        onClick: () => {
          void packageBatchSession(scope);
        }
      },
      {
        scope,
        action: 'cancel-job',
        label: '取消批次下載作業',
        iconSvg: BATCH_STOP_ICON_SVG,
        visible:
          sessionActive &&
          !packaging,
        title:
          '確認後會重新整理目前網頁，清除尚未打包的批次資料與作業狀態。',
        onClick: () => {
          showCancelBatchJobDialog(scope);
        }
      }
    ];
  }
  function appendBatchActionSet(
    scope,
    target,
    state,
    placement
  ) {
    syncBatchActionSlots(
      target,
      buildBatchActionDefinitions(scope, state),
      placement
    );
  }
  function renderGeneralBatchControls(
    controls,
    context,
    state
  ) {
    if (state.phase === BATCH_PHASE_IDLE) {
      controls.replaceChildren();
      controls.removeAttribute(
        'data-cgpt-batch-panel-scaffold'
      );
      const entry = createBatchActionButton({
        scope: BATCH_SCOPE_GENERAL,
        action: 'start',
        label: '批次匯出',
        iconSvg: BATCH_ENTRY_ICON_SVG,
        disabled: !context.active,
        placement: 'header'
      });
      applyCurrentGeneralBatchEntryAppearance(
        entry,
        context,
        BATCH_ENTRY_ICON_SVG
      );
      entry.addEventListener('click', () =>
        beginBatchSelectionMode(
          BATCH_SCOPE_GENERAL
        )
      );
      controls.append(entry);
      return;
    }
    let header = controls.querySelector(
      ':scope > [data-cgpt-batch-general-panel-header]'
    );
    let title = controls.querySelector(
      '[data-cgpt-batch-general-panel-title]'
    );
    let statusList = controls.querySelector(
      '[data-cgpt-batch-general-panel-status-list]'
    );
    let actions = controls.querySelector(
      ':scope > [data-cgpt-batch-general-panel-actions]'
    );
    let close = controls.querySelector(
      '[data-cgpt-batch-general-panel-close]'
    );
    if (!header || !title || !statusList || !actions) {
      controls.replaceChildren();
      controls.setAttribute(
        'data-cgpt-batch-panel-scaffold',
        'true'
      );
      header = document.createElement('div');
      header.setAttribute(
        'data-cgpt-batch-general-panel-header',
        'true'
      );
      const titleWrap = document.createElement('div');
      titleWrap.className = 'min-w-0';
      title = document.createElement('div');
      title.setAttribute(
        'data-cgpt-batch-general-panel-title',
        'true'
      );
      title.textContent = '批次匯出';
      statusList = document.createElement('ul');
      statusList.setAttribute(
        'data-cgpt-batch-general-panel-status-list',
        'true'
      );
      titleWrap.append(title, statusList);
      header.append(titleWrap);
      close = document.createElement('button');
      close.type = 'button';
      close.setAttribute(
        'data-cgpt-batch-general-panel-close',
        'true'
      );
      setBatchMotionStateImmediately(
        close,
        false
      );
      close.setAttribute(
        'aria-label',
        '關閉批次模式'
      );
      close.title = '關閉批次模式';
      close.innerHTML = BATCH_CANCEL_ICON_SVG;
      close.addEventListener('click', () =>
        closeBatchSelectionMode(
          BATCH_SCOPE_GENERAL
        )
      );
      header.append(close);
      actions = document.createElement('div');
      actions.setAttribute(
        'data-cgpt-batch-general-panel-actions',
        'true'
      );
      controls.append(header, actions);
    }
    title.textContent = '批次匯出';
    statusList.replaceChildren();
    for (
      const statusText of getBatchPanelStatusItems(state)
    ) {
      const statusItem =
        document.createElement('li');
      statusItem.textContent = statusText;
      statusList.append(statusItem);
    }
    const showClose = !hasActiveBatchSession(state);
    transitionBatchMotionState(
      close,
      showClose
    );
    appendBatchActionSet(
      BATCH_SCOPE_GENERAL,
      actions,
      state,
      'general-panel'
    );
  }
  function renderProjectBatchControls(
    controls,
    context,
    state
  ) {
    const visible = Boolean(context.active);
    controls.setAttribute(
      'data-cgpt-batch-visible',
      visible ? 'true' : 'false'
    );
    if (state.phase === BATCH_PHASE_IDLE) {
      controls.replaceChildren();
      controls.removeAttribute(
        'data-cgpt-batch-project-action-host'
      );
      const entry = createBatchActionButton({
        scope: BATCH_SCOPE_PROJECT,
        action: 'start',
        label: '批次匯出',
        iconSvg: BATCH_ENTRY_ICON_SVG,
        disabled: !context.active,
        placement: 'project'
      });
      entry.addEventListener('click', () =>
        beginBatchSelectionMode(
          BATCH_SCOPE_PROJECT
        )
      );
      controls.append(entry);
      transitionBatchMotionState(
        controls,
        visible
      );
      return;
    }
    if (
      controls.getAttribute(
        'data-cgpt-batch-project-action-host'
      ) !== 'true'
    ) {
      controls.replaceChildren();
      controls.setAttribute(
        'data-cgpt-batch-project-action-host',
        'true'
      );
    }
    const definitions =
      buildBatchActionDefinitions(
        BATCH_SCOPE_PROJECT,
        state
      );
    definitions.push({
      scope: BATCH_SCOPE_PROJECT,
      action: 'close-mode',
      label: '關閉',
      iconSvg: BATCH_CANCEL_ICON_SVG,
      visible:
        !hasActiveBatchSession(state) &&
        state.phase === BATCH_PHASE_SELECTING,
      title: '關閉批次模式',
      onClick: () => {
        closeBatchSelectionMode(
          BATCH_SCOPE_PROJECT
        );
      }
    });
    syncBatchActionSlots(
      controls,
      definitions,
      'project'
    );
    transitionBatchMotionState(
      controls,
      visible
    );
  }
  function renderBatchControlsForScope(scope, context) {
    const state = getBatchSelectionState(scope);
    if (!state) {
      return;
    }
    const controls = getOrCreateBatchControls(scope);
    placeBatchControls(scope, controls, context, state);
    const signature = [
      state.phase,
      context.active ? 'active' : 'inactive',
      state.selectedConversations.size,
      state.selectAllMode ? 'all' : 'manual',
      state.exportKind || 'none',
      state.workerRunning ? 'working' : 'idle-worker',
      state.pendingQueue.length,
      state.sessionTargets.length,
      countBatchStatus(state, BATCH_ITEM_SUCCESS),
      countBatchStatus(state, BATCH_ITEM_FAILED),
      state.sessionBlockedReason ? 'blocked' : 'open'
    ].join(':');
    if (controls.getAttribute('data-cgpt-batch-render-signature') === signature) {
      return;
    }
    controls.setAttribute(
      'data-cgpt-batch-render-signature',
      signature
    );
    controls.setAttribute(
      'data-cgpt-batch-mode',
      state.phase
    );
    if (scope === BATCH_SCOPE_GENERAL) {
      renderGeneralBatchControls(
        controls,
        context,
        state
      );
    } else {
      renderProjectBatchControls(
        controls,
        context,
        state
      );
    }
  }
  function renderBatchControls() {
    const general = findGeneralBatchUiContext();
    if (general) {
      renderBatchControlsForScope(BATCH_SCOPE_GENERAL, general);
    } else {
      removeBatchControlsIfContextMissing(BATCH_SCOPE_GENERAL);
    }
    const project = findProjectBatchUiContext();
    if (project) {
      renderBatchControlsForScope(BATCH_SCOPE_PROJECT, project);
    } else {
      removeBatchControlsIfContextMissing(BATCH_SCOPE_PROJECT);
    }
    syncBatchBeforeUnloadGuard();
  }
  function resetBatchDraftSelection(state) {
    state.selectedConversations.clear();
    state.manuallyExcludedIds.clear();
    state.selectAllMode = false;
    state.closingMode = false;
    state.rangeAnchorConversationId = null;
    state.selectionOrder = 0;
  }
  function resetBatchSessionState(state, { preserveLastResults = true } = {}) {
    state.exportKind = null;
    state.sessionStartedAt = null;
    state.sessionUpdatedAt = null;
    state.sessionBlockedReason = '';
    state.sessionTargets = [];
    state.sessionConversationIds.clear();
    state.pendingQueue = [];
    state.workerRunning = false;
    state.currentConversationId = null;
    state.itemRuntime.clear();
    state.completedPayloads.clear();
    state.sessionResults.clear();
    state.removedWhileProcessingIds.clear();
    state.zipFilename = null;
    if (!preserveLastResults) {
      state.lastBatchResults = null;
    }
  }
  function findBatchScrollableAncestor(element) {
    let node = element?.parentElement || null;
    while (
      node &&
      node !== document.body &&
      node !== document.documentElement
    ) {
      try {
        const style = getComputedStyle(node);
        const overflowY = style.overflowY;
        const isScrollable =
          /^(auto|scroll|overlay)$/.test(overflowY) &&
          node.scrollHeight > node.clientHeight + 1;
        if (isScrollable) {
          return node;
        }
      } catch {
        // 繼續往上尋找可捲動祖先。
      }
      node = node.parentElement;
    }
    return null;
  }
  /*
   * 量測側邊欄 scroll container 頂端實際被 sticky / fixed UI 覆蓋的高度。
   *
   * ChatGPT 目前的側邊欄頂部包含 Logo / 搜尋 / 新對話等固定區塊；
   * 單純把「聊天」header 對齊 scroll container.top，會讓它捲到這些 UI 下方。
   *
   * 不依賴 build class 或固定像素高度，而是在 sidebar 的實際 x 範圍內
   * 掃描頂部一小段畫面，尋找 position: sticky / fixed 的 rendered element，
   * 以最下方的遮蔽邊界作為 scroll offset。
   */
  function measureBatchSidebarTopOcclusion(
    scrollContainer,
    referenceElement
  ) {
    if (
      !scrollContainer ||
      !referenceElement ||
      !scrollContainer.isConnected ||
      !referenceElement.isConnected
    ) {
      return 0;
    }
    const containerRect =
      scrollContainer.getBoundingClientRect();
    const referenceRect =
      referenceElement.getBoundingClientRect();
    if (
      containerRect.width <= 0 ||
      containerRect.height <= 0
    ) {
      return 0;
    }
    const probeX = Math.min(
      containerRect.right - 2,
      Math.max(
        containerRect.left + 2,
        referenceRect.left +
        Math.min(
          Math.max(referenceRect.width * 0.5, 24),
          80
        )
      )
    );
    const scanTop = containerRect.top + 1;
    const scanBottom = Math.min(
      containerRect.bottom - 1,
      scanTop + Math.min(280, containerRect.height * 0.5)
    );
    let occlusionBottom = containerRect.top;
    for (
      let probeY = scanTop;
      probeY <= scanBottom;
      probeY += 8
    ) {
      const elements =
        typeof document.elementsFromPoint === 'function'
          ? document.elementsFromPoint(probeX, probeY)
          : [];
      for (const element of elements) {
        if (
          !(element instanceof Element) ||
          element === scrollContainer ||
          element === referenceElement ||
          referenceElement.contains(element)
        ) {
          continue;
        }
        let style;
        try {
          style = getComputedStyle(element);
        } catch {
          continue;
        }
        if (
          style.position !== 'sticky' &&
          style.position !== 'fixed'
        ) {
          continue;
        }
        const rect = element.getBoundingClientRect();
        const overlapsContainerHorizontally =
          rect.right > containerRect.left + 1 &&
          rect.left < containerRect.right - 1;
        const overlapsContainerTopArea =
          rect.bottom > containerRect.top &&
          rect.top < scanBottom;
        if (
          !overlapsContainerHorizontally ||
          !overlapsContainerTopArea ||
          rect.width <= 0 ||
          rect.height <= 0
        ) {
          continue;
        }
        occlusionBottom = Math.max(
          occlusionBottom,
          Math.min(rect.bottom, containerRect.bottom)
        );
      }
    }
    /*
     * 額外保留 8px，避免剛好貼住 sticky 區塊下緣。
     */
    const measuredOffset = Math.max(
      0,
      occlusionBottom - containerRect.top
    );
    return measuredOffset > 0
      ? measuredOffset + 8
      : 0;
  }
  function scrollGeneralBatchSectionToTop(context) {
    if (
      context?.scope !== BATCH_SCOPE_GENERAL ||
      !context.header ||
      !context.header.isConnected
    ) {
      return;
    }
    const reducedMotion = window.matchMedia?.(
      '(prefers-reduced-motion: reduce)'
    ).matches;
    /*
     * 連續兩個 rAF：
     * 第一個讓批次面板完成插入；
     * 第二個再量 sticky 區域與最終幾何，避免使用插入前的位置。
     */
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        if (!context.header.isConnected) {
          return;
        }
        const scrollContainer =
          findBatchScrollableAncestor(context.header);
        if (scrollContainer) {
          const headerRect =
            context.header.getBoundingClientRect();
          const containerRect =
            scrollContainer.getBoundingClientRect();
          const topOcclusion =
            measureBatchSidebarTopOcclusion(
              scrollContainer,
              context.header
            );
          const targetTop = Math.max(
            0,
            scrollContainer.scrollTop +
            headerRect.top -
            containerRect.top -
            topOcclusion
          );
          try {
            scrollContainer.scrollTo({
              top: targetTop,
              behavior: reducedMotion
                ? 'auto'
                : 'smooth'
            });
          } catch {
            scrollContainer.scrollTop = targetTop;
          }
          return;
        }
        /*
         * 找不到明確 scroll container 時退回 scrollIntoView。
         * 此 fallback 不自行猜固定 header 高度。
         */
        try {
          context.header.scrollIntoView({
            block: 'start',
            inline: 'nearest',
            behavior: reducedMotion
              ? 'auto'
              : 'smooth'
          });
        } catch {
          context.header.scrollIntoView(true);
        }
      });
    });
  }
  function beginBatchSelectionMode(scope) {
    const state = getBatchSelectionState(scope);
    if (!state || state.phase !== BATCH_PHASE_IDLE) {
      return;
    }
    finalizeBatchConversationRowDecorations(scope);
    const context = getBatchUiContext(scope);
    if (!context?.listRoot || !context.active) {
      alert(
        scope === BATCH_SCOPE_PROJECT
          ? '目前無法進入批次選擇模式。請先切換到此專案的「聊天」分頁。'
          : '目前找不到可選取的一般聊天列表。請確認側邊欄「聊天」區塊已顯示。'
      );
      return;
    }
    resetBatchDraftSelection(state);
    resetBatchSessionState(state);
    state.phase = BATCH_PHASE_SELECTING;
    state.routePathname = location.pathname;
    bindBatchSelectionList(context);
    renderBatchControls();
    if (scope === BATCH_SCOPE_GENERAL) {
      scrollGeneralBatchSectionToTop(context);
    }
  }
  function finalizeCloseBatchSelectionMode(
    scope,
    { silent = false } = {}
  ) {
    const state = getBatchSelectionState(scope);
    if (!state || hasActiveBatchSession(state)) {
      return;
    }
    removeBatchConfirmationDialog();
    detachBatchSelectionListBinding(scope);
    clearBatchConversationRowDecorations(scope);
    resetBatchDraftSelection(state);
    resetBatchSessionState(state);
    state.phase = BATCH_PHASE_IDLE;
    state.routePathname = null;
    state.closingMode = false;
    const controls = document.getElementById(
      scope === BATCH_SCOPE_GENERAL
        ? BATCH_GENERAL_CONTROLS_ID
        : BATCH_PROJECT_CONTROLS_ID
    );
    if (controls) {
      clearBatchMotionLifecycle(controls);
      controls.removeAttribute(
        'data-cgpt-motion-state'
      );
      controls.removeAttribute('inert');
      controls.removeAttribute('aria-hidden');
    }
    renderBatchControls();
    if (!silent) {
      logInfo(
        `已關閉 ${scope === BATCH_SCOPE_PROJECT
          ? '專案'
          : '一般聊天'
        }批次模式。`
      );
    }
  }
  function closeBatchSelectionMode(
    scope,
    { silent = false } = {}
  ) {
    const state = getBatchSelectionState(scope);
    if (
      !state ||
      state.phase === BATCH_PHASE_IDLE ||
      hasActiveBatchSession(state) ||
      state.closingMode
    ) {
      return;
    }
    const controls = document.getElementById(
      scope === BATCH_SCOPE_GENERAL
        ? BATCH_GENERAL_CONTROLS_ID
        : BATCH_PROJECT_CONTROLS_ID
    );
    if (!controls) {
      finalizeCloseBatchSelectionMode(
        scope,
        { silent }
      );
      return;
    }
    state.closingMode = true;
    transitionBatchMotionState(
      controls,
      false,
      {
        transitionElement: controls,
        transitionProperty:
          scope === BATCH_SCOPE_GENERAL
            ? 'max-height'
            : 'max-width',
        onSettled: () => {
          finalizeCloseBatchSelectionMode(
            scope,
            { silent }
          );
        }
      }
    );
  }
  function cancelBatchSelectionMode(scope, options = {}) {
    closeBatchSelectionMode(scope, options);
  }
  function clearCurrentBatchSelection(scope) {
    const state = getBatchSelectionState(scope);
    if (!state || !isBatchSelectionEditableState(state)) {
      return;
    }
    resetBatchDraftSelection(state);
    syncBatchConversationRows(scope);
    renderBatchControls();
  }
  function selectAllBatchConversations(scope) {
    const state = getBatchSelectionState(scope);
    if (!state || !isBatchSelectionEditableState(state)) {
      return;
    }
    state.selectAllMode = true;
    state.manuallyExcludedIds.clear();
    syncBatchConversationRows(scope, { autoSelectNew: true });
  }
  function removeBatchDialogImmediatelyById(id) {
    const element = document.getElementById(id);
    if (!element) {
      return;
    }
    clearBatchMotionLifecycle(element);
    element.remove();
  }
  function removeBatchConfirmationDialog() {
    removeBatchDialogImmediatelyById(
      BATCH_DIALOG_ID
    );
  }
  function removeCancelBatchJobDialog() {
    removeBatchDialogImmediatelyById(
      BATCH_CANCEL_JOB_DIALOG_ID
    );
  }
  function ensureBatchSelectionBinding(scope) {
    const state = getBatchSelectionState(scope);
    if (!state || !isBatchListLockedPhase(state.phase)) {
      return;
    }
    const context = getBatchUiContext(scope);
    if (!context?.listRoot) {
      return;
    }
    if (!context.active && !hasActiveBatchSession(state)) {
      closeBatchSelectionMode(scope, { silent: true });
      return;
    }
    bindBatchSelectionList(context);
  }
  function ensureAllBatchSelectionBindings() {
    ensureBatchSelectionBinding(BATCH_SCOPE_GENERAL);
    ensureBatchSelectionBinding(BATCH_SCOPE_PROJECT);
  }
  function getBatchSelectionSnapshot(scope) {
    const state = getBatchSelectionState(scope);
    if (!state) {
      return [];
    }
    return Array.from(state.selectedConversations.values())
      .sort((a, b) => a.selectionOrder - b.selectionOrder)
      .map((item) => ({
        conversationId: item.conversationId,
        title: item.title,
        hrefPath: item.hrefPath
      }));
  }
  function freezeBatchTargets(snapshot) {
    return Object.freeze(
      snapshot.map((item) =>
        Object.freeze({
          conversationId: item.conversationId,
          title: item.title,
          hrefPath: item.hrefPath
        })
      )
    );
  }
  function clampBatchProgress(value) {
    return Math.min(1, Math.max(0, Number(value) || 0));
  }
  function updateBatchItemRuntime(scope, conversationId, patch, { renderControls = false } = {}) {
    const state = getBatchSelectionState(scope);
    if (!state) {
      return;
    }
    const current = state.itemRuntime.get(conversationId) || {
      status: BATCH_ITEM_PENDING,
      stage: 'pending',
      progress: 0,
      progressMode: 'indeterminate',
      error: null
    };
    const next = { ...current, ...patch };
    next.progress = clampBatchProgress(next.progress);
    state.itemRuntime.set(conversationId, next);
    syncSingleBatchConversationRow(scope, conversationId);
    if (renderControls) {
      renderBatchControls();
    }
  }
  function createBatchTransferProgressHandler(scope, conversationId, start, end, stage) {
    const span = Math.max(0, end - start);
    return ({ loaded, total, lengthComputable }) => {
      const state = getBatchSelectionState(scope);
      const current = state?.itemRuntime.get(conversationId);
      if (
        !state ||
        !hasActiveBatchSession(state) ||
        !current ||
        current.status !== BATCH_ITEM_EXPORTING
      ) {
        return;
      }
      if (lengthComputable && total > 0) {
        const ratio = Math.min(1, Math.max(0, loaded / total));
        updateBatchItemRuntime(scope, conversationId, {
          stage,
          progress: start + span * ratio,
          progressMode: 'determinate'
        });
      } else {
        updateBatchItemRuntime(scope, conversationId, {
          stage,
          progress: Math.max(current.progress || 0, start),
          progressMode: 'indeterminate'
        });
      }
    };
  }
  function applyBatchExportStage(scope, conversationId, stage) {
    const stages = {
      'conversation-start': BATCH_PROGRESS_CONVERSATION_START,
      'conversation-ready': BATCH_PROGRESS_CONVERSATION_END,
      'textdocs-start': BATCH_PROGRESS_TEXTDOCS_START,
      'textdocs-ready': BATCH_PROGRESS_TEXTDOCS_END,
      'raw-build': BATCH_PROGRESS_HANDOFF_BUILD,
      'raw-ready': BATCH_PROGRESS_HANDOFF_READY,
      'handoff-build': BATCH_PROGRESS_HANDOFF_BUILD,
      'handoff-ready': BATCH_PROGRESS_HANDOFF_READY,
      'complete-ready': BATCH_PROGRESS_HANDOFF_READY
    };
    const progress = stages[stage];
    if (!Number.isFinite(progress)) {
      return;
    }
    updateBatchItemRuntime(scope, conversationId, {
      stage,
      progress,
      progressMode: 'indeterminate'
    });
  }
  function summarizeBatchError(error) {
    const message = toErrorMessage(error).replace(/\s+/g, ' ').trim();
    return message.length <= 700 ? message : `${message.slice(0, 697)}…`;
  }
  function isSystemicBatchFailure(error) {
    const message = toErrorMessage(error);
    return (
      /\bHTTP\s+(401|403)\b/i.test(message) ||
      /無法取得[^。]*request context/i.test(message) ||
      /缺少[^。]*request context/i.test(message) ||
      /目前無法取得此對話的[^。]*請求資訊/i.test(message)
    );
  }
  function releaseBatchConversationLargeData(conversationId) {
    capturedRawByConversationId.delete(conversationId);
  }
  function buildBatchZipFilename(scope, exportKind, timestamp) {
    const scopeLabel = scope === BATCH_SCOPE_PROJECT ? '專案聊天' : '一般聊天';
    const kindLabel = exportKind === BATCH_EXPORT_RAW
      ? '原始JSON'
      : exportKind === BATCH_EXPORT_HANDOFF
        ? '交接JSON'
        : '完整JSON';
    return `ChatGPT-${scopeLabel}-批次${kindLabel}-${timestamp}.zip`;
  }
  function buildBatchManifest({ scope, exportKind, startedAt, finishedAt, zipFilename, results }) {
    const success = results.filter((x) => x.status === BATCH_ITEM_SUCCESS).length;
    const failed = results.filter((x) => x.status === BATCH_ITEM_FAILED).length;
    const skipped = results.filter((x) => x.status === BATCH_ITEM_SKIPPED).length;
    return JSON.stringify({
      schema_version: 1,
      export_type: exportKind,
      scope,
      generated_at: new Date(finishedAt).toISOString(),
      started_at: new Date(startedAt).toISOString(),
      finished_at: new Date(finishedAt).toISOString(),
      zip: {
        filename: zipFilename,
        format: 'zip',
        compression: 'store',
        compression_method: 0
      },
      total: results.length,
      success,
      failed,
      skipped,
      items: results.map((item) => ({
        conversation_id: item.conversationId,
        title: item.title,
        href_path: item.hrefPath,
        status: item.status,
        files: (item.files || []).map((file) => ({
          kind: file.kind,
          filename: file.filename,
          bytes: file.bytes
        })),
        textdoc_count: Number.isInteger(item.textdocCount) ? item.textdocCount : null,
        error: item.error || null
      }))
    }, null, 4);
  }
  function createStoredPayloadFile(kind, payload, folder = null) {
    return {
      kind,
      folder,
      filename: payload.filename,
      text: payload.text,
      bytes: getUtf8ByteLength(payload.text),
      modifiedAt:
        payload.modifiedAt instanceof Date && Number.isFinite(payload.modifiedAt.getTime())
          ? payload.modifiedAt
          : null,
      createdAt:
        payload.createdAt instanceof Date && Number.isFinite(payload.createdAt.getTime())
          ? payload.createdAt
          : null
    };
  }
  function clearCommittedDraftTargets(state, targets) {
    for (const target of targets) {
      state.selectedConversations.delete(target.conversationId);
      state.manuallyExcludedIds.delete(target.conversationId);
    }
    state.rangeAnchorConversationId = null;
  }
  function commitTargetsToBatchSession(scope, exportKind, targets) {
    const state = getBatchSelectionState(scope);
    if (
      !state ||
      targets.length === 0 ||
      ![BATCH_EXPORT_RAW, BATCH_EXPORT_HANDOFF, BATCH_EXPORT_COMPLETE].includes(exportKind)
    ) {
      return false;
    }
    if (!hasActiveBatchSession(state)) {
      state.exportKind = exportKind;
      state.sessionStartedAt = Date.now();
      state.sessionUpdatedAt = state.sessionStartedAt;
      state.sessionBlockedReason = '';
      state.zipFilename = buildBatchZipFilename(
        scope,
        exportKind,
        getTimestampString(new Date(state.sessionStartedAt))
      );
    } else if (state.exportKind !== exportKind) {
      return false;
    }
    const added = [];
    for (const target of targets) {
      if (state.sessionConversationIds.has(target.conversationId)) {
        continue;
      }
      state.sessionConversationIds.add(target.conversationId);
      state.sessionTargets.push(target);
      state.pendingQueue.push(target);
      state.itemRuntime.set(target.conversationId, {
        status: BATCH_ITEM_PENDING,
        stage: 'pending',
        progress: 0,
        progressMode: 'indeterminate',
        error: null
      });
      added.push(target);
    }
    if (added.length === 0) {
      return false;
    }
    clearCommittedDraftTargets(state, added);
    state.phase = BATCH_PHASE_SESSION;
    state.sessionUpdatedAt = Date.now();
    const context = getBatchUiContext(scope);
    if (context?.listRoot) {
      bindBatchSelectionList(context);
    }
    syncBatchConversationRows(scope);
    renderBatchControls();
    ensureBatchSessionWorker(scope);
    return true;
  }
  function storeSuccessfulBatchPayload(state, target, buildResult) {
    const files = [];
    if (state.exportKind === BATCH_EXPORT_RAW) {
      files.push(createStoredPayloadFile('conversation', buildResult.rawPayload));
      if (buildResult.textdocsPayload) {
        files.push(createStoredPayloadFile('textdocs', buildResult.textdocsPayload));
      }
    } else if (state.exportKind === BATCH_EXPORT_HANDOFF) {
      files.push(createStoredPayloadFile('handoff', buildResult.handoffPayload));
    } else {
      files.push(createStoredPayloadFile('conversation', buildResult.rawPayload, '原始JSON'));
      if (buildResult.textdocsPayload) {
        files.push(createStoredPayloadFile('textdocs', buildResult.textdocsPayload, '原始JSON'));
      }
      files.push(createStoredPayloadFile('handoff', buildResult.handoffPayload, '交接JSON'));
    }
    state.completedPayloads.set(target.conversationId, { files });
    state.sessionResults.set(target.conversationId, {
      conversationId: target.conversationId,
      title: target.title,
      hrefPath: target.hrefPath,
      status: BATCH_ITEM_SUCCESS,
      files: files.map((file) => ({
        kind: file.kind,
        filename: file.folder ? `${file.folder}/${file.filename}` : file.filename,
        bytes: file.bytes
      })),
      textdocCount: buildResult.textdocCount,
      transport: buildResult.transport || null,
      error: null
    });
  }
  function markRemainingQueueSkipped(state, reason) {
    for (const target of state.pendingQueue.splice(0)) {
      updateBatchItemRuntime(state.scope, target.conversationId, {
        status: BATCH_ITEM_SKIPPED,
        stage: 'skipped',
        progress: 0,
        progressMode: 'indeterminate',
        error: reason
      });
      state.sessionResults.set(target.conversationId, {
        conversationId: target.conversationId,
        title: target.title,
        hrefPath: target.hrefPath,
        status: BATCH_ITEM_SKIPPED,
        files: [],
        textdocCount: null,
        transport: null,
        error: reason
      });
    }
  }
  function getNextBatchRequestScope() {
    const scopes = [BATCH_SCOPE_GENERAL, BATCH_SCOPE_PROJECT];
    const startIndex = batchRequestSchedulerLastScope === BATCH_SCOPE_GENERAL
      ? 1
      : 0;
    for (let offset = 0; offset < scopes.length; offset += 1) {
      const scope = scopes[(startIndex + offset) % scopes.length];
      const state = getBatchSelectionState(scope);
      if (
        state &&
        hasActiveBatchSession(state) &&
        state.phase !== BATCH_PHASE_PACKAGING &&
        !state.workerRunning &&
        !state.sessionBlockedReason &&
        state.pendingQueue.length > 0
      ) {
        return scope;
      }
    }
    return null;
  }
  function hasPendingBatchRequestWork() {
    return [BATCH_SCOPE_GENERAL, BATCH_SCOPE_PROJECT].some((scope) => {
      const state = getBatchSelectionState(scope);
      return Boolean(
        state &&
        hasActiveBatchSession(state) &&
        state.phase !== BATCH_PHASE_PACKAGING &&
        !state.sessionBlockedReason &&
        state.pendingQueue.length > 0
      );
    });
  }
  async function processSingleBatchSessionTarget(scope) {
    const state = getBatchSelectionState(scope);
    if (
      !state ||
      !hasActiveBatchSession(state) ||
      state.workerRunning ||
      state.pendingQueue.length === 0 ||
      state.sessionBlockedReason
    ) {
      return;
    }
    const target = state.pendingQueue.shift();
    if (!target) return;
    state.workerRunning = true;
    state.currentConversationId = target.conversationId;
    state.phase = BATCH_PHASE_SESSION;
    updateBatchItemRuntime(scope, target.conversationId, {
      status: BATCH_ITEM_EXPORTING,
      stage: 'prepare',
      progress: 0.01,
      progressMode: 'indeterminate',
      error: null
    }, { renderControls: true });
    try {
      const options = {
        onStage(stage) {
          applyBatchExportStage(scope, target.conversationId, stage);
        },
        onConversationProgress: createBatchTransferProgressHandler(
          scope,
          target.conversationId,
          BATCH_PROGRESS_CONVERSATION_START,
          BATCH_PROGRESS_CONVERSATION_END,
          'conversation-transfer'
        ),
        onTextdocsProgress: createBatchTransferProgressHandler(
          scope,
          target.conversationId,
          BATCH_PROGRESS_TEXTDOCS_START,
          BATCH_PROGRESS_TEXTDOCS_END,
          'textdocs-transfer'
        )
      };
      const buildResult = state.exportKind === BATCH_EXPORT_RAW
        ? await createRawPayloadForConversationId(target.conversationId, options)
        : state.exportKind === BATCH_EXPORT_HANDOFF
          ? await createHandoffPayloadForConversationId(
            target.conversationId,
            { enforceCurrentPage: false, ...options }
          )
          : await createCompletePayloadForConversationId(target.conversationId, options);
      if (!state.removedWhileProcessingIds.has(target.conversationId)) {
        storeSuccessfulBatchPayload(state, target, buildResult);
        updateBatchItemRuntime(scope, target.conversationId, {
          status: BATCH_ITEM_SUCCESS,
          stage: 'complete',
          progress: 1,
          progressMode: 'determinate',
          error: null
        });
      }
    } catch (error) {
      const errorMessage = summarizeBatchError(error);
      const removed = state.removedWhileProcessingIds.has(target.conversationId);
      if (!removed) {
        updateBatchItemRuntime(scope, target.conversationId, {
          status: BATCH_ITEM_FAILED,
          stage: 'failed',
          progress: state.itemRuntime.get(target.conversationId)?.progress || 0,
          progressMode: 'indeterminate',
          error: errorMessage
        });
        state.sessionResults.set(target.conversationId, {
          conversationId: target.conversationId,
          title: target.title,
          hrefPath: target.hrefPath,
          status: BATCH_ITEM_FAILED,
          files: [],
          textdocCount: null,
          transport: null,
          error: errorMessage
        });
      }
      if (isSystemicBatchFailure(error)) {
        state.sessionBlockedReason = errorMessage;
        resetBatchDraftSelection(state);
        markRemainingQueueSkipped(
          state,
          '因此批次的 request context / 驗證狀態失效而未處理。'
        );
      }
    } finally {
      releaseBatchConversationLargeData(target.conversationId);
      if (state.removedWhileProcessingIds.delete(target.conversationId)) {
        state.itemRuntime.delete(target.conversationId);
        state.completedPayloads.delete(target.conversationId);
        state.sessionResults.delete(target.conversationId);
      }
      state.workerRunning = false;
      state.currentConversationId = null;
      state.sessionUpdatedAt = Date.now();
      syncSingleBatchConversationRow(scope, target.conversationId);
      renderBatchControls();
    }
  }
  async function runBatchRequestScheduler() {
    if (batchRequestSchedulerRunning) return;
    batchRequestSchedulerRunning = true;
    try {
      while (true) {
        const scope = getNextBatchRequestScope();
        if (!scope) break;
        batchRequestSchedulerLastScope = scope;
        await processSingleBatchSessionTarget(scope);
      }
    } finally {
      batchRequestSchedulerRunning = false;
      renderBatchControls();
      if (hasPendingBatchRequestWork()) {
        window.queueMicrotask(() => ensureBatchSessionWorker());
      }
    }
  }
  function ensureBatchSessionWorker() {
    if (batchRequestSchedulerRunning || !hasPendingBatchRequestWork()) {
      return;
    }
    void runBatchRequestScheduler();
  }
  function buildBatchCompletionSummary(state, results, zipFilename, zipBytes) {
    const success = results.filter((x) => x.status === BATCH_ITEM_SUCCESS).length;
    const failed = results.filter((x) => x.status === BATCH_ITEM_FAILED).length;
    const skipped = results.filter((x) => x.status === BATCH_ITEM_SKIPPED).length;
    return [
      '批次打包完成。',
      '',
      `類型：${getBatchExportKindLabel(state.exportKind)}`,
      `成功：${success}`,
      `失敗：${failed}`,
      `未處理：${skipped}`,
      '',
      `ZIP：${zipFilename}`,
      `ZIP 大小：${zipBytes.toLocaleString()} bytes`,
      '壓縮方式：STORE（不壓縮）'
    ].join('\n');
  }
  function cleanupPackagedBatchSession(scope, lastBatchResults) {
    const state = getBatchSelectionState(scope);
    if (!state) {
      return;
    }
    detachBatchSelectionListBinding(scope);
    clearBatchConversationRowDecorations(scope);
    removeBatchConfirmationDialog();
    removeCancelBatchJobDialog();
    resetBatchDraftSelection(state);
    resetBatchSessionState(state, { preserveLastResults: true });
    state.lastBatchResults = lastBatchResults;
    state.phase = BATCH_PHASE_IDLE;
    state.routePathname = null;
    renderBatchControls();
  }
  async function packageBatchSession(scope) {
    const state = getBatchSelectionState(scope);
    if (!state || !canPackageBatchSession(state)) {
      return;
    }
    state.phase = BATCH_PHASE_PACKAGING;
    renderBatchControls();
    try {
      const zipBuilder = createStoredZipBuilder();
      for (const target of state.sessionTargets) {
        const result = state.sessionResults.get(target.conversationId);
        if (!result || result.status !== BATCH_ITEM_SUCCESS) {
          continue;
        }
        const payload = state.completedPayloads.get(target.conversationId);
        if (!payload) {
          throw new Error(
            `打包失敗：缺少已完成對話 ${target.conversationId} 的記憶體 payload。`
          );
        }
        const checkpoint = zipBuilder.createCheckpoint();
        try {
          const actualFiles = [];
          for (const file of payload.files) {
            const zipFile = file.folder
              ? zipBuilder.addTextFileInFolder(
                file.folder,
                file.filename,
                file.text,
                file.modifiedAt || new Date(),
                file.createdAt || file.modifiedAt || new Date()
              )
              : zipBuilder.addTextFile(
                file.filename,
                file.text,
                file.modifiedAt || new Date(),
                file.createdAt || file.modifiedAt || new Date()
              );
            actualFiles.push({
              kind: file.kind,
              filename: zipFile.filename,
              bytes: zipFile.bytes
            });
          }
          result.files = actualFiles;
        } catch (error) {
          zipBuilder.rollback(checkpoint);
          throw error;
        }
      }
      const finishedAt = Date.now();
      const results = getBatchSessionResultArray(state);
      const manifestText = buildBatchManifest({
        scope,
        exportKind: state.exportKind,
        startedAt: state.sessionStartedAt,
        finishedAt,
        zipFilename: state.zipFilename,
        results
      });
      zipBuilder.addTextFile('batch-manifest.json', manifestText, new Date(finishedAt));
      const zipBlob = zipBuilder.finalize();
      const zipBytes = zipBlob.size;
      downloadBlobFile(zipBlob, state.zipFilename);
      const lastBatchResults = Object.freeze({
        scope,
        exportKind: state.exportKind,
        zipFilename: state.zipFilename,
        zipBytes,
        startedAt: state.sessionStartedAt,
        finishedAt,
        total: state.sessionTargets.length,
        results: Object.freeze(
          results.map((item) =>
            Object.freeze({
              ...item,
              files: Object.freeze(
                (item.files || []).map((file) => Object.freeze({ ...file }))
              )
            })
          )
        )
      });
      const summary = buildBatchCompletionSummary(
        state,
        results,
        state.zipFilename,
        zipBytes
      );
      await new Promise((resolve) => {
        window.requestAnimationFrame(() => window.requestAnimationFrame(resolve));
      });
      alert(summary);
      cleanupPackagedBatchSession(scope, lastBatchResults);
    } catch (error) {
      state.phase = BATCH_PHASE_SESSION;
      renderBatchControls();
      alert(
        '批次打包失敗。\n\n' +
        `${summarizeBatchError(error)}\n\n` +
        '目前 session 與已取得資料仍保留在頁面記憶體中；' +
        '你可以再次嘗試打包，或使用「取消批次下載作業」重新整理頁面。'
      );
    }
  }
  function createBatchDialogShell({ id, titleText, testId }) {
    const overlay = document.createElement('div');
    overlay.id = id;
    overlay.setAttribute('data-ignore-for-page-load', 'true');
    if (testId) {
      overlay.setAttribute('data-testid', testId);
    }
    overlay.className = 'absolute inset-0';
    overlay.setAttribute(
      'data-cgpt-batch-dialog-shell',
      'true'
    );
    setBatchMotionStateImmediately(
      overlay,
      false
    );
    const backdrop = document.createElement('div');
    backdrop.setAttribute('data-state', 'open');
    backdrop.setAttribute(
      'data-cgpt-batch-dialog-backdrop',
      'true'
    );
    backdrop.className =
      'fixed inset-0 z-50 before:absolute before:inset-0 before:bg-gray-200/50 before:backdrop-blur-[1px] dark:before:bg-black/50';
    const grid = document.createElement('div');
    grid.className =
      'z-50 h-full w-full overflow-y-auto keyboard-open:h-[calc(100%-var(--screen-keyboard-height,0px))] grid grid-cols-[10px_1fr_10px] grid-rows-[minmax(10px,1fr)_auto_minmax(10px,1fr)] md:grid-rows-[minmax(20px,0.8fr)_auto_minmax(20px,1fr)]';
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('data-state', 'open');
    dialog.setAttribute(
      'data-cgpt-batch-dialog-surface',
      'true'
    );
    dialog.className =
      'popover bg-token-bg-primary relative col-auto col-start-2 row-auto row-start-2 h-full text-start start-1/2 ltr:-translate-x-1/2 rtl:translate-x-1/2 rounded-2xl shadow-long flex flex-col focus:outline-hidden overflow-hidden';
    dialog.style.width = 'max(40vw, 36rem)';
    dialog.style.minWidth = '40vw';
    dialog.style.maxWidth = 'calc(100vw - 2rem)';
    dialog.tabIndex = -1;
    const titleId = `${id}-title`;
    dialog.setAttribute('aria-labelledby', titleId);
    const header = document.createElement('header');
    header.className = 'min-h-header-height flex justify-between p-2.5 ps-4 select-none';
    header.innerHTML = `
      <div class="flex max-w-full items-center">
        <div class="flex max-w-full min-w-0 grow flex-col">
          <h2 id="${titleId}" class="text-token-text-primary text-lg font-normal"></h2>
        </div>
      </div>
      <div class="flex h-[max-content] items-center gap-2"></div>
    `;
    header.querySelector('h2').textContent = titleText;
    const body = document.createElement('div');
    body.className = 'grow overflow-y-auto p-4 pt-1';
    dialog.append(header, body);
    grid.append(dialog);
    backdrop.append(grid);
    overlay.append(backdrop);
    document.body.append(overlay);
    const shell = {
      overlay,
      backdrop,
      dialog,
      body,
      closing: false
    };
    transitionBatchMotionState(
      overlay,
      true,
      {
        transitionElement: dialog,
        transitionProperty: 'opacity',
        onSettled: () => {
          if (dialog.isConnected) {
            dialog.focus();
          }
        }
      }
    );
    return shell;
  }
  function closeBatchDialogShell(
    shell,
    onClosed = null
  ) {
    if (
      !shell?.overlay ||
      shell.closing
    ) {
      return;
    }
    shell.closing = true;
    transitionBatchMotionState(
      shell.overlay,
      false,
      {
        transitionElement: shell.dialog,
        transitionProperty: 'opacity',
        onSettled: () => {
          clearBatchMotionLifecycle(
            shell.overlay
          );
          shell.overlay.remove();
          if (typeof onClosed === 'function') {
            onClosed();
          }
        }
      }
    );
  }
  function createBatchDialogButton(
    label,
    { primary = false, white = false, danger = false, iconSvg = '' } = {}
  ) {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('data-cgpt-batch-dialog-button', 'true');
    button.className = [
      'btn',
      'relative',
      'group-focus-within/dialog:focus-visible:[outline-width:1.5px]',
      'group-focus-within/dialog:focus-visible:[outline-offset:2.5px]',
      'group-focus-within/dialog:focus-visible:[outline-style:solid]',
      'group-focus-within/dialog:focus-visible:[outline-color:var(--text-primary)]',
      primary ? 'btn-primary' : 'btn-secondary'
    ].join(' ');
    if (white) {
      button.setAttribute('data-cgpt-batch-dialog-download', 'true');
    }
    if (danger) {
      button.setAttribute('data-cgpt-batch-dialog-danger', 'true');
    }
    button.innerHTML =
      `<div class="flex items-center justify-center gap-2">${iconSvg}<span>${label}</span></div>`;
    return button;
  }
  function showBatchConfirmationDialog(scope) {
    const state = getBatchSelectionState(scope);
    if (!state || !isBatchSelectionEditableState(state)) {
      return;
    }
    const snapshot = getBatchSelectionSnapshot(scope);
    if (snapshot.length === 0) {
      alert('尚未選取任何對話。');
      return;
    }
    const sessionActive = hasActiveBatchSession(state);
    state.phase = BATCH_PHASE_CONFIRMING;
    renderBatchControls();
    removeBatchConfirmationDialog();
    const shell = createBatchDialogShell({
      id: BATCH_DIALOG_ID,
      titleText: sessionActive ? '確認追加批次匯出' : '確認批次匯出',
      testId: 'modal-cgpt-batch-export-confirmation'
    });
    shell.dialog.style.width = 'max(50vw, 36rem)';
    shell.dialog.style.minWidth = '50vw';
    shell.overlay.setAttribute('data-cgpt-batch-export-dialog', 'true');
    const intro = document.createElement('p');
    intro.className = 'text-token-text-primary';
    intro.textContent = sessionActive
      ? `準備追加 ${snapshot.length} 個對話：`
      : `已選取 ${snapshot.length} 個對話：`;
    const list = document.createElement('ol');
    list.setAttribute('data-cgpt-batch-dialog-list', 'true');
    list.className = 'mt-3 list-decimal space-y-2 ps-6 text-sm';
    for (const item of snapshot) {
      const listItem = document.createElement('li');
      listItem.className = 'text-token-text-primary';
      const link = document.createElement('a');
      link.href = new URL(item.hrefPath, location.origin).href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.className =
        'text-token-text-primary underline decoration-token-text-tertiary underline-offset-2 hover:text-token-text-secondary';
      link.textContent = item.title || item.conversationId;
      link.setAttribute(
        'aria-label',
        `在新分頁開啟對話：${item.title || item.conversationId}`
      );
      listItem.append(link);
      list.append(listItem);
    }
    const actions = document.createElement('div');
    actions.className =
      'mt-5 flex w-full items-center justify-between gap-4 text-sm select-none sm:mt-4';
    const cancelButton = createBatchDialogButton('取消');
    const rightActions = document.createElement('div');
    rightActions.className = 'flex flex-wrap items-center justify-end gap-3';
    const resumePhase = sessionActive ? BATCH_PHASE_SESSION : BATCH_PHASE_SELECTING;
    const closeDialog = ({ resumeSelection = true } = {}) => {
      closeBatchDialogShell(
        shell,
        () => {
          if (
            resumeSelection &&
            state.phase === BATCH_PHASE_CONFIRMING
          ) {
            state.phase = resumePhase;
            renderBatchControls();
          }
        }
      );
    };
    cancelButton.addEventListener('click', () => closeDialog());
    const targets = freezeBatchTargets(snapshot);
    if (!sessionActive) {
      const rawButton = createBatchDialogButton(
        '批次下載原始 JSON',
        { white: true, iconSvg: RAW_JSON_ICON_SVG }
      );
      const handoffButton = createBatchDialogButton(
        '批次下載交接 JSON',
        { white: true, iconSvg: HANDOFF_ICON_SVG }
      );
      const completeButton = createBatchDialogButton(
        '批次下載完整 JSON',
        { white: true, iconSvg: BATCH_EXPORT_ICON_SVG }
      );
      const start = (kind) => {
        const added = commitTargetsToBatchSession(scope, kind, targets);
        if (!added) {
          closeDialog();
          return;
        }
        closeDialog({ resumeSelection: false });
      };
      rawButton.addEventListener('click', () => start(BATCH_EXPORT_RAW));
      handoffButton.addEventListener('click', () => start(BATCH_EXPORT_HANDOFF));
      completeButton.addEventListener('click', () => start(BATCH_EXPORT_COMPLETE));
      rightActions.append(rawButton, handoffButton, completeButton);
    } else {
      const kind = state.exportKind;
      const addButton = createBatchDialogButton(
        `加入批次${getBatchExportKindLabel(kind)}`,
        {
          white: true,
          iconSvg: getBatchExportKindIconSvg(kind)
        }
      );
      addButton.addEventListener('click', () => {
        const added = commitTargetsToBatchSession(scope, kind, targets);
        if (!added) {
          closeDialog();
          return;
        }
        closeDialog({ resumeSelection: false });
      });
      rightActions.append(addButton);
    }
    shell.backdrop.addEventListener('mousedown', (event) => {
      if (!(event.target instanceof Node) || shell.dialog.contains(event.target)) {
        return;
      }
      closeDialog();
    });
    shell.overlay.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeDialog();
      }
    });
    actions.append(cancelButton, rightActions);
    shell.body.append(intro, list, actions);
  }
  function showCancelBatchJobDialog(scope) {
    const state = getBatchSelectionState(scope);
    if (!state || !hasActiveBatchSession(state)) {
      return;
    }
    removeCancelBatchJobDialog();
    const shell = createBatchDialogShell({
      id: BATCH_CANCEL_JOB_DIALOG_ID,
      titleText: '取消批次下載作業',
      testId: 'modal-cgpt-batch-cancel-job-confirmation'
    });
    const message = document.createElement('p');
    message.className = 'text-token-text-primary';
    message.textContent =
      '確認取消後會直接重新整理目前網頁。尚未打包的批次資料、佇列與目前頁面中的批次作業狀態都會被清除。';
    const actions = document.createElement('div');
    actions.className =
      'mt-5 flex w-full items-center justify-between gap-4 text-sm select-none sm:mt-4';
    const backButton = createBatchDialogButton('返回');
    const confirmButton = createBatchDialogButton(
      '確認取消並重新整理',
      { danger: true, iconSvg: BATCH_STOP_ICON_SVG }
    );
    const closeDialog = () => {
      closeBatchDialogShell(shell);
    };
    backButton.addEventListener('click', closeDialog);
    confirmButton.addEventListener('click', () => {
      allowBatchUnloadOnce = true;
      try {
        window.location.reload();
      } catch (error) {
        allowBatchUnloadOnce = false;
        syncBatchBeforeUnloadGuard();
        throw error;
      }
    });
    shell.backdrop.addEventListener('mousedown', (event) => {
      if (!(event.target instanceof Node) || shell.dialog.contains(event.target)) {
        return;
      }
      closeDialog();
    });
    shell.overlay.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeDialog();
      }
    });
    actions.append(backButton, confirmButton);
    shell.body.append(message, actions);
  }
  function disconnectBatchProjectTabObserver() {
    if (batchProjectTabObserver) {
      batchProjectTabObserver.disconnect();
    }
    batchProjectTabObserver = null;
    batchProjectObservedTablist = null;
  }
  function ensureBatchProjectTabObserver() {
    const context = findProjectBatchUiContext();
    if (!context?.tablist) {
      disconnectBatchProjectTabObserver();
      return;
    }
    if (batchProjectObservedTablist === context.tablist && batchProjectTabObserver) {
      return;
    }
    disconnectBatchProjectTabObserver();
    batchProjectObservedTablist = context.tablist;
    batchProjectTabObserver = new MutationObserver(() => {
      /*
       * 只監看專案 tab 的 active state。
       * 尚未建立 session 時切到「資料來源」會退出批次選取模式；
       * session 建立後不因 tab 切換而取消，回到「聊天」時可繼續追加或打包。
       */
      ensureAllBatchSelectionBindings();
      renderBatchControls();
    });
    batchProjectTabObserver.observe(context.tablist, {
      subtree: true,
      attributes: true,
      attributeFilter: ['data-state', 'aria-selected']
    });
  }
  /*
   * 低頻 UI 維護：確保一般側邊欄與專案頁的批次入口存在，
   * 並在 selection / session 狀態中重新綁定被 React 重建的列表。
   */
  function ensureBatchUi() {
    ensureBatchSelectionStyles();
    ensureBatchProjectTabObserver();
    ensureAllBatchSelectionBindings();
    renderBatchControls();
  }
  /*
   * 偵測 SPA path 是否改變。
   */
  function handleRouteMaybeChanged() {
    if (location.pathname === lastPathname) {
      return;
    }
    for (const scope of [BATCH_SCOPE_GENERAL, BATCH_SCOPE_PROJECT]) {
      const state = getBatchSelectionState(scope);
      if (
        state &&
        !hasActiveBatchSession(state) &&
        (
          state.phase === BATCH_PHASE_SELECTING ||
          state.phase === BATCH_PHASE_CONFIRMING
        )
      ) {
        cancelBatchSelectionMode(scope, { silent: true });
      }
      /*
       * 已建立的 session 不因 SPA route change 軟取消。
       * 若要中止，使用「取消批次下載作業」並在確認後重新整理頁面。
       */
    }
    lastPathname = location.pathname;
    closeExportMenu({ restoreFocus: false });
    activeExportState = null;
    setAllButtonsBusy(false);
    updateButtonState();
    ensureFetchInterceptor();
    ensureButtonsSoon();
    ensureBatchUi();
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
      handleRouteMaybeChanged();
      return result;
    };
    history.replaceState = function () {
      const result = originalReplaceState.apply(this, arguments);
      handleRouteMaybeChanged();
      return result;
    };
    window.addEventListener('popstate', () => {
      handleRouteMaybeChanged();
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
      ensureFetchInterceptor();
      handleRouteMaybeChanged();
      if (isConversationPage()) {
        insertButtonsOnce();
      } else {
        removeButtonsIfNeeded();
      }
      ensureBatchUi();
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
    ensureBatchUi();
    startLightPolling();
  }
  // ============================================================
  // 七、啟動腳本
  // ============================================================
  /*
   * 越早包裝 fetch，越有機會被動取得 ChatGPT request context 與 observed response。
   * 正式匯出仍會使用獨立重抓與完整性驗證，不把被動 capture 視為 authoritative raw。
   *
   * UI 插入則等 DOM 可用後再開始。
   */
  ensureFetchInterceptor();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startUi, { once: true });
  } else {
    startUi();
  }
})();