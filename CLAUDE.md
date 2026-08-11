# 入札コンパス（nyusatsu-compass.jp）

官公庁入札の「判断支援」サービス。落札DB×SEOサイト×適格性マッチ通知。
事業計画・設計・市場分析は ../new-biz/docs/ を正とする（business-plan.md / site-design.md / analysis/）。

## 技術方針（ホジョナビ流儀を継承）

- 外部依存ゼロ: Node組み込みのみ（node:sqlite / fetch / zlib）。npmパッケージは原則入れない
- 静的生成: site/build.mjs → site/dist。ビルドはGitHub Actionsで実行、Netlifyへはdist配信のみ
- データは data/*.db（gitignore）。一次ソースから毎日再取得可能な設計にする
- コミット作者は hojokin-dev。実名・個人情報を書かない。区切りごとに日本語メッセージで自動コミット

## データソースとコンプライアンス

- GEPS落札実績オープンデータ（調達ポータル）: 年度別全件zip+日次差分。出典明記
- KKJ（官公需情報ポータル）検索API: 公告全文。**サイト全ページに利用明記+ https://www.kkj.go.jp/s/ へのリンク必須**。
  日次差分・直列・300ms以上の間隔（../new-biz/docs/kkj-api-terms.md）
- 自治体落札結果（P2〜）: 県域共同システム優先

## 構成

```
pipeline/   取得・構造化（db.mjs / fetch_geps.mjs / fetch_kkj.mjs / classify.mjs ...）
data/       SQLite・生データキャッシュ（gitignore）
site/       静的サイト生成（build.mjs → dist/）
docs/       実装メモ・運用記録
```
