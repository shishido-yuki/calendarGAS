#!/usr/bin/env bash
# =============================================================================
# push-new-branch.sh
#
# 使い方 (Usage):
#   bash scripts/push-new-branch.sh [branch-name]
#
# branch-name を省略した場合は carry-fix/YYYY-MM-DD の形式で自動生成します。
# If branch-name is omitted, it defaults to "carry-fix/YYYY-MM-DD".
#
# 事前条件 (Prerequisites):
#   - git がインストールされていること
#   - origin (GitHub) への push 権限があること
#   - GoLand の場合: Terminal タブ (Alt+F12) でこのスクリプトを実行できます
# =============================================================================

set -euo pipefail

REMOTE="origin"
BASE_BRANCH="main"

# ブランチ名を引数 or 日付から決定
if [[ $# -ge 1 ]]; then
  BRANCH_NAME="$1"
else
  DATE=$(date +%Y-%m-%d)
  BRANCH_NAME="carry-fix/${DATE}"
fi

echo "=========================================="
echo "  新ブランチ作成 & Push スクリプト"
echo "  New Branch: ${BRANCH_NAME}"
echo "  Base      : ${REMOTE}/${BASE_BRANCH}"
echo "=========================================="

# 未コミット変更があれば警告して終了
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo ""
  echo "⚠️  コミットされていない変更があります。"
  echo "   先に変更をコミットまたはスタッシュしてください。"
  echo ""
  echo "   例: git add -A && git commit -m 'your message'"
  echo "       git stash"
  exit 1
fi

# リモートの最新を取得
echo ""
echo "▶ リモートの最新を取得しています ... (git fetch ${REMOTE})"
git fetch "${REMOTE}"

# 既存ブランチと重複していないか確認
if git show-ref --verify --quiet "refs/heads/${BRANCH_NAME}"; then
  echo ""
  echo "⚠️  ローカルに同名のブランチが既に存在します: ${BRANCH_NAME}"
  echo "   別の名前を指定するか、既存ブランチを削除してください。"
  exit 1
fi

# main の最新から新ブランチを作成
echo "▶ ${BASE_BRANCH} から新ブランチを作成します ..."
git checkout -b "${BRANCH_NAME}" "${REMOTE}/${BASE_BRANCH}"

echo "▶ リモートへ push しています ..."
git push -u "${REMOTE}" "${BRANCH_NAME}"

echo ""
echo "✅ ブランチ作成 & Push 完了!"
echo ""
echo "次のステップ:"
echo "  1. GoLand / エディタでファイルを編集する"
echo "  2. 変更をコミット:"
echo "       git add -A"
echo "       git commit -m 'fix: <変更内容の説明>'"
echo "  3. push:"
echo "       git push"
echo "  4. GitHub で Pull Request を作成:"
echo "       https://github.com/shishido-yuki/calendarGAS/compare/main..${BRANCH_NAME}"
echo ""
