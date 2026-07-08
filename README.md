# 部署到 Cloudflare Pages(團隊共用版)

這個資料夾包含:
- `index.html`:報表本體(跟你之前拿到的檔案一樣,已經改好會去打 `/api/kv` 這個共用資料庫)
- `functions/api/kv/`:Cloudflare Pages Functions,負責讀寫共用資料庫(KV)
- `wrangler.toml`:給用 CLI 部署的人用,網頁介面部署可以忽略

全程都在 Cloudflare Dashboard 網頁上點一點就好,不需要裝任何工具。

---

## 步驟 1:建立 KV Namespace(共用資料庫)

1. 登入 https://dash.cloudflare.com
2. 左側選單找「Workers & Pages」→ 上方分頁點「KV」
3. 點「Create a namespace」,名稱隨意取,例如 `report-kv`,建立

## 步驟 2:建立 Pages 專案並上傳檔案

1. 「Workers & Pages」→「Create」→ 選「Pages」→「Upload assets」
2. 專案名稱隨意取(這會變成你網址的一部分,例如 `xxx.pages.dev`)
3. 把這整個資料夾(`index.html` 跟 `functions` 資料夾都要)拖進去上傳
   - 注意:一定要整個資料夾一起上傳,`functions/` 這個資料夾不能漏掉,不然 API 不會生效
4. 按「Deploy」,等它跑完會給你一個網址,例如 `https://xxx.pages.dev`

先不要急著測試,還差最後兩個設定沒做完(下面步驟3、4),現在打開網站的話,共用資料庫還接不上,會顯示「尚未連上共用資料庫」。

## 步驟 3:把 KV 綁定到這個 Pages 專案

1. 進到剛剛建好的 Pages 專案 →「Settings」→「Functions」
2. 找到「KV namespace bindings」→「Add binding」
3. Variable name 填:`REPORT_KV`(**這個名稱要完全一樣,不能改**)
4. KV namespace 選你在步驟 1 建的那個(`report-kv`)
5. 儲存

## 步驟 4(強烈建議):設定團隊密碼

不設這個的話,任何人只要拿到你的網址,都可以讀寫你的報表資料庫,建議一定要設。

1. 一樣在「Settings」→「Environment variables」
2. 新增一個變數:名稱 `TEAM_SECRET`,值填一個你們團隊內部知道的密碼(例如一串英數字)
3. **類型選「Secret」(加密)**——這樣設定好之後,連你自己在 Cloudflare 後台都看不到明文,只能覆蓋、不能查看,多一層保護(跟一般的「Environment Variable」類型比起來更安全,設定方式一樣,只是下拉選單選不同的類型)
4. 儲存

## 步驟 5:重新部署,讓設定生效

改完 Settings 之後,Cloudflare 不會自動套用到已經上線的版本,要手動重新觸發一次部署:
- 進到「Deployments」分頁 → 找最新那筆 → 點右邊「...」→「Retry deployment」
- 或者把整個資料夾重新上傳一次(等同重新部署一次)

## 步驟 6:打開網站,輸入團隊密碼

1. 打開你的網址(例如 `https://xxx.pages.dev`)
2. 右上角點「🔑 團隊密碼」
3. 輸入跟步驟 4 設定的 `TEAM_SECRET` 一樣的密碼,按「儲存並測試連線」
4. 如果成功,按鈕會變成「☁️ 已連線」,副標題也會顯示「已連上 Cloudflare 共用資料庫」

之後把網址 + 團隊密碼給同事,大家各自打開網址、輸入同一組密碼,看到的月報表/週報表/後台匯入業績就會是同一份、即時同步。

## 步驟 7(選用):讓 Google 試算表自動同步,不用再手動下載/上傳 xlsx

適用情境:你們的「每日收益表」是 Google 試算表(不是本機的 xlsx 檔),而且分頁命名跟欄位排列(產品代號區塊從 T 欄開始)都跟原本的範例表單一致。設定完之後,在「匯入後台每日收益表」視窗裡會多一個「☁️ 從 Google 試算表同步」按鈕,不用再手動下載/上傳檔案。

**這份試算表完全不需要公開分享**,只分享給一個專用的服務帳號:

1. 到 https://console.cloud.google.com 建立一個新專案(免費,不用綁信用卡)
2. 左側選單「API 和服務」→「已啟用的 API 和服務」→ 啟用「**Google Sheets API**」
3. 左側選單「IAM 與管理」→「服務帳號」→「建立服務帳號」,名稱隨意取,建立後**不用**額外指派角色,直接完成
4. 點進剛建立的服務帳號 →「金鑰」分頁→「新增金鑰」→ JSON → 下載,會得到一個 `.json` 檔
5. 打開這個 JSON 檔,把裡面 `client_email` 那個信箱記下來(長得像 `xxx@你的專案.iam.gserviceaccount.com`)
6. 回到要同步的 Google 試算表 →「共用」→ 把這個信箱加進去,權限選「**檢視者**」就好——**不用**改動「一般存取權」那個設定,連結不用公開
7. 回到 Cloudflare Pages 專案 →「Settings」→「Environment variables」,新增一個變數:
   - 名稱:`GOOGLE_SERVICE_ACCOUNT_KEY`
   - **類型選「Secret」(加密)**
   - 值:把整個下載下來的 JSON 檔內容(全部,含大括號)貼進去
8. 跟步驟 5 一樣,重新觸發一次部署讓設定生效
9. 從網址列複製這份試算表的 ID:網址長得像 `https://docs.google.com/spreadsheets/d/這一長串/edit`,中間那一長串就是 ID
10. 打開你的報表網站 →「匯入後台每日收益表」視窗 → 下方「或者:直接從 Google 試算表同步」貼上這個 ID、選好年度 → 按「從 Google 試算表同步」——系統會自動讀「1月」~「12月」這些分頁,存進目前選取的品牌帳本。同一個品牌之後打開這個視窗會自動記住上次用過的試算表 ID,不用重貼(留空直接按同步就會沿用)。

**如果有多個廣告帳號、各自對應不同的 Google 試算表:**先在上方切換/建立好對應的「品牌」(廣告帳號 ID),再進「匯入後台每日收益表」貼上*那個品牌專屬*的試算表 ID 同步一次,之後這個品牌就會記住它自己的試算表,不會互相蓋掉。同一份試算表要給多個品牌用的話,一樣分享給同一個服務帳號 email 即可,不用重複設定。

**注意事項:**
- 這個服務帳號的金鑰只申請「檢視」權限的 Sheets API scope,就算金鑰外洩,對方也不能用它修改你的試算表,但仍然能讀到內容,請一樣比照密碼規格保管,不要把 JSON 金鑰內容貼到聊天工具或公開的地方。
- 如果之後想收回某份試算表的存取權,直接到那份 Sheet 的「共用」設定裡移除服務帳號的信箱即可,不影響其他試算表,也完全不涉及「一般存取權」那個公開設定。

## 步驟 8(選用):設定公司共用的 Meta 權杖

*(這一版沒有啟用這個功能——目前維持原本「每個人自己貼 Token,可以勾選記住」的方式。如果之後想改成大家共用一組、不用各自貼 Token,跟我說一聲,我可以幫你加回來。)*

## 步驟 9(選用):比共用密碼更好的做法——Cloudflare Access

`TEAM_SECRET` 是「一組密碼大家共用」,缺點是密碼一旦外流,要重設就得全部同事一起換一次;也沒辦法只針對某一個人單獨收回權限。如果想要更接近「真正登入」的體驗,可以加裝 **Cloudflare Access**,讓同事用自己的公司 email 收驗證碼登入,不用再記一組共用密碼。這個設定完全在 Cloudflare Dashboard 上點一點就好,**不需要改這個資料夾裡的任何檔案**。

1. 登入 https://dash.cloudflare.com → 左側選單找「Zero Trust」(第一次進入可能需要先建立一個免費的 Zero Trust 帳戶,選免費方案即可)
2. 左側選單「Access」→「Applications」→「Add an application」→ 選「Self-hosted」
3. Application domain 填你的 Pages 網址(例如 `xxx.pages.dev`)
4. 「Policies」設定允許登入的條件,最簡單的做法是選「Emails」,把同事的公司信箱一個一個加進允許清單
5. 儲存後,之後同事打開網址,會先看到 Cloudflare 的登入頁,輸入公司信箱收驗證碼,驗證過才能看到報表網站本身

**這跟 `TEAM_SECRET` 可以同時存在、不衝突**——Cloudflare Access 擋在最外層(進網站前),`TEAM_SECRET` 則是報表網站內部呼叫 `/api/kv`、`/api/sheets` 時的另一層檢查,兩層一起開最保守;如果之後想拿掉共用密碼、完全改用 Cloudflare Access 管理,也可以直接把 `TEAM_SECRET` 這個環境變數刪掉,程式偵測到沒有設定就會自動放行(對應到步驟 4 的邏輯)。

---

## 之後要更新報表功能怎麼辦?

如果之後我再幫你調整報表的程式(例如新增功能),你只需要拿新的 `index.html` 蓋掉舊的重新上傳部署,`functions/` 資料夾不用動,KV 裡的資料不會因為重新部署而消失。

## 常見問題

**Q:副標題一直顯示「尚未連上共用資料庫」**
檢查步驟 2(functions 資料夾有沒有一起上傳)、步驟 3(KV binding 的 Variable name 是不是完全等於 `REPORT_KV`)、有沒有做步驟 5(重新部署)。

**Q:顯示「已連上,但密碼不對」**
確認團隊密碼跟 Cloudflare 的 `TEAM_SECRET` 環境變數完全一樣(注意大小寫、有沒有多打空格)。

**Q:同事不小心把 URL 傳到外部**
建議把 `TEAM_SECRET` 定期更換,或改用步驟 9 的 Cloudflare Access 幫整個網站加一層登入驗證。
