# メール基盤の構築記録（2026-09-06 開通）

## 構成
- ドメインメール: info@nyusatsu-compass.com（用途: 問い合わせ受付・アスメル差出人・講座の返信受け）
- メールボックス: バリューサーバー エコ（アカウント ncompass / サーバー e2.valueserver.jp）
- メーラー: 秀丸メール（POP3 e2.valueserver.jp:995 SSL / SMTP 同:587 STARTTLS+SMTP認証 / ユーザー名はアドレス全体）
- ウェブはNetlifyのまま（DNSのa/cnameは不変更。バリューサーバーのドメインウェブ設定は未使用）

## DNS（バリュードメイン・ns1/ns2.value-domain.com）
```
a @ 75.2.60.5
cname www nyusatsu-compass.netlify.app.
mx e2.valueserver.jp. 10
txt @ v=spf1 +mx include:_spf.vdone.jp ~all
txt _dmarc v=DMARC1; p=none; rua=mailto:info@nyusatsu-compass.com
```

## ハマりどころ（学び）
- バリューサーバーの実際の送信は e2 ではなく**中継ゲートウェイ（mail-gw-*.vdone.jp / 160.251.152.x）**から出る。
  SPFに `+a:e2.valueserver.jp` を書いてもGmailに550-5.7.26で弾かれる。**正解は `include:_spf.vdone.jp`**
- Gmailは旧SPFを最大TTL（1時間）キャッシュするため、修正直後の再送は失敗しうる
- 秀丸メールの587はSTARTTLS指定を「SMTP over SSL＋STARTTLSを使用」の2チェックで行う
- 開通確認済み: spf=pass / dmarc=pass（2026-09-06 17:25 JST受信ヘッダ）

## 残タスク
- DKIM: コンパネ「DKIMの設定・鍵確認」→ 公開鍵をDNSにTXT追加
- アスメル導入時: アスメル指定のSPFを `include:` 追記＋アスメル側DKIMがあれば追加 → Gmail宛でPASS再確認
