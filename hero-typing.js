/* ============================================================================
   hero-typing.js — トップページ Hero の「horiyouta は ◯◯」タイピング演出
   ----------------------------------------------------------------------------
   下の TERMS リストからランダムに選んだ用語を、日本語IMEっぽく
   「ローマ字 → 変換前のひらがな → （必要なら）漢字/カタカナへの変換」
   という段階を経て1文字（1モーラ）ずつ打ち込んでいく。
   例: 「プ」は  p → ぷ → プ  という3段階を経て表示される。
   全部打ち終わったら少し間を置き、バックスペースで1文字ずつ消して次の
   用語へ移る、を無限ループする。

   用語リストは固定なので、各語の読み（ひらがな）はあらかじめ人力で
   分解して埋め込んである（汎用的な形態素解析はしていない）。
   ========================================================================= */
(function () {
    'use strict';

    var termEl = document.getElementById('heroTypeTerm');
    if (!termEl) return;

    /* ============================================================
       モーラ → ローマ字 対応表（今回使う語に登場するものだけ）
       ============================================================ */
    var MORA_ROMAJI = {
        'あ': 'a', 'い': 'i', 'う': 'u', 'え': 'e', 'お': 'o',
        'か': 'ka', 'き': 'ki', 'く': 'ku', 'け': 'ke', 'こ': 'ko',
        'が': 'ga', 'ぎ': 'gi', 'ぐ': 'gu', 'げ': 'ge', 'ご': 'go',
        'さ': 'sa', 'し': 'shi', 'す': 'su', 'せ': 'se', 'そ': 'so',
        'ざ': 'za', 'じ': 'ji', 'ず': 'zu', 'ぜ': 'ze', 'ぞ': 'zo',
        'た': 'ta', 'ち': 'chi', 'つ': 'tsu', 'て': 'te', 'と': 'to',
        'だ': 'da', 'ぢ': 'ji', 'づ': 'zu', 'で': 'de', 'ど': 'do',
        'な': 'na', 'に': 'ni', 'ぬ': 'nu', 'ね': 'ne', 'の': 'no',
        'は': 'ha', 'ひ': 'hi', 'ふ': 'fu', 'へ': 'he', 'ほ': 'ho',
        'ば': 'ba', 'び': 'bi', 'ぶ': 'bu', 'べ': 'be', 'ぼ': 'bo',
        'ぱ': 'pa', 'ぴ': 'pi', 'ぷ': 'pu', 'ぺ': 'pe', 'ぽ': 'po',
        'ま': 'ma', 'み': 'mi', 'む': 'mu', 'め': 'me', 'も': 'mo',
        'や': 'ya', 'ゆ': 'yu', 'よ': 'yo',
        'ら': 'ra', 'り': 'ri', 'る': 'ru', 'れ': 're', 'ろ': 'ro',
        'わ': 'wa', 'を': 'wo', 'ん': 'n',
        'しゃ': 'sha', 'しゅ': 'shu', 'しょ': 'sho',
        'じゃ': 'ja', 'じゅ': 'ju', 'じょ': 'jo',
        'きゃ': 'kya', 'きゅ': 'kyu', 'きょ': 'kyo',
        'ちゃ': 'cha', 'ちゅ': 'chu', 'ちょ': 'cho',
        'りゃ': 'rya', 'りゅ': 'ryu', 'りょ': 'ryo',
        'うぇ': 'we', 'うぃ': 'wi', 'うぁ': 'wa', 'うぉ': 'wo',
        'とぅ': 'tu', 'てぃ': 'ti', 'でぃ': 'di',
        'ー': '-', 'っ': 'ltu'
    };

    function romajiFor(mora) { return MORA_ROMAJI[mora] || mora; }

    function hiraToKata(str) {
        return str.replace(/[\u3041-\u3096]/g, function (ch) {
            return String.fromCharCode(ch.charCodeAt(0) + 0x60);
        });
    }

    /* ============================================================
       用語リスト（固定14語 + 読みの分解）
       segments の type:
         literal   … 英数字などをそのまま1字ずつ入力（変換なし）
         hiragana  … ローマ字→ひらがな（そのまま確定。「の」「を」など）
         kana      … ローマ字→ひらがな→カタカナへ1モーラずつ変換
         kanji     … 読み全体をローマ字→ひらがなで入力後、まとめて確定文字に変換
       ============================================================ */
    var TERMS = [
        { text: 'Scratcher', segments: [
            { type: 'literal', text: 'Scratcher' }
        ] },
        { text: 'Web デザイナー', segments: [
            { type: 'literal', text: 'Web ' },
            { type: 'kana', morae: ['で', 'ざ', 'い', 'な', 'ー'] }
        ] },
        { text: '50曲以上の楽曲を制作', segments: [
            { type: 'literal', text: '50' },
            { type: 'kanji', morae: ['きょ', 'く'], final: '曲' },
            { type: 'kanji', morae: ['い', 'じょ', 'う'], final: '以上' },
            { type: 'hiragana', morae: ['の'] },
            { type: 'kanji', morae: ['が', 'っ', 'きょ', 'く'], final: '楽曲' },
            { type: 'hiragana', morae: ['を'] },
            { type: 'kanji', morae: ['せ', 'い', 'さ', 'く'], final: '制作' }
        ] },
        { text: '15ヵ国語以上勉強', segments: [
            { type: 'literal', text: '15' },
            { type: 'kanji', morae: ['か'], final: 'ヵ' },
            { type: 'kanji', morae: ['こ', 'く', 'ご'], final: '国語' },
            { type: 'kanji', morae: ['い', 'じょ', 'う'], final: '以上' },
            { type: 'kanji', morae: ['べ', 'ん', 'きょ', 'う'], final: '勉強' }
        ] },
        { text: 'AI エンジニア', segments: [
            { type: 'literal', text: 'AI ' },
            { type: 'kana', morae: ['え', 'ん', 'じ', 'に', 'あ'] }
        ] },
        { text: '数学者', segments: [
            { type: 'kanji', morae: ['す', 'う', 'が', 'く', 'しゃ'], final: '数学者' }
        ] },
        { text: 'ソフトウェア開発者', segments: [
            { type: 'kana', morae: ['そ', 'ふ', 'と', 'うぇ', 'あ'] },
            { type: 'kanji', morae: ['か', 'い', 'は', 'つ', 'しゃ'], final: '開発者' }
        ] },
        { text: 'プログラミングの資格取得者', segments: [
            { type: 'kana', morae: ['ぷ', 'ろ', 'ぐ', 'ら', 'み', 'ん', 'ぐ'] },
            { type: 'hiragana', morae: ['の'] },
            { type: 'kanji', morae: ['し', 'か', 'く', 'しゅ', 'と', 'く', 'しゃ'], final: '資格取得者' }
        ] },
        { text: '画像認識精度世界一保持者', segments: [
            { type: 'kanji', morae: ['が', 'ぞ', 'う', 'に', 'ん', 'し', 'き', 'せ', 'い', 'ど', 'せ', 'か', 'い', 'い', 'ち', 'ほ', 'じ', 'しゃ'], final: '画像認識精度世界一保持者' }
        ] },
        { text: '人工言語作者', segments: [
            { type: 'kanji', morae: ['じ', 'ん', 'こ', 'う', 'げ', 'ん', 'ご', 'さ', 'く', 'しゃ'], final: '人工言語作者' }
        ] },
        { text: 'Scratch 版スイカゲーム原作者', segments: [
            { type: 'literal', text: 'Scratch ' },
            { type: 'kanji', morae: ['ば', 'ん'], final: '版' },
            { type: 'kana', morae: ['す', 'い', 'か', 'げ', 'ー', 'む'] },
            { type: 'kanji', morae: ['げ', 'ん', 'さ', 'く', 'しゃ'], final: '原作者' }
        ] },
        { text: 'スプラトゥーンプレイヤー', segments: [
            { type: 'kana', morae: ['す', 'ぷ', 'ら', 'とぅ', 'ー', 'ん', 'ぷ', 'れ', 'い', 'や', 'ー'] }
        ] },
        { text: 'YouTuber', segments: [
            { type: 'literal', text: 'YouTuber' }
        ] },
        { text: '量子力学研究者', segments: [
            { type: 'kanji', morae: ['りょ', 'う', 'し', 'り', 'き', 'が', 'く', 'け', 'ん', 'きゅ', 'う', 'しゃ'], final: '量子力学研究者' }
        ] },
        { text: 'マイクラMODクリエイター', segments: [
            { type: 'kana', morae: ['ま', 'い', 'く', 'ら'] },
            { type: 'literal', text: 'MOD' },
            { type: 'kana', morae: ['く', 'り', 'え', 'い', 'た', 'ー'] }
        ] }
    ];

    /* term.segments から「入力途中の全表示状態」を順番に並べたフレーム配列を作る */
    function buildFrames(term) {
        var frames = [];
        var committed = '';

        term.segments.forEach(function (seg) {
            if (seg.type === 'literal') {
                for (var i = 1; i <= seg.text.length; i++) {
                    frames.push(committed + seg.text.slice(0, i));
                }
                committed += seg.text;

            } else if (seg.type === 'hiragana') {
                seg.morae.forEach(function (mora) {
                    var romaji = romajiFor(mora);
                    for (var i = 1; i <= romaji.length; i++) {
                        frames.push(committed + romaji.slice(0, i));
                    }
                    frames.push(committed + mora);
                    committed += mora;
                });

            } else if (seg.type === 'kana') {
                seg.morae.forEach(function (mora) {
                    var romaji = romajiFor(mora);
                    for (var i = 1; i <= romaji.length; i++) {
                        frames.push(committed + romaji.slice(0, i));
                    }
                    frames.push(committed + mora); // 変換前のひらがな
                    var kata = hiraToKata(mora);
                    if (kata !== mora) frames.push(committed + kata); // カタカナへ変換
                    committed += kata;
                });

            } else if (seg.type === 'kanji') {
                var readingSoFar = '';
                seg.morae.forEach(function (mora) {
                    var romaji = romajiFor(mora);
                    for (var i = 1; i <= romaji.length; i++) {
                        frames.push(committed + readingSoFar + romaji.slice(0, i));
                    }
                    readingSoFar += mora;
                    frames.push(committed + readingSoFar);
                });
                frames.push(committed + seg.final); // まとめて漢字へ変換（確定）
                committed += seg.final;
            }
        });

        return frames;
    }

    // ランダム抽選ではなく、TERMS の並び順どおりに1つずつ進め、
    // 最後まで行ったら先頭に戻ってループする。
    var termIndex = -1;
    function pickTerm() {
        termIndex = (termIndex + 1) % TERMS.length;
        return TERMS[termIndex];
    }

    var TARGET_TYPE_MS = 3000; // だいたい3秒でその語を打ち終える
    var HOLD_MS = 900;         // 打ち終わってから消し始めるまでの間
    var DELETE_MS_PER_CHAR = 32;
    var PAUSE_BEFORE_NEXT_MS = 500;

    var timerId = null;

    function runTyping() {
        var term = pickTerm();
        var frames = buildFrames(term);
        var perFrame = Math.max(18, TARGET_TYPE_MS / Math.max(1, frames.length));
        var i = 0;

        function typeStep() {
            if (i >= frames.length) {
                termEl.textContent = term.text;
                timerId = setTimeout(deleteStep, HOLD_MS);
                return;
            }
            termEl.textContent = frames[i];
            i++;
            timerId = setTimeout(typeStep, perFrame);
        }

        function deleteStep() {
            var len = term.text.length;
            function del() {
                if (len <= 0) {
                    timerId = setTimeout(runTyping, PAUSE_BEFORE_NEXT_MS);
                    return;
                }
                len--;
                termEl.textContent = term.text.slice(0, len);
                timerId = setTimeout(del, DELETE_MS_PER_CHAR);
            }
            del();
        }

        typeStep();
    }

    runTyping();
})();