# ChatGPT Conversation Handoff Exporter

Tampermonkey userscript，用來在 ChatGPT 電腦網頁版匯出目前對話的原始 JSON，或產出適合交接到另一個對話的 handoff JSON。

腳本也包含受控批次匯出流程，可針對使用者在一般聊天清單或單一專案聊天列表中直接選取的對話，建立原始 JSON、交接 JSON，或同時包含兩者的批次 ZIP session。

單一對話與批次流程都使用同一套 conversation 完整性驗證、主分支解析與 handoff schema 2.0 轉換。

## 功能特色

- 在 ChatGPT 對話頁右上角新增兩個按鈕：
  - **下載原始 JSON**
  - **下載交接 JSON**
- 支援一般對話網址，以及 GPT / project 內的對話網址。
- 在腳本可辨識的對話頁 Header action 區插入單一對話匯出按鈕。
- 點擊按鈕時會即時重新抓取目前對話的完整 conversation JSON，不直接把頁面被動觀察到的 response 當成正式匯出來源。
- 腳本會從 ChatGPT 同源 backend request 取得重新抓取所需的 request context；正式 raw / handoff 匯出使用 `/backend-api/conversation/{conversation_id}`，並驗證 `mapping`、`current_node` 與 conversation ID。
- `/backend-api/conversations/{conversation_id}` 及其子路徑可提供 request context；其分頁 `messages` response 不會直接當成正式 raw conversation JSON。
- conversation 與 textdocs 預設使用 XMLHttpRequest 取得；主要通道無法直接驗證時，才使用 `window.fetch` 作第二通道交叉確認。
- 會利用瀏覽器 Resource Timing 與實際 response bytes 進行完整性檢查；若無法確認 conversation 完整性，會停止 raw / handoff 匯出，避免靜默產生缺漏檔案。
- 若 ChatGPT SPA 在腳本啟動後替換 `window.fetch`，腳本會在低頻維護流程中重新掛接攔截器；不會因此主動發送額外 API request。
- 原始 JSON 會以 4 空白縮排輸出，方便閱讀與保存。
- 若對話包含畫布 / textdocs，下載原始 JSON 時會一併下載 textdocs 原始 JSON。
- handoff schema 2.0 會保留目前主分支上的可讀 `user` / `assistant` 訊息，並視來源資料加入：
  - 附件摘要與檔案關聯
  - reply 關聯
  - 引用來源
  - rich content 摘要
  - 模型 / reasoning effort / phase 等執行脈絡
  - 可理解的 reasoning summary / reasoning recap
  - 結構化 tool input / output / artifacts / approval / completion 狀態
  - 畫布 / textdocs 內容、註解與生命週期資訊
  - `data_quality` 轉換品質與未解析關聯統計
- handoff v2 採 **Structure-first / Preserve-on-unknown**：已納入 handoff domain 的工具純文字不依內容樣式做 REDACTED、摘要或長度截斷；runtime-only request context、headers、cookie、session 與 private reasoning body 仍在來源 / 結構層排除。
- textdocs 抓取失敗、回傳空內容，或格式與預期不同時，會以空陣列 `[]` 處理，並繼續完成主要匯出。
- 提供受控批次 raw / handoff / complete；批次資料只存在目前頁面記憶體，使用者按下「打包」後才建立 ZIP STORE（不壓縮）檔案。
- 匯出過程中，按鈕會顯示目前進度。
- 錯誤提示會盡量提供可操作建議，例如重新整理頁面、重新登入、等待對話載入完成或稍後再試。
- 不需要手動複製 DevTools response。
- 不需要執行 Python 腳本。
- 透過 Tampermonkey metadata 支援自動更新。

## 安裝

### 推薦方式：Raw URL 安裝

建議使用 Raw URL 安裝，這樣 Tampermonkey 可以依照腳本中的 `@updateURL` / `@downloadURL` 檢查更新。

1. 安裝 Tampermonkey。
2. 開啟以下 Raw URL：

   ```text
   https://raw.githubusercontent.com/SunnyLeu/ChatGPT-Conversation-Handoff-Exporter/main/chatgpt-conversation-handoff-exporter.user.js
   ```

3. Tampermonkey 會開啟 userscript 安裝頁面。
4. 按下安裝。
5. 重新整理 ChatGPT 對話頁。

### 備用方式：手動安裝

如果 Raw URL 沒有自動開啟 Tampermonkey 安裝頁，也可以手動安裝：

1. 建立新的 userscript。
2. 將 `chatgpt-conversation-handoff-exporter.user.js` 的內容貼進 Tampermonkey 編輯器。
3. 儲存腳本。
4. 重新整理 ChatGPT 對話頁。

> 手動貼上安裝通常仍可使用，但自動更新行為可能不如 Raw URL 安裝穩定。

## 自動更新

若透過 Raw URL 安裝，Tampermonkey 可依照腳本中的 `@updateURL` / `@downloadURL` 檢查遠端版本。

腳本目前使用的更新來源為：

```text
https://raw.githubusercontent.com/SunnyLeu/ChatGPT-Conversation-Handoff-Exporter/main/chatgpt-conversation-handoff-exporter.user.js
```

Tampermonkey 會依照其自身設定定期檢查更新；也可以在 Tampermonkey 管理頁中手動檢查 userscript 更新。

## 使用方式

### 單一對話匯出

進入任一 ChatGPT 對話頁後，右上角會出現兩個按鈕：

- **下載原始 JSON**
- **下載交接 JSON**

#### 下載原始 JSON

點擊 **下載原始 JSON** 會下載目前對話的完整 conversation JSON：

```text
{對話標題}-{yyyyMMddHHmmss}.json
```

如果該對話包含畫布 / textdocs，會額外下載：

```text
{對話標題}-{yyyyMMddHHmmss}.textdocs.json
```

如果該對話沒有畫布 / textdocs，或 textdocs endpoint 無法取得可用內容，則只會下載原始 conversation JSON。

#### 下載交接 JSON

點擊 **下載交接 JSON** 會下載：

```text
{對話標題}-{yyyyMMddHHmmss}.handoff.json
```

交接 JSON 會把目前主分支訊息、可理解的執行脈絡，以及畫布 / textdocs 整合在同一份檔案中。

### 匯出進度

按下匯出按鈕後，按鈕文字會顯示目前處理階段，例如：

- 正在擷取原始 JSON…
- 正在下載原始 JSON…
- 正在擷取 textdocs…
- 正在下載 textdocs…
- 正在產出交接 JSON…
- 正在下載交接 JSON…

這些文字只代表瀏覽器端流程已執行到對應階段；實際下載檔案是否已寫入下載資料夾，仍以瀏覽器下載管理器為準。

> 瀏覽器可能會在第一次下載多個檔案時詢問是否允許 `chatgpt.com` 下載多個檔案。這是瀏覽器的正常安全提示。

## 批次匯出

批次控制項只會在腳本能辨識一般聊天清單或專案聊天列表時顯示。批次功能只處理使用者在 ChatGPT UI 中**直接選取並確認加入目前 session** 的 conversation，不會列舉或掃描帳號內其他對話。

支援三種批次類型：

- **批次下載原始 JSON**：每個成功對話保存 conversation JSON；若有 textdocs，會一併保存 `.textdocs.json`。
- **批次下載交接 JSON**：每個成功對話保存 `.handoff.json`。
- **批次下載完整 JSON**：使用同一份已通過完整性驗證的 conversation / textdocs snapshot 同時產生 raw 與 handoff，ZIP 中分別放入 `原始JSON/` 與 `交接JSON/`。

批次 session 的主要行為：

- 一般聊天與專案聊天維持**獨立 session**，可同時存在。
- 同一個 session 會鎖定 raw、handoff 或 complete 類型。
- 使用者可以在 session 執行期間繼續追加對話。
- 一般聊天與專案聊天底層 request 共用全域 round-robin scheduler，任何時間最多處理一筆 conversation。
- 對話資料取得完成後先保留在頁面記憶體，不會立刻建立 ZIP。
- 使用者按下「打包」後，才以 ZIP **STORE / compression method 0** 建立檔案；不載入第三方 ZIP library。
- ZIP 會包含 `batch-manifest.json`，記錄批次類型、scope、時間、成功 / 失敗 / 未處理數量、每個 conversation 的狀態與檔案資訊。
- 從第一個批次選取建立起，到相關 session 安全打包完成前，腳本會使用 `beforeunload` 防止誤關閉或重新整理。
- 「取消批次下載作業」需要再次確認；確認後會重新整理頁面，以清除目前頁面記憶體中的 batch session、queue 與 payload。

批次 ZIP 檔名形式：

```text
ChatGPT-一般聊天-批次原始JSON-{yyyyMMddHHmmss}.zip
ChatGPT-一般聊天-批次交接JSON-{yyyyMMddHHmmss}.zip
ChatGPT-一般聊天-批次完整JSON-{yyyyMMddHHmmss}.zip

ChatGPT-專案聊天-批次原始JSON-{yyyyMMddHHmmss}.zip
ChatGPT-專案聊天-批次交接JSON-{yyyyMMddHHmmss}.zip
ChatGPT-專案聊天-批次完整JSON-{yyyyMMddHHmmss}.zip
```

## 匯出行為與容錯

### Conversation request context 與完整 raw JSON

工具會被動觀察 ChatGPT 頁面自己發出的同源 backend API request，取得正式重抓所需的 request context。

可用的 conversation request context 可來自：

- `/backend-api/conversation/{conversation_id}` 及其子路徑。
- `/backend-api/conversations/{conversation_id}` 及其子路徑。
- 其他符合腳本安全條件的同源 ChatGPT backend request，可作為最近一次 request template。

可重用 request context 必須包含 `Authorization`，並同時具備腳本可辨識的 ChatGPT client context。腳本接受的 client context 條件包括：

- `x-oai-is`、`oai-session-id`、`oai-device-id`、`oai-client-version`、`oai-client-build-number` 任一項；或
- `oai-did`，並搭配 `x-openai-web-frontend`、`x-openai-codex-window-type`、`chatgpt-account-id` 任一項。

正式 raw / handoff 匯出會重新取得：

```text
/backend-api/conversation/{conversation_id}
```

並要求回應包含有效的：

- `conversation_id`
- `mapping`
- `current_node`
- `mapping[current_node]`

`/backend-api/conversations/{conversation_id}` 的 response 可作為被動觀察資料與 request context 來源，但不直接作為正式 raw conversation JSON。

被動觀察到的 conversation response 只作為輔助資料，不會直接視為正式匯出的可信 raw JSON。

### Conversation 完整性驗證

使用者按下匯出按鈕後，工具會：

1. 依目前 conversation ID 建立完整 conversation endpoint。
2. 優先使用 XMLHttpRequest 作為正式取得通道。
3. 驗證 JSON schema、`conversation_id`、`mapping` 與 `current_node`。
4. 比較 JavaScript 實際取得的 UTF-8 response bytes 與瀏覽器 Resource Timing 的 `decodedBodySize`。
5. 若主要通道無法直接驗證，才使用 `window.fetch` 作第二取得通道交叉確認。
6. 只有完整性可以確認的 conversation snapshot 才會進入 raw JSON 或 handoff JSON。

若 response 大小、conversation revision、conversation ID 或 `mapping` 結構出現無法安全判定的差異，工具會中止本次 raw / handoff 匯出，而不是下載可能不完整的 JSON。

若目前尚未捕捉到可重用請求資訊，工具會提示使用者等待對話載入完成、重新整理頁面，或重新進入該對話後再試。

### `window.fetch` 攔截器

腳本會在低頻 UI 維護流程與路由切換處理中確認 `window.fetch` 是否仍由本腳本包裝；如果 wrapper 不存在，會重新掛接攔截器。

重新掛接本身不會主動送出 API request。

### textdocs / 畫布資料

textdocs 會使用與 conversation 類似的 response 完整性檢查：

- 預設先使用 XMLHttpRequest 取得。
- 若主要通道無法直接確認完整性，才使用 `window.fetch` 作第二通道比較。
- 會比較 JavaScript 實際取得的 response bytes 與瀏覽器 Resource Timing。
- 若兩個通道都缺少足夠的網路層證據，只有在正規化後的 textdocs 內容完全一致時才接受。
- 不會單純因為某一份 textdocs 數量較多，就猜測它比較完整。

textdocs 使用下列 endpoint 取得：

```text
/backend-api/conversation/{conversation_id}/textdocs
```

textdocs 是附加資料，不應阻斷主要對話匯出。

以下情況會以空陣列 `[]` 處理 textdocs，並繼續完成主要匯出：

- textdocs endpoint 無法取得。
- endpoint 回傳 `204`、`205`、`404`。
- endpoint 回傳空內容。
- endpoint 回傳非 JSON。
- endpoint 回傳格式與預期不同。
- textdocs response 無法通過完整性驗證。
- 兩個取得通道的 textdocs 內容不同，且沒有足夠證據判定哪一份可信。
- 單一 textdoc 項目格式不完整或不支援。

### 錯誤提示

匯出失敗時，工具會盡量提供具體建議：

- `401` / `403`：可能是登入狀態失效，可重新整理或重新登入後再試。
- `404`：可能已切換對話或目前 conversation ID 不一致，可確認頁面後再試。
- `408` / `425` / `429`：可能需要稍候片刻再試。
- `5xx`：可能是 ChatGPT 後端暫時異常，可稍後再試。
- 非 JSON 或非完整 conversation JSON：可重新整理頁面，等待對話載入完成後再試。
- conversation response 完整性無法確認：工具會停止 raw / handoff 匯出，避免輸出可能缺漏的資料。
- textdocs response 完整性無法確認：會略過 textdocs，並繼續主要 conversation 匯出。

## 交接 JSON 格式

handoff schema 2.0 是從完整 conversation JSON 與 textdocs JSON 轉換而來的交接格式，目標是讓新的 ChatGPT 對話能理解前一段對話的實際訊息、附件、來源關聯、可理解的執行過程與畫布內容，而不必攜帶完整 raw conversation tree。

目前結構大致如下：

```json
{
  "title": "ChatGPT-Conversation-Handoff-Exporter",
  "create_time": "2026-05-05T07:10:00.000+00:00",
  "update_time": "2026-05-05T07:30:00.000+00:00",
  "conversation_id": "69f98abc-3ac4-8320-9afb-ad658dac4e9b",
  "handoff_schema_version": "2.0",
  "exporter_version": "1.5.3",
  "exported_at": "2026-09-26T05:31:12.970Z",
  "source_context": {
    "product": "chatgpt",
    "surface": "web",
    "conversation_kind": "general"
  },
  "conversation_settings": {
    "is_temporary_chat": false,
    "is_do_not_remember": false,
    "memory_scope": "global",
    "is_study_mode": false
  },
  "execution_profile": {
    "default_model": "gpt-5.6-sol",
    "initial_model": "gpt-5.6-sol",
    "final_model": "gpt-5.6-sol",
    "models_observed": ["gpt-5.6-sol"],
    "initial_reasoning_effort": "high",
    "final_reasoning_effort": "high",
    "reasoning_efforts_observed": ["high"]
  },
  "messages": [
    {
      "id": "u01",
      "sequence": 1,
      "role": "user",
      "content": "請先完整閱讀這兩份檔案並掌握對話進度。",
      "attachments": [
        {
          "id": "att01",
          "name": "example.txt",
          "mime_type": "text/plain",
          "size": 12345
        }
      ]
    },
    {
      "id": "a01",
      "sequence": 2,
      "role": "assistant",
      "phase": "final_answer",
      "model": "gpt-5.6-sol",
      "reasoning_effort": "high",
      "content": "已閱讀並掌握目前資料。",
      "cite_sources": [
        {
          "url": "https://example.com/article",
          "title": "Example Article",
          "snippet": "A short summary or excerpt of the referenced source.",
          "pub_date": "2026-05-05T00:00:00.000+00:00",
          "attribution": "Example Site"
        }
      ]
    }
  ],
  "execution_trace": [
    {
      "id": "e01",
      "sequence": 3,
      "type": "reasoning_summary",
      "summary": "檢查來源並整理必要資訊。",
      "finished": true
    },
    {
      "id": "e02",
      "sequence": 4,
      "type": "tool",
      "tool": "python",
      "operation": "execute",
      "completion_status": "completed",
      "input": {
        "content": "print('example')"
      },
      "output": {
        "content": "example"
      }
    }
  ],
  "textdocs": [
    {
      "id": "td01",
      "version": 7,
      "title": "程式碼畫布",
      "textdoc_type": "code/other",
      "created_at": "2026-05-06T03:25:27.868+00:00",
      "updated_at": "2026-05-06T03:48:35.854+00:00",
      "create_source": "model",
      "lifecycle": {
        "latest_version": 7,
        "created_version": 1,
        "update_count": 2,
        "comment_event_count": 1,
        "last_canvas_event_at": "2026-05-06T03:48:35.854+00:00"
      },
      "content": "# 超簡單 Python 程式：打招呼\n...",
      "comments": [
        {
          "id": "tdc01",
          "start": 0,
          "end": 19,
          "target_text": "# 超簡單 Python 程式：打招呼",
          "content": "這個標題很清楚。"
        }
      ]
    }
  ],
  "data_quality": {
    "textdocs_status": "present",
    "tool_outputs_truncated": 0,
    "redactions_applied": 0,
    "unresolved_tool_results": 0,
    "unresolved_reply_targets": 0,
    "unresolved_file_references": 0,
    "unresolved_execution_refs": 0,
    "omitted_internal_events": 0,
    "result_only_tool_events": 0,
    "source_tree": {
      "mapping_node_count": 100,
      "main_path_node_count": 80,
      "alternate_nodes_omitted": 20,
      "branch_point_count": 3
    }
  }
}
```

> 上例只用來展示 schema 形狀。實際欄位會依來源 conversation、訊息內容、工具事件、附件與 textdocs 狀態選擇性出現。

## 欄位說明

### 頂層欄位

| 欄位                     | 型別             | 說明                                                                              |
| ------------------------ | ---------------- | --------------------------------------------------------------------------------- |
| `title`                  | `string \| null` | 原始 ChatGPT 對話標題。                                                           |
| `create_time`            | `string \| null` | 對話建立時間；可轉換時會整理成可讀 ISO 格式。                                     |
| `update_time`            | `string \| null` | 對話最後更新時間。                                                                |
| `conversation_id`        | `string \| null` | ChatGPT 原始 conversation ID。                                                    |
| `handoff_schema_version` | `string`         | handoff schema 版本，目前為 `2.0`。                                               |
| `exporter_version`       | `string`         | 產生這份 handoff 的 userscript 版本。                                             |
| `exported_at`            | `string`         | 實際產生 handoff 的 UTC 時間。                                                    |
| `source_context`         | `object`         | 來源產品、介面與 conversation 類型摘要。                                          |
| `conversation_settings`  | `object`，選填   | 可安全保留的 conversation 級設定，例如 temporary chat、memory scope、study mode。 |
| `execution_profile`      | `object`，選填   | 對話主分支觀察到的模型與 reasoning effort 摘要。                                  |
| `messages`               | `array`          | 目前主分支上的可讀 `user` / `assistant` 訊息。                                    |
| `execution_trace`        | `array`          | reasoning summary / recap 與正規化 tool event；與 `messages` 共用 sequence。      |
| `textdocs`               | `array`          | 畫布 / textdocs 陣列；沒有可用資料時為 `[]`。                                     |
| `data_quality`           | `object`         | 轉換品質、未解析關聯與來源樹省略統計。                                            |

### `source_context`

| 欄位                | 型別                     | 說明                              |
| ------------------- | ------------------------ | --------------------------------- |
| `product`           | `string`                 | 固定為 `chatgpt`。                |
| `surface`           | `string`                 | 目前為 `web`。                    |
| `conversation_kind` | `"general" \| "project"` | 一般對話或 project conversation。 |

### `messages[]`

| 欄位               | 型別                    | 說明                                                                           |
| ------------------ | ----------------------- | ------------------------------------------------------------------------------ |
| `id`               | `string`                | 交接檔內部使用的簡短訊息 ID，例如 `u01`、`a01`；不是 raw message ID。          |
| `sequence`         | `number`                | 與 `execution_trace` 共用的主分支事件順序。                                    |
| `role`             | `"user" \| "assistant"` | 訊息角色。                                                                     |
| `create_time`      | `string`，選填          | 訊息建立時間。                                                                 |
| `update_time`      | `string`，選填          | 訊息更新時間。                                                                 |
| `phase`            | `string`，選填          | assistant 訊息階段，例如 `final_answer`、`commentary`。                        |
| `model`            | `string`，選填          | assistant message metadata 中可辨識的模型。                                    |
| `reasoning_effort` | `string`，選填          | assistant message metadata 中可辨識的 reasoning effort。                       |
| `status`           | `string`，選填          | 僅在狀態不是正常 `finished_successfully` 時輸出。                              |
| `content`          | `string`，選填          | 可讀訊息文字；attachment-only / rich-content-only message 可以沒有 `content`。 |
| `attachments`      | `array`，選填           | 附件摘要；使用 handoff 內部 attachment ID，不保留 raw tracking ID。            |
| `reply_to`         | `object`，選填          | reply 目標的 handoff message ID 與 / 或可讀引用片段。                          |
| `cite_sources`     | `array`，選填           | assistant 訊息的可解析引用來源。                                               |
| `file_references`  | `array`，選填           | assistant 訊息可解析的檔案引用關聯。                                           |
| `rich_content`     | `array`，選填           | assistant 訊息中可安全整理的 rich reference / rich content 摘要。              |

### `attachments[]`

常見欄位：

| 欄位               | 型別           | 說明                                       |
| ------------------ | -------------- | ------------------------------------------ |
| `id`               | `string`       | handoff 內部 attachment ID，例如 `att01`。 |
| `name`             | `string`，選填 | 安全化後的檔名。                           |
| `mime_type`        | `string`，選填 | MIME type。                                |
| `size`             | `number`，選填 | 檔案大小。                                 |
| `width` / `height` | `number`，選填 | 圖像類附件可用尺寸。                       |
| `source`           | `string`，選填 | 可安全保留的來源標籤。                     |

### `cite_sources[]`

| 欄位          | 型別             | 說明                               |
| ------------- | ---------------- | ---------------------------------- |
| `url`         | `string \| null` | 引用來源 URL。                     |
| `title`       | `string \| null` | 引用來源標題。                     |
| `snippet`     | `string \| null` | 引用來源摘要、片段或簡短描述。     |
| `pub_date`    | `string \| null` | 引用來源發布時間。                 |
| `attribution` | `string \| null` | 來源站台、作者、發布者或歸屬資訊。 |

### `execution_trace[]`

所有 execution event 至少會有：

| 欄位       | 型別                                                 | 說明                                    |
| ---------- | ---------------------------------------------------- | --------------------------------------- |
| `id`       | `string`                                             | handoff 內部 execution ID，例如 `e01`。 |
| `sequence` | `number`                                             | 與 `messages` 共用的主分支順序。        |
| `type`     | `"reasoning_summary" \| "reasoning_recap" \| "tool"` | 正規化事件類型。                        |

#### `reasoning_summary`

可包含：

- `summary`
- `create_time`
- `finished`
- `tool_event_refs`

只使用來源中的可理解 summary；不輸出 private / backend-only reasoning body。

#### `reasoning_recap`

可包含：

- `content`
- `create_time`
- `duration_seconds`

#### `tool`

視來源工具與可辨識資訊，可包含：

- `tool`
- `title`
- `app`
- `operation`
- `create_time`
- `end_time`
- `completion_status`
- `input`
- `output`
- `artifacts`
- `approval`
- textdoc / file 關聯

已納入 handoff domain 的工具純文字採 Preserve-on-unknown；不因看起來像 token、ID、JSON 或其他字串就自行做內容型遮蔽。runtime-only request context、headers、cookie、session 等仍在更前面的結構層排除。

### `execution_profile`

可包含：

- `default_model`
- `initial_model`
- `final_model`
- `models_observed`
- `initial_reasoning_effort`
- `final_reasoning_effort`
- `reasoning_efforts_observed`

### `textdocs[]`

| 欄位            | 型別             | 說明                                                 |
| --------------- | ---------------- | ---------------------------------------------------- |
| `id`            | `string`         | handoff 內部畫布 ID，例如 `td01`。                   |
| `version`       | `number \| null` | 畫布目前版本。                                       |
| `title`         | `string \| null` | 畫布標題。                                           |
| `textdoc_type`  | `string \| null` | 畫布類型，例如 `document`、`code/other`。            |
| `created_at`    | `string`，選填   | 從原始 conversation JSON 的 canvas tool event 推得。 |
| `updated_at`    | `string`，選填   | 來自 textdocs endpoint。                             |
| `create_source` | `string`，選填   | 畫布建立來源，例如 `model`。                         |
| `lifecycle`     | `object`，選填   | 畫布生命週期摘要。                                   |
| `content`       | `string`         | 畫布完整內容；endpoint 缺少內容時為空字串。          |
| `metadata`      | `object`，選填   | textdocs endpoint 回傳的非空 metadata。              |
| `comments`      | `array`          | 畫布註解；沒有註解時為 `[]`。                        |

### `textdocs[].lifecycle`

| 欄位                   | 型別           | 說明                                          |
| ---------------------- | -------------- | --------------------------------------------- |
| `latest_version`       | `number`，選填 | 已知最新版本。                                |
| `created_version`      | `number`，選填 | 建立畫布時的版本。                            |
| `update_count`         | `number`，選填 | 主分支上觀察到的 `update_textdoc` 次數。      |
| `comment_event_count`  | `number`，選填 | 主分支上觀察到的 `comment_textdoc` 事件次數。 |
| `last_canvas_event_at` | `string`，選填 | 最後一次 canvas tool event 時間。             |

### `textdocs[].comments[]`

| 欄位          | 型別             | 說明                                                                    |
| ------------- | ---------------- | ----------------------------------------------------------------------- |
| `id`          | `string`         | handoff 內部註解 ID，例如 `tdc01`。                                     |
| `start`       | `number \| null` | 註解對應內容的起始位置。                                                |
| `end`         | `number \| null` | 註解對應內容的結束位置。                                                |
| `target_text` | `string \| null` | 根據 `start` / `end` 從 `content` 擷取的目標文字；位置無效時為 `null`。 |
| `content`     | `string`         | 註解內容。                                                              |

### `data_quality`

`data_quality` 用來描述轉換過程的已知限制與來源樹資訊，不用來填補未知資料。

目前可包含：

- `textdocs_status`
- `tool_outputs_truncated`
- `redactions_applied`
- `unresolved_tool_results`
- `unresolved_reply_targets`
- `unresolved_file_references`
- `unresolved_execution_refs`
- `omitted_internal_events`
- `result_only_tool_events`
- `source_tree.mapping_node_count`
- `source_tree.main_path_node_count`
- `source_tree.alternate_nodes_omitted`
- `source_tree.branch_point_count`

handoff v2 的工具文字不做內容型截斷或 redaction，因此正常情況下 `tool_outputs_truncated` 與 `redactions_applied` 應維持 `0`；這些欄位仍保留作 schema / 驗證紀錄。

## 訊息順序與主分支

ChatGPT 完整 conversation JSON 的 `mapping` 是樹狀結構，不是單純訊息陣列。

本工具會從 `current_node` 沿著 `parent` 一路回推，取得目前 UI 採用的主分支，再依順序產生 handoff。

`messages` 與 `execution_trace` 共用同一套正整數 `sequence`，因此可以保留目前主分支上「使用者訊息 → reasoning summary → tool call / result → assistant 回覆」等可理解順序。

這代表：

- 若使用者編輯過訊息，通常會輸出目前主分支上的版本。
- 若 assistant 回覆曾重新產生，通常會輸出目前主分支採用的回覆。
- 非目前 `current_node` parent chain 上的訊息與 alternate branch 內容不會直接進入 handoff 主序列。
- `data_quality.source_tree` 會保留來源 mapping 節點數、主分支節點數、略過 alternate nodes 數量與 branch point 統計。

## 轉換規則

handoff JSON 會保留：

- 對話標題與 conversation ID
- 建立 / 更新 / 匯出時間
- handoff schema / exporter version provenance
- 來源介面與 conversation 類型
- 可安全保留的 conversation settings
- 目前主分支上的 `user` / `assistant` 可讀訊息
- attachment-only / rich-content-only message
- attachment 摘要與可解析檔案關聯
- reply 關聯
- assistant 引用來源 metadata
- 模型與 reasoning effort 執行摘要
- `thoughts[].summary` 對應的 `reasoning_summary`
- `reasoning_recap` 可讀內容
- 可辨識 tool input / output / artifacts / approval / completion 狀態
- 已納入 handoff domain 的原始可讀工具文字
- 畫布 / textdocs 目前內容
- 畫布註解與生命週期資訊
- 已知的 linkage / source-tree 品質統計

handoff JSON 會排除或不直接保留：

- 不屬於目前主分支的 alternate branch 原始訊息
- private / backend-only reasoning body，例如 `thoughts[].content` / chunks 類內部內容
- runtime-only request context
- Authorization / headers / cookie / session
- raw tracking ID 與純內部追蹤欄位
- 無可讀內容、且無安全可保留 payload 的內部事件
- 不需要出現在 handoff schema 的 raw conversation tree 結構

> 工具 payload 會依工具類型與資料結構辨識可保留的部分，再正規化到 `execution_trace`；無法確認的關聯會反映在 `data_quality`，不以猜測補成已知資料。

## 隱私與安全

本腳本支援兩種明確由使用者觸發的資料匯出模式：

- 目前正在看的單一對話匯出。
- 使用者在 ChatGPT UI 中直接選取並確認加入 session 的受控批次匯出。

它不會：

- 上傳資料到第三方伺服器。
- 自動列舉或掃描帳號內所有對話。
- 在背景定時主動抓取未經使用者選取的 conversation / textdocs。
- 將 token、cookie 或 session 寫死在程式碼。
- 主動讀取 `document.cookie`。
- 將 raw JSON 或敏感 headers 印到 Console。
- 將 raw JSON、batch payload 或 request context 寫入 `localStorage`、IndexedDB 或 cookie。
- 載入第三方 ZIP library。

request context 只暫存在目前頁面的記憶體中；重新抓取同源 backend JSON 時，cookie / session 由瀏覽器透過既有登入狀態自行處理，不會手動保存或寫入 cookie header。

批次 conversation JSON、textdocs、handoff payload 與 queue 也只暫存在目前頁面記憶體；打包完成後會清理 session。若使用者確認取消批次作業，頁面會重新整理並清除該次記憶體狀態。

完整性檢查的 Console 摘要只包含必要的非內容資訊，例如 conversation ID、取得通道、response bytes、network bytes、`mapping` 節點數或 textdoc 數量；不會輸出 raw JSON、textdoc 內容、完整 headers、token 或 cookie。

textdocs 只有在使用者實際啟動需要 textdocs 的單一或批次匯出流程時才會取得。

## 限制

- 本腳本依賴 ChatGPT 網頁版的 DOM 與內部 backend request 格式。
- 單一對話匯出按鈕只會在腳本能辨識 Header action 容器的對話頁插入。
- 批次控制項只會在腳本能辨識一般聊天清單或專案聊天列表的頁面顯示。
- conversation / textdocs 完整性驗證會使用瀏覽器 Resource Timing；若瀏覽器無法提供足夠資訊，工具會使用第二取得通道交叉確認，仍無法確認時會停止或略過對應匯出。
- 正式 conversation raw JSON 依賴 `/backend-api/conversation/{conversation_id}` 回傳包含 `mapping` 與 `current_node` 的完整 conversation 物件。
- `/backend-api/conversations/{conversation_id}` 不直接作為正式 raw JSON 來源。
- textdocs 使用 `/backend-api/conversation/{conversation_id}/textdocs`；textdocs 無法取得或驗證時會依容錯規則輸出空陣列並繼續主要 conversation 匯出。
- 本腳本不是 OpenAI 官方 API，也不是官方匯出功能。
- 本工具主要面向可安裝 Tampermonkey / userscript 的桌面 Chromium 瀏覽器環境。

## License

MIT
