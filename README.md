# 仕事管理 PWA

受注・発注を一元管理するスマホ対応のWebアプリです。
Google アカウントでログインし、データは Google Drive に自動保存されます。

---

## セットアップ手順

### 1. Google Cloud Console で OAuth クライアントIDを取得

1. [Google Cloud Console](https://console.cloud.google.com/) を開く
2. プロジェクトを作成（または既存を選択）
3. 左メニュー「APIとサービス」→「ライブラリ」→ **Google Drive API** を有効化
4. 「APIとサービス」→「認証情報」→「認証情報を作成」→「OAuth 2.0 クライアントID」
5. アプリの種類：**ウェブアプリケーション**
6. 「承認済みのJavaScriptオリジン」にアプリを公開するURL を追加
   例: `https://あなたのユーザー名.github.io`
7. 作成 → **クライアントID** をコピー

> **注意**: `file://` で直接開いても OAuth は動作しません。
> 必ず HTTP サーバーから配信してください。

---

### 2. アプリを公開する（推奨: GitHub Pages）

```bash
# このフォルダをリポジトリとして GitHub に push
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/あなた/job-manager.git
git push -u origin main
```

GitHub リポジトリの Settings → Pages → Source を `main` ブランチ `/root` に設定。
公開URLが `https://あなた.github.io/job-manager/` になります。

---

### 3. アプリを開いて初期設定

1. 公開URLをブラウザで開く
2. クライアントIDを入力して「設定を保存」
3. 「Googleでログイン」

---

### 4. スマホのホーム画面に追加（PWA）

**Android（Chrome）**
ブラウザメニュー → 「ホーム画面に追加」

**iOS（Safari）**
共有ボタン → 「ホーム画面に追加」

---

## ファイル構成

```
job-manager/
├── index.html      メインHTML
├── style.css       スタイル（モバイルファースト）
├── app.js          アプリロジック + Drive連携
├── manifest.json   PWAマニフェスト
├── sw.js           Service Worker（オフラインキャッシュ）
├── icon.svg        アプリアイコン
└── README.md       このファイル
```

## 機能

- 受注・発注のデータを別タブで管理
- 各ジョブに記録できる項目:
  - 受注日 / 発注日
  - 仕事内容（必須）
  - 金額（必須）
  - 取引先
  - 作業開始日 / 受渡日 / 完了日
  - 請求書発行日 / 振込日
  - メモ
- ステータス自動判定（未着手 / 進行中 / 完了 / 請求済 / 入金済）
- 受注・発注それぞれの合計金額・件数表示
- Google Drive の非公開領域（appDataFolder）にJSON保存
- ローカルストレージにオフラインキャッシュ
- トークン自動リフレッシュ（1時間ごと）
