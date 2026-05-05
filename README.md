# ChatGPT Conversation Handoff Exporter

Tampermonkey userscript，用來在 ChatGPT 對話頁匯出目前對話的原始 JSON，或直接產出精簡交接用 JSON。

## 功能

- 在 ChatGPT 對話頁右上角新增兩個按鈕：
  - **下載原始 JSON**
  - **下載交接 JSON**
- 原始 JSON 會以 4 空白縮排輸出，方便閱讀與保存。
- 交接 JSON 會保留目前主分支上的可見 `user` / `assistant` 訊息。
- 支援一般對話網址與 GPT/project 內的對話網址。
- 點擊按鈕時會即時重新抓取目前對話的最新 raw JSON。
- 不需要手動複製 DevTools response。
- 不需要執行 Python 腳本。

## 安裝

1. 安裝 Tampermonkey。
2. 建立新的 userscript。
3. 將 `chatgpt-conversation-handoff-exporter.user.js` 的內容貼進 Tampermonkey 編輯器。
4. 儲存腳本。
5. 重新整理 ChatGPT 對話頁。

## 使用方式

進入任一 ChatGPT 對話頁後，右上角會出現：

- **下載原始 JSON**
- **下載交接 JSON**

點擊 **下載原始 JSON** 會下載：

```text
{對話標題}-{yyyyMMddHHmmss}.json
```

點擊 **下載交接 JSON** 會下載：

```text
{對話標題}-{yyyyMMddHHmmss}.handoff.json
```

## 交接 JSON 格式

交接 JSON 是從 ChatGPT 原始 conversation JSON 轉換而來的精簡格式，目標是讓新的 ChatGPT 對話能快速理解前一段對話的實際進度與內容。

完整結構大致如下：

```json
{
    "title": "ChatGPT-Conversation-Handoff-Exporter",
    "create_time": "2026-05-05T07:10:00.000+00:00",
    "update_time": "2026-05-05T07:30:00.000+00:00",
    "conversation_id": "69f98abc-3ac4-8320-9afb-ad658dac4e9b",
    "messages": [
        {
            "id": "u01",
            "role": "user",
            "content": "請先完整閱讀這兩份檔案\n並掌握對話進度和程式內容"
        },
        {
            "id": "a01",
            "role": "assistant",
            "content": "已完整閱讀並掌握兩份檔案。"
        },
        {
            "id": "u02",
            "role": "user",
            "content": "幫我比較 Bookmarklet 與 Userscript 的差異"
        },
        {
            "id": "a02",
            "role": "assistant",
            "content": "以目前需求來看，Userscript 會比 Bookmarklet 更適合長期使用。",
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
    ]
}
```

### 頂層欄位

| 欄位 | 型別 | 說明 |
|---|---|---|
| `title` | `string \| null` | 原始 ChatGPT 對話標題。若原始資料沒有標題，可能為 `null`。 |
| `create_time` | `string \| null` | 對話建立時間。若原始值是 Unix timestamp，會轉成 UTC ISO 格式，例如 `2026-05-05T07:10:00.000+00:00`。 |
| `update_time` | `string \| null` | 對話最後更新時間。格式同 `create_time`。 |
| `conversation_id` | `string \| null` | ChatGPT 原始 conversation ID。通常會對應網址中的 `/c/{conversation_id}`。 |
| `messages` | `array` | 精簡後的訊息陣列，只保留目前主分支上的可見 `user` / `assistant` 訊息。 |

### `messages[]` 單一訊息欄位

| 欄位 | 型別 | 說明 |
|---|---|---|
| `id` | `string` | 交接檔內部使用的簡短訊息 ID。`user` 訊息會編成 `u01`, `u02`, ...；`assistant` 訊息會編成 `a01`, `a02`, ...。這不是 ChatGPT 原始 message ID。 |
| `role` | `"user" \| "assistant"` | 訊息角色。交接檔只保留使用者與助理的實際對話訊息。 |
| `content` | `string` | 訊息文字內容。會排除非文字 asset pointer，並移除 ChatGPT 內嵌引用標記，例如 `...`。 |
| `cite_sources` | `array`，選填 | 僅在 `assistant` 訊息有可解析的引用來源 metadata 時出現。若沒有引用來源，這個欄位不會輸出。 |

### `cite_sources[]` 引用來源欄位

| 欄位 | 型別 | 說明 |
|---|---|---|
| `url` | `string \| null` | 引用來源 URL。 |
| `title` | `string \| null` | 引用來源標題。 |
| `snippet` | `string \| null` | 引用來源摘要、片段或簡短描述。 |
| `pub_date` | `string \| null` | 引用來源發布時間。若可轉換，會轉成可讀時間格式。 |
| `attribution` | `string \| null` | 來源站台、作者、發布者或歸屬資訊。 |

### 訊息順序與主分支

ChatGPT 原始 conversation JSON 的 `mapping` 是樹狀結構，不是單純的訊息陣列。  
本工具會從 `current_node` 沿著 `parent` 一路回推，取得目前 UI 實際採用的主分支，再依順序輸出到 `messages`。

這代表：

- 若使用者編輯過訊息，通常會輸出目前主分支上的版本。
- 若 assistant 回覆曾重新產生，通常會輸出目前主分支採用的回覆。
- 舊分支、被替換的訊息、非目前路徑上的內容不會出現在交接 JSON。

## 轉換規則

交接 JSON 會保留：

- 對話標題
- 建立時間
- 更新時間
- conversation ID
- 目前主分支上的 `user` / `assistant` 訊息
- assistant 訊息中可取得的引用來源 metadata

交接 JSON 會排除：

- `system` 訊息
- `tool` 訊息
- hidden 訊息
- 模型思考過程
- `reasoning_recap`
- `user_editable_context`
- 非文字 `image_asset_pointer`
- 非文字 `asset_pointer`
- assistant 工具操作 payload，例如 `search_query`, `open`, `find`, `click`
- ChatGPT 內嵌引用標記，例如 `...`

## 隱私與安全

本腳本設計為手動匯出目前正在看的單一對話。

它不會：

- 上傳資料到第三方伺服器
- 批次匯出所有對話
- 將 token、cookie 或 session 寫死在程式碼
- 將 raw JSON 或敏感 headers 印到 Console
- 將 raw JSON 寫入 localStorage、IndexedDB 或 cookie

## 限制

本腳本依賴 ChatGPT 網頁版目前的 DOM 與內部請求格式。  
若 ChatGPT 前端改版，腳本可能需要更新。

## License

MIT
