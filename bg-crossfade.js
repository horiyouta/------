/* ============================================================================
   bg-crossfade.js — 事前レンダリング動画 → 実描画 の「フェーズ」制御
   ----------------------------------------------------------------------------
   以前はこのファイルが #bgPreroll (動画) と #bubbleGl / #liquid という
   独立した2つの見た目のレイヤーを CSS の opacity で直接クロスフェード
   させていた。そのため「動画のフェードアウト」と「liquid-bg.js が
   #bubbleGl から背景テクスチャを読み取れているか」がズレると、一瞬
   何も背景が描かれていない（＝真っ暗）フレームが生まれ得た。

   新しい役割：
     このファイルはもう見た目を直接いじらない。代わりに
     window.BGCrossfade = { phase, mix } という「今どの画像を背景として
     使うべきか」という状態だけを更新する。実際の描画・合成は
     liquid-bg.js の updateBgTexture() が毎フレーム、この状態を見て
       - phase 'video'      : #bgPreroll の現在のフレームをそのまま
       - phase 'crossfade'  : #bgPreroll のフレームと #bubbleGl の
                               フレームを mix (0→1) でオフスクリーン
                               合成したもの
       - phase 'bubble'     : #bubbleGl の現在のフレームをそのまま
     背景画像としてテクスチャに焼き、同じ水面シェーダで歪ませて
     #liquid 1枚に描く。背景が「存在しない」瞬間が原理的に生まれない。
   ========================================================================== */
(function(){
  'use strict';

  window.BGCrossfade = window.BGCrossfade || { phase: 'video', mix: 0 };

  var video = document.getElementById('bgPreroll');
  if(!video){
    // 動画が無いページ／読み込みに失敗した場合は最初から本描画のみ
    window.BGCrossfade.phase = 'bubble';
    window.BGCrossfade.mix = 1;
    return;
  }

  var MIN_MS = ((typeof window.BG_PREROLL_SECONDS === 'number') ? window.BG_PREROLL_SECONDS : 10) * 1000;
  var MAX_EXTRA_MS = 15000;   // 実描画の初期化がどれだけ遅れても、これ以上は動画を見せ続けない
  var CROSSFADE_MS = 650;     // 動画→実描画のブレンドにかける時間
  var startTs = performance.now();
  var startedFade = false;

  // Safari等でautoplayが弾かれた場合の保険（mutedなので基本は許可されるはず）
  var playPromise = video.play();
  if(playPromise && typeof playPromise.catch === 'function'){ playPromise.catch(function(){}); }

  function cleanupVideo(){
    video.pause();
    video.removeAttribute('src');
    video.load();
    if(video.parentNode) video.parentNode.removeChild(video);
  }

  function beginCrossfade(){
    console.log('beginCrossfade');
    
    if(startedFade) return;
    startedFade = true;

    // 実描画の時計を「動画のラストフレーム＝PREROLL_SECONDS」から動かし始める
    if(window.BubbleBG && typeof window.BubbleBG.beginReveal === 'function'){
      window.BubbleBG.beginReveal();
    }

    window.BGCrossfade.phase = 'crossfade';
    window.BGCrossfade.mix = 0;
    var fadeStart = performance.now();

    function step(){
      var t = Math.min(1, (performance.now() - fadeStart) / CROSSFADE_MS);
      window.BGCrossfade.mix = t;
      if(t < 1){
        requestAnimationFrame(step);
      }else{
        window.BGCrossfade.phase = 'bubble';
        window.BGCrossfade.mix = 1;
        cleanupVideo();
      }
    }
    requestAnimationFrame(step);
  }

  function tick(){
    var elapsed = performance.now() - startTs;
    var bgReady = !!(window.BubbleBG && window.BubbleBG.ready);

    if(elapsed >= MIN_MS && bgReady){
      beginCrossfade();
      return;
    }
    if(elapsed >= MIN_MS + MAX_EXTRA_MS){
      // 初期化が想定より大幅に遅い/失敗している。諦めて本描画へ切り替える
      // （bubbleGl の中身が無くても liquid-bg.js 側が動画の最終フレームを
      //   保持したままにするので、真っ暗にはならない）
      beginCrossfade();
      return;
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
})();