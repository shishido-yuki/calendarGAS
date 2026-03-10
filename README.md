# calendarGAS
会議時間集計ツール

---

## ローカル変更を新ブランチへ Push する手順

GoLand（またはターミナル）からローカルの変更を GitHub の新しいブランチへ Push し、Pull Request を作成するまでの流れです。

### 1. 前提条件

| 項目 | 内容 |
|------|------|
| Git | インストール済みであること |
| リモート | `origin` が `https://github.com/shishido-yuki/calendarGAS` に設定済みであること |
| 権限 | リポジトリへの Push 権限があること |

GoLand の場合は **Alt+F12**（macOS: ⌥F12）でターミナルタブを開いてコマンドを実行できます。

---

### 2. スクリプトを使う方法（推奨）

`scripts/push-new-branch.sh` を実行すると、`main` から新しいブランチを自動で作成して Push します。

```bash
# ブランチ名を自動生成（carry-fix/YYYY-MM-DD 形式）
bash scripts/push-new-branch.sh

# ブランチ名を指定する場合
bash scripts/push-new-branch.sh feature/my-fix
```

スクリプトは以下を自動で行います:

1. リモートの最新を `fetch`
2. `main` の最新から新ブランチを作成
3. リモートへ Push（`-u` オプションで追跡ブランチも設定）

---

### 3. 手動で行う場合

```bash
# ① main の最新を取得
git fetch origin

# ② 新ブランチを作成（main ベース）
git checkout -b carry-fix/$(date +%Y-%m-%d) origin/main

# ③ ファイルを編集（GoLand 等）

# ④ 変更をコミット
git add -A
git commit -m "fix: <変更内容の説明>"

# ⑤ Push
git push -u origin HEAD
```

---

### 4. Pull Request の作成

Push 後、以下の URL から GitHub 上で PR を作成します。

```
https://github.com/shishido-yuki/calendarGAS/compare/main..<your-branch-name>
```

または GitHub の Web UI で **"Compare & pull request"** ボタンをクリックしてください。

---

### 5. GoLand から操作する場合

GoLand の Git 機能（**VCS メニュー** または 右下の Git ブランチ）からも同等の操作ができます。

| 操作 | GoLand の手順 |
|------|--------------|
| ブランチ作成 | Git ブランチポップアップ → **New Branch** → ベースに `origin/main` を選択 |
| コミット | **Commit** ダイアログ（Ctrl+K / ⌘K） |
| Push | **Push** ダイアログ（Ctrl+Shift+K / ⌘⇧K） |
| PR 作成 | Push 後、ダイアログ内の **Create Pull Request** リンク or GitHub Web UI |

> **ヒント**: スクリプトを GoLand で実行する場合は、Terminal タブ（Alt+F12）を使用してください。
