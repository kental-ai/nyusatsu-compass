# 公開ログ

## 2026-08-11 P1公開（構想からサイト公開まで同日）

- https://nyusatsu-compass.com 公開。16,755ページ（相場32 / 企業16,672 / 機関43 / ハブ・LP等8）
- データ: GEPS落札実績 311,176件（2013〜2026年度）・企業22,703社（うちページ化16,672社）
- 構成: GitHub (kental-ai/nyusatsu-compass) → Netlifyビルド（GEPS取得→分類→生成 約2〜3分）
- DNS: バリュードメイン a@75.2.60.5 / cname www→nyusatsu-compass.netlify.app
- P1ゲート（business-plan.md）: 公開後8週（〜2026-10-06）でインデックス1万ページ or 週間クリック500

## 残タスク（公開直後）

- [ ] Build hook作成 + GitHub secret `NETLIFY_BUILD_HOOK` 登録（毎朝6時の自動更新）
- [ ] Search Console登録（プロパティ追加→所有権確認→sitemap.xml送信）
- [ ] IndexNow導入（hojokin-db/indexnow.mjs流用）
- [ ] アラートフォームの送信テスト（Netlify Forms側の受信確認）
- [ ] 配信メール（毎朝の新着アラート）実装 — 登録者が付き始めてから
