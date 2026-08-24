# 障害: Netlify usage_exceeded で本番サイト全体が503（2026-08-24 朝・未解決）

## 症状
2026-08-24 08:26 JST 時点で https://nyusatsu-compass.com の**全URLが HTTP 503**。
レスポンスボディは Netlify からの `{"error":"usage_exceeded","message":"Usage exceeded"}`。
トップ・/local/・既存の県ページ・新規の県ページのいずれも同じ。つまり配信そのものが止まっている。

```
$ curl -sI https://nyusatsu-compass.com/
HTTP/2 503
server: Netlify
{"error":"usage_exceeded","message":"Usage exceeded"}
```

## 効いている可能性が高い原因
`netlify.toml` の記述どおり、**ビルドはNetlify側で実行している**（CLAUDE.mdの
「ビルドはGitHub Actionsで実行、Netlifyへはdist配信のみ」は実態と食い違っているので要修正）。

```toml
[build]
  command = "node pipeline/fetch_geps.mjs all && node pipeline/fetch_kkj.mjs 35 && node pipeline/snapshot_local.mjs import && node pipeline/classify_rules.mjs && node site/build.mjs && (node pipeline/indexnow.mjs || true)"
```

このビルドはローカルで site/build.mjs だけで約2分半かかり、GEPS/KKJ取得と分類を含めると
1回あたり数分〜十数分。**main への push は毎回このビルドを起動する**。
Netlify無料枠の月間ビルド時間は300分なので、日次1回でも月末には上限に近づく。
（帯域100GB/月の超過という可能性も残る。どちらの枠かはダッシュボードでしか判別できない）

## 本日この枠を消費したもの
- 08:00 JST: `daily-rebuild`（daily.yml）がBuild hookを叩く定期ビルド
- 08:09 JST: 自治体データ5県追加のpush → ビルド
- 08:26 JST: docs更新のpush → ビルド

日次の1回に加えて、この作業セッションで2回ビルドを起こしている。上限到達を早めた可能性が高い。

## オーナーの判断が要ること（自動では対処しない）
1. Netlifyダッシュボードの Billing → Usage で、超過しているのが
   **ビルド時間（300分/月）** か **帯域（100GB/月）** かを確認する
2. ビルド時間なら: 課金プランに上げるか、次の請求期間まで待つ
3. 帯域なら: 40,965ページの静的配信で100GBに達しているということなので、
   クローラのトラフィックを疑う（robots.txtのcrawl-delay、画像・CSSの見直し）

## すぐ効く再発防止（課金判断なしでできること）
- **docsだけの変更はコミットメッセージに `[skip netlify]` を付ける**
  （`daily-local.yml` のスナップショットコミットは既にこの運用）。
  本ドキュメントのコミットにも付けている
- ビルドを起こすpushは1日1回（daily-rebuildのBuild hook）に寄せる。
  作業セッション中の中間pushはまとめて最後に1回にする
- Netlifyのビルドコマンドから取得・分類を外し、GitHub Actionsで生成した dist を配信するだけにすれば
  ビルド時間はほぼゼロになる。CLAUDE.md が書いている本来の設計はこちらなので、
  **netlify.toml を実態に合わせるのではなく、設計のほうに寄せる**のが筋

## 影響範囲
本日投入した5県（愛媛・新潟・石川・栃木・沖縄／43,168件）はリポジトリには入っており
（コミット 2c78747d、スナップショット111,139行）、配信が復旧すれば自動的に公開される。
データ側の作業に手戻りはない。

## 解決（2026-08-24 オーナーがダッシュボードで確認）

超過していたのは**ビルド時間でも帯域でもなく、デプロイ回数**だった（Netlifyのクレジット制課金）。

| 項目 | 消費 |
|---|---|
| Production deploys 199回 × 15クレジット | **2,985** |
| Web requests 186,731件 | 37.3 |
| Bandwidth | 22.8 |
| 合計（無料枠 3,000/月） | 3,045.2 |

立ち上げ期に push のたびにデプロイしていたことが原因。トラフィック起因ではないため課金は不要。
請求期間は 8/25 リセットで自動復旧見込み。

## 確定した運用ルール（再発防止）

1. **デプロイは原則1日1回**: 毎朝8:00 JSTの daily-rebuild（Build hook）だけに寄せる。
   月30回×15 = 450クレジット + リクエスト/帯域の伸びを見ても月3,000に収まる
2. **手動pushは既定で `[skip netlify]`** を付け、変更は翌朝のビルドに乗せる。
   即時デプロイは「本番の不具合修正」など明確な理由があるときだけ（その回は付けない）
3. GitHub Actions のコミット（daily-local スナップショット等）は従来どおり `[skip netlify]`
4. 月中でデプロイ残数を気にする状況になったら、このファイルに追記して報告する
