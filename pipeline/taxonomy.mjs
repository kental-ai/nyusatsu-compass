// 業務分類taxonomy（31万件の案件名頻度分析 2026-08-11 に基づく）。
// 評価は配列順（特化 → 汎用）。最初にマッチした分類を採用する。
// 変更時は classify_rules.mjs を再実行（全件再分類しても数秒）。
export const TAXONOMY = [
  { slug: 'josen',    label: '除染・災害復旧',      re: /除染|災害復旧|被災建物/ },
  { slug: 'seiso',    label: '清掃',               re: /清掃|消毒/ },
  { slug: 'keibi',    label: '警備',               re: /警備|監視業務|守衛/ },
  { slug: 'ryokka',   label: '緑地・除草・剪定',    re: /除草|剪定|緑地|植栽|樹木/ },
  { slug: 'haiki',    label: '廃棄物処理',          re: /廃棄|処分|焼却|リサイクル|産廃/ },
  { slug: 'system',   label: 'システム・IT',        re: /システム|ソフトウェア|アプリ|サーバ|データ入力|デジタル化|電算|クラウド|ネットワーク/ },
  { slug: 'tsushin',  label: '通信・回線',          re: /通信|回線|電話/ },
  { slug: 'energy',   label: '電力・ガス・燃料',    re: /電力|電気(の)?(供給|需給)|で使用する電気|燃料|ガソリン|灯油|重油|軽油|都市ガス|ＬＰガス|LPガス/ },
  { slug: 'insatsu',  label: '印刷・製本',          re: /印刷|製本|複写|刷成/ },
  { slug: 'ringyo',   label: '林業・森林整備',      re: /森林|間伐|造林|林道|素材生産|苗木/ },
  { slug: 'honyaku',  label: '翻訳・通訳',          re: /翻訳|通訳/ },
  { slug: 'kenshu',   label: '研修・講習',          re: /研修|講習|セミナー|訓練/ },
  { slug: 'koho',     label: '広報・広告・制作',    re: /広報|広告|映像|撮影|デザイン|パンフレット|ポスター|ウェブサイト|ホームページ/ },
  { slug: 'iryo',     label: '医療・健診・検査',    re: /医療|医薬品|薬品|検体|診療|健診|検診|ワクチン|介護/ },
  { slug: 'kyushoku', label: '給食・食材',          re: /給食|食材|食糧|弁当|食事/ },
  { slug: 'hoken',    label: '保険',               re: /保険/ },
  { slug: 'sharyo',   label: '車両',               re: /車両|自動車|乗用車|バス|トラック|タイヤ/ },
  { slug: 'unpan',    label: '運搬・配送・郵便',    re: /運搬|配送|輸送|郵便|運送|梱包|封入|発送|チャーター/ },
  { slug: 'senmon',   label: '法務・登記等専門',    re: /登記|鑑定|訴訟|法律相談|特許|社会保険労務/ },
  { slug: 'baikyaku', label: '売払・売却',          re: /売払|売却/ },
  { slug: 'sekkei',   label: '設計・測量・監理',    re: /設計|測量|監理/ },
  { slug: 'koji',     label: '工事・修繕',          re: /工事|修繕|改修|解体|撤去|移設|補修|舗装|塗装/ },
  { slug: 'hoshu',    label: '保守・点検',          re: /保守|点検|整備業務|メンテナンス|修理/ },
  { slug: 'seizo',    label: '製造',               re: /製造|製作/ },
  { slug: 'chosa',    label: '調査・研究・分析',    re: /調査|研究|分析|試験|測定|実証/ },
  { slug: 'jinzai',   label: '人材・受付・窓口',    re: /派遣|受付|窓口|案内業務|コールセンター|事務補助/ },
  { slug: 'chintai',  label: 'リース・賃貸借',      re: /賃貸借|リース|借上|借入/ },
  { slug: 'kiki',     label: '機器・備品',          re: /機器|器具|備品|消耗品|事務用品|用品|パソコン|プリンタ/ },
  { slug: 'tosho',    label: '図書・教材',          re: /図書|書籍|教材|雑誌/ },
  { slug: 'shien',    label: '支援・コンサル',      re: /支援業務|支援委託|コンサル|アドバイザ/ },
  { slug: 'unei',     label: '運営・管理',          re: /運営|管理業務|管理委託/ },
  { slug: 'kounyu',   label: '物品購入（その他）',  re: /購入|調達|買入|供給/ },
];

export function classify(name) {
  for (const t of TAXONOMY) if (t.re.test(name)) return t.slug;
  return 'other';
}
