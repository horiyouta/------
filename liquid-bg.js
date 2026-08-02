/* ============================================================================
   liquid-bg.js — 背景の液体レンダリング & ビート板フローター物理エンジン
   ----------------------------------------------------------------------------
   fluid.html の WebGL 流体シミュレーションをベースに、horiyouta サイト用に
   移植したもの。挙動：
     - マウス（指）を動かすと水面が渦を巻いて流れる
     - クリック/タップで水滴が落ちたような波紋が広がる
     - [data-float] を付けた要素は水面に浮かぶビート板のように波で揺れる
     - [data-glass] を付けた要素は本物の厚みを持つガラスとして光を屈折する
     - window.LiquidBG から script.js が波紋・水流を外部トリガーできる
       （曲再生中の音声解析と連動させるために使用）
   WebGL が使えない環境では自動的に無効化され、style.css 側の
   .custom-bg / backdrop-filter によるフォールバック表示になる。
   ========================================================================= */
window.LiquidBG = window.LiquidBG || {
  ready: false,
  isGlassOK: function () { return false; },
  refresh: function () {},
  remeasure: function () {},
  ripple: function () {},
  splat: function () {},
  dropAt: function () {},
  setEnabled: function () {}
};

(function () {
  'use strict';

  /* =======================================================================
     CONFIG — ここだけで見た目・負荷・挙動を調整できます
     ======================================================================= */
  var CONFIG = {
    /* --- 解像度 / 負荷 --- */
    SIM_RES:          128,       // 流体（速度・圧力）グリッド短辺
    RIPPLE_RES:       340,       // 波動グリッド短辺
    DPR_MAX:          2.0,
    MAX_PIXELS:       4600000,   // 解像度上限。低いと «ぼやけて淡く» 見えるので高め
    PRESSURE_ITER:    12,

    /* --- 流体 --- */
    VEL_DISSIPATION:  0.55,
    CURL:             5.0,
    FORCE:            5000.0,
    SPLAT_RADIUS:     0.00075,
    RIPPLE_RADIUS:    0.00022,
    RIPPLE_AMP:       0.0042,

    /* --- 一滴（クリック） --- */
    DROP_RADIUS:      0.00055,
    DROP_DEPTH:       0.95,
    DROP_RIM:         0.34,

    /* --- 波動 --- */
    WAVE_C2:          0.23,
    WAVE_DAMP:        0.9962,
    WAVE_ADVECT:      2.0,
    FOAM_DECAY:       0.975,
    AMBIENT:          0.000085,  // 常時の微細なうねり（0 で静止）

    /* --- 水のレンダリング（すべて «平らなら元画像と完全一致» になる設計） --- */
    REFRACT:          0.030,
    FLOW_DISTORT:     0.000055,
    NORMAL_SCALE:     1.7,
    CAUSTIC:          0.85,      // 集光。乗算は平均 1 になるので全体は暗くならない
    SPECULAR:         0.55,      // 平面成分を差し引いた «増加分だけ» を加算
    SHININESS:        52.0,
    FRESNEL:          0.16,      // 加算（灰色 mix をやめたので彩度が落ちない）
    FOAM_OPACITY:     0.30,
    SHARPEN:          0.16,      // 縮小リサンプルで失われる解像感の回復（0 で無効）
    SATURATION:       1.06,      // 1.0 = 元画像どおり
    BRIGHTNESS:       1.00,      // 1.0 = 元画像どおり
    AUTO_DROPS:       true,

    /* --- 浮遊要素の物理 --- */
    FLOAT_SLIDE:      2600.0,    // 波の傾斜で滑る強さ
    FLOAT_FLOW:       0.055,     // 流れに押される強さ
    FLOAT_SPRING:     26.0,      // 錨（元位置に戻る力）
    FLOAT_DAMP:       4.6,       // 水の抵抗
    FLOAT_MAX_OFF:    30.0,      // 最大変位 px
    FLOAT_TILT:       90.0,      // 波の傾斜 → 傾き(deg)
    FLOAT_TILT_MAX:   4.2,
    FLOAT_SPIN:       0.055,     // 渦度 → 回転(deg)
    FLOAT_SPIN_MAX:   2.6,
    FLOAT_SMOOTH:     44.0,      // 姿勢追従のばね
    FLOAT_WAKE:       0.55,      // 動いたときに立てる波（航跡）

    /* --- ガラス --- */
    GLASS_THICK:      11.0,      // 厚み（屈折量）※薄めにして歪みを控えめに
    GLASS_BEVEL:      13.0,      // 縁の丸まり幅 px ※境界帯を細く
    GLASS_IOR:        1.42,
    GLASS_DISPERSE:   0.009,     // 色収差 ※抑えめ
    GLASS_FROST:      0.34,      // すりガラス度（可読性はここで調整）
    GLASS_EDGE_FROST: 0.20,      // 縁の散乱 ※抑えめ
    GLASS_REFLECT:    0.46,      // 映り込み量（フレネル）※控えめ
    GLASS_SPEC:       0.68,      // ハイライト ※控えめ
    GLASS_EDGE:       0.22,      // 磨かれた縁の光 ※控えめ
    GLASS_GAIN:       1.02,      // ガラス越しの明るさ補正（暗く見せない）
    GLASS_ABSORB:     0.028,     // 吸収（わずかな青緑）
    GLASS_SHADOW:     0.18,      // 接地影 ※控えめ
    GLASS_CAUSTIC:    0.18       // ガラスの下に落ちる集光 ※控えめ
  };

  var MAXF = 8; /* 浮遊要素の最大数 */

  var canvas = document.getElementById('liquid');

  function disable() {
    canvas.style.display = 'none';
  }

  /* ---------------------------------------------------------- WebGL 初期化 */
  var glParams = {
    alpha: false, depth: false, stencil: false, antialias: false,
    premultipliedAlpha: false, preserveDrawingBuffer: false,
    powerPreference: 'high-performance'
  };

  var gl = canvas.getContext('webgl2', glParams);
  var isGL2 = !!gl;
  if (!gl) gl = canvas.getContext('webgl', glParams) || canvas.getContext('experimental-webgl', glParams);
  if (!gl) { disable(); return; }

  var texType, internalRGBA, internalByte;
  if (isGL2) {
    if (!gl.getExtension('EXT_color_buffer_float') && !gl.getExtension('EXT_color_buffer_half_float')) {
      disable(); return;
    }
    texType = gl.HALF_FLOAT;
    internalRGBA = gl.RGBA16F;
    internalByte = gl.RGBA8;
  } else {
    var hf = gl.getExtension('OES_texture_half_float');
    if (!hf || !gl.getExtension('OES_texture_half_float_linear')) { disable(); return; }
    texType = hf.HALF_FLOAT_OES;
    internalRGBA = gl.RGBA;
    internalByte = gl.RGBA;
  }

  gl.disable(gl.BLEND);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.CULL_FACE);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

  /* ------------------------------------------------------------ シェーダ */
  var PREC_V = 'precision highp float;\nprecision highp sampler2D;\n';
  var PREC_F = [
    '#ifdef GL_FRAGMENT_PRECISION_HIGH',
    'precision highp float;',
    'precision highp sampler2D;',
    '#else',
    'precision mediump float;',
    'precision mediump sampler2D;',
    '#endif',
    ''
  ].join('\n');

  var VERT = PREC_V + [
    'attribute vec2 aPos;',
    'uniform vec2 uTexel;',
    'varying vec2 vUv;',
    'varying vec2 vL; varying vec2 vR; varying vec2 vT; varying vec2 vB;',
    'void main(){',
    '  vUv = aPos * 0.5 + 0.5;',
    '  vL = vUv - vec2(uTexel.x, 0.0);',
    '  vR = vUv + vec2(uTexel.x, 0.0);',
    '  vT = vUv + vec2(0.0, uTexel.y);',
    '  vB = vUv - vec2(0.0, uTexel.y);',
    '  gl_Position = vec4(aPos, 0.0, 1.0);',
    '}'
  ].join('\n');

  var F_COPY = PREC_F + [
    'varying vec2 vUv;',
    'uniform sampler2D uTexture;',
    'uniform float uValue;',
    'void main(){ gl_FragColor = uValue * texture2D(uTexture, vUv); }'
  ].join('\n');

  var F_ADVECT = PREC_F + [
    'varying vec2 vUv;',
    'uniform sampler2D uVelocity;',
    'uniform sampler2D uSource;',
    'uniform vec2 uTexel;',
    'uniform float uDt;',
    'uniform float uDissipation;',
    'void main(){',
    '  vec2 coord = vUv - uDt * texture2D(uVelocity, vUv).xy * uTexel;',
    '  gl_FragColor = texture2D(uSource, coord) / (1.0 + uDissipation * uDt);',
    '}'
  ].join('\n');

  var F_DIVERGENCE = PREC_F + [
    'varying vec2 vUv; varying vec2 vL; varying vec2 vR; varying vec2 vT; varying vec2 vB;',
    'uniform sampler2D uVelocity;',
    'void main(){',
    '  float L = texture2D(uVelocity, vL).x;',
    '  float R = texture2D(uVelocity, vR).x;',
    '  float T = texture2D(uVelocity, vT).y;',
    '  float B = texture2D(uVelocity, vB).y;',
    '  vec2 C = texture2D(uVelocity, vUv).xy;',
    '  if (vL.x < 0.0) { L = -C.x; }',
    '  if (vR.x > 1.0) { R = -C.x; }',
    '  if (vT.y > 1.0) { T = -C.y; }',
    '  if (vB.y < 0.0) { B = -C.y; }',
    '  gl_FragColor = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0);',
    '}'
  ].join('\n');

  var F_CURL = PREC_F + [
    'varying vec2 vUv; varying vec2 vL; varying vec2 vR; varying vec2 vT; varying vec2 vB;',
    'uniform sampler2D uVelocity;',
    'void main(){',
    '  float L = texture2D(uVelocity, vL).y;',
    '  float R = texture2D(uVelocity, vR).y;',
    '  float T = texture2D(uVelocity, vT).x;',
    '  float B = texture2D(uVelocity, vB).x;',
    '  gl_FragColor = vec4(0.5 * ((R - L) - (T - B)), 0.0, 0.0, 1.0);',
    '}'
  ].join('\n');

  var F_VORTICITY = PREC_F + [
    'varying vec2 vUv; varying vec2 vL; varying vec2 vR; varying vec2 vT; varying vec2 vB;',
    'uniform sampler2D uVelocity;',
    'uniform sampler2D uCurl;',
    'uniform float uCurlStrength;',
    'uniform float uDt;',
    'void main(){',
    '  float L = texture2D(uCurl, vL).x;',
    '  float R = texture2D(uCurl, vR).x;',
    '  float T = texture2D(uCurl, vT).x;',
    '  float B = texture2D(uCurl, vB).x;',
    '  float C = texture2D(uCurl, vUv).x;',
    '  vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));',
    '  force /= length(force) + 1e-4;',
    '  force *= uCurlStrength * C;',
    '  force.y *= -1.0;',
    '  vec2 vel = texture2D(uVelocity, vUv).xy + force * uDt;',
    '  gl_FragColor = vec4(clamp(vel, -900.0, 900.0), 0.0, 1.0);',
    '}'
  ].join('\n');

  var F_PRESSURE = PREC_F + [
    'varying vec2 vUv; varying vec2 vL; varying vec2 vR; varying vec2 vT; varying vec2 vB;',
    'uniform sampler2D uPressure;',
    'uniform sampler2D uDivergence;',
    'void main(){',
    '  float L = texture2D(uPressure, vL).x;',
    '  float R = texture2D(uPressure, vR).x;',
    '  float T = texture2D(uPressure, vT).x;',
    '  float B = texture2D(uPressure, vB).x;',
    '  float div = texture2D(uDivergence, vUv).x;',
    '  gl_FragColor = vec4((L + R + B + T - div) * 0.25, 0.0, 0.0, 1.0);',
    '}'
  ].join('\n');

  var F_GRADIENT = PREC_F + [
    'varying vec2 vUv; varying vec2 vL; varying vec2 vR; varying vec2 vT; varying vec2 vB;',
    'uniform sampler2D uPressure;',
    'uniform sampler2D uVelocity;',
    'void main(){',
    '  float L = texture2D(uPressure, vL).x;',
    '  float R = texture2D(uPressure, vR).x;',
    '  float T = texture2D(uPressure, vT).x;',
    '  float B = texture2D(uPressure, vB).x;',
    '  vec2 vel = texture2D(uVelocity, vUv).xy - vec2(R - L, T - B) * 0.5;',
    '  gl_FragColor = vec4(vel, 0.0, 1.0);',
    '}'
  ].join('\n');

  var F_SPLAT_VEL = PREC_F + [
    'varying vec2 vUv;',
    'uniform sampler2D uTarget;',
    'uniform vec2 uPoint; uniform vec2 uForce;',
    'uniform float uAspect; uniform float uRadius;',
    'void main(){',
    '  vec2 p = vUv - uPoint; p.x *= uAspect;',
    '  float d = exp(-dot(p, p) / uRadius);',
    '  gl_FragColor = vec4(texture2D(uTarget, vUv).xy + uForce * d, 0.0, 1.0);',
    '}'
  ].join('\n');

  /* 中心のくぼみ + 円環の縁 = 一滴の落下プロファイル（渦にならず同心円に広がる） */
  var F_SPLAT_RIPPLE = PREC_F + [
    'varying vec2 vUv;',
    'uniform sampler2D uTarget;',
    'uniform vec2 uPoint;',
    'uniform float uAspect; uniform float uRadius;',
    'uniform float uAmp; uniform float uRing; uniform float uFoam;',
    'void main(){',
    '  vec2 p = vUv - uPoint; p.x *= uAspect;',
    '  float r2 = dot(p, p) / uRadius;',
    '  float core = exp(-r2);',
    '  float ring = r2 * core * 2.71828;',
    '  vec4 b = texture2D(uTarget, vUv);',
    '  b.r += uAmp * core + uRing * ring;',
    '  b.b += uFoam * mix(core, ring, 0.65);',
    '  gl_FragColor = b;',
    '}'
  ].join('\n');

  var F_RIPPLE = PREC_F + [
    'varying vec2 vUv;',
    'uniform sampler2D uTex; uniform sampler2D uVelocity;',
    'uniform vec2 uTexel;',
    'uniform float uDt; uniform float uTime; uniform float uC2;',
    'uniform float uDamp; uniform float uAdvect; uniform float uFoamDecay; uniform float uAmbient;',
    'void main(){',
    '  vec2 vel = texture2D(uVelocity, vUv).xy;',
    '  vec2 c = vUv - vel * uDt * uAdvect * uTexel;',
    '  vec4 s = texture2D(uTex, c);',
    '  float hC = s.r, hP = s.g, foam = s.b;',
    '  float hL = texture2D(uTex, c - vec2(uTexel.x, 0.0)).r;',
    '  float hR = texture2D(uTex, c + vec2(uTexel.x, 0.0)).r;',
    '  float hT = texture2D(uTex, c + vec2(0.0, uTexel.y)).r;',
    '  float hB = texture2D(uTex, c - vec2(0.0, uTexel.y)).r;',
    '  float lap = (hL + hR + hT + hB) - 4.0 * hC;',
    '  float nh = (2.0 * hC - hP) + lap * uC2;',
    '  nh += (sin(vUv.x * 11.0 + uTime * 0.61) * sin(vUv.y * 8.5 - uTime * 0.44)',
    '        + 0.6 * sin((vUv.x + vUv.y) * 17.0 - uTime * 0.93)) * uAmbient;',
    '  nh *= uDamp;',
    '  vec2 e = min(vUv, 1.0 - vUv);',
    '  nh *= mix(0.88, 1.0, smoothstep(0.0, 0.05, min(e.x, e.y)));',
    '  foam = foam * uFoamDecay + smoothstep(90.0, 420.0, length(vel)) * 0.045;',
    '  gl_FragColor = vec4(clamp(nh, -4.0, 4.0), hC, min(foam, 1.6), 1.0);',
    '}'
  ].join('\n');

  /* 水面合成：波が平らなら出力は元画像と完全に一致する（暗転・退色ゼロ） */
  var F_WATER = PREC_F + [
    'varying vec2 vUv; varying vec2 vL; varying vec2 vR; varying vec2 vT; varying vec2 vB;',
    'uniform sampler2D uBg; uniform sampler2D uRipple; uniform sampler2D uVelocity;',
    'uniform vec2 uCover; uniform vec2 uRes;',
    'uniform float uAspect, uRefract, uFlow, uNormalScale, uCaustic;',
    'uniform float uSpecular, uShininess, uFresnel, uFoamOpacity;',
    'uniform float uSharpen, uSaturation, uBrightness, uFinal;',
    '',
    'vec2 bgUv(vec2 uv){ return (uv - 0.5) * uCover + 0.5; }',
    '',
    'void main(){',
    '  vec4 r0 = texture2D(uRipple, vUv);',
    '  float hC = r0.r, foam = r0.b;',
    '  float hL = texture2D(uRipple, vL).r;',
    '  float hR = texture2D(uRipple, vR).r;',
    '  float hT = texture2D(uRipple, vT).r;',
    '  float hB = texture2D(uRipple, vB).r;',
    '',
    '  vec2 grad = vec2(hR - hL, hT - hB) * uNormalScale;',
    '  vec3 n = normalize(vec3(-grad, 1.0));',
    '  vec2 vel = texture2D(uVelocity, vUv).xy;',
    '  vec2 off = (n.xy * uRefract + vel * uFlow) * vec2(1.0 / uAspect, 1.0);',
    '',
    '  vec3 col;',
    '  col.r = texture2D(uBg, bgUv(vUv + off * 1.045)).r;',
    '  col.g = texture2D(uBg, bgUv(vUv + off)).g;',
    '  col.b = texture2D(uBg, bgUv(vUv + off * 0.955)).b;',
    '',
    '  if (uSharpen > 0.0) {',
    '    vec2 st = uCover / uRes * 1.25;',
    '    vec2 b = bgUv(vUv + off);',
    '    vec3 lo = texture2D(uBg, b + st).rgb + texture2D(uBg, b - st).rgb',
    '            + texture2D(uBg, b + vec2(st.x, -st.y)).rgb + texture2D(uBg, b + vec2(-st.x, st.y)).rgb;',
    '    col += (col - lo * 0.25) * uSharpen;',
    '  }',
    '',
    '  /* 集光：乗算の平均は 1（明部と暗部が相殺）なので全体の明るさは保たれる */',
    '  float lap = (hL + hR + hT + hB) - 4.0 * hC;',
    '  float caustic = clamp(-lap * uCaustic, -0.24, 0.90);',
    '  col *= 1.0 + caustic;',
    '  col += vec3(0.80, 0.90, 1.00) * max(caustic, 0.0) * 0.13;',
    '',
    '  /* 鏡面：平面時の値を差し引いて «増加分だけ» 加算 → 平らなら寄与 0 */',
    '  vec3 lightDir = normalize(vec3(-0.35, 0.55, 0.76));',
    '  vec3 hv = normalize(lightDir + vec3(0.0, 0.0, 1.0));',
    '  float flat0 = pow(hv.z, uShininess);',
    '  float spec = max(pow(max(dot(n, hv), 0.0), uShininess) - flat0, 0.0) * uSpecular;',
    '  col += vec3(1.0, 0.97, 0.92) * spec;',
    '',
    '  /* フレネル：灰色へ mix せず «加算» するので彩度が落ちない */',
    '  float fres = pow(1.0 - n.z, 1.6) * uFresnel;',
    '  col += vec3(0.42, 0.60, 0.86) * fres;',
    '',
    '  float f = smoothstep(0.30, 1.15, foam);',
    '  col = mix(col, vec3(1.0), f * uFoamOpacity);',
    '',
    '  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));',
    '  col = mix(vec3(lum), col, uSaturation) * uBrightness;',
    '',
    '  if (uFinal > 0.5) {',
    '    float d = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);',
    '    col += (d - 0.5) / 255.0;',
    '  }',
    '  gl_FragColor = vec4(col, 1.0);',
    '}'
  ].join('\n');

  var F_DOWN = PREC_F + [
    'varying vec2 vUv;',
    'uniform sampler2D uTexture;',
    'uniform vec2 uTexel;',
    'void main(){',
    '  vec3 c = texture2D(uTexture, vUv + vec2( uTexel.x,  uTexel.y)).rgb',
    '         + texture2D(uTexture, vUv + vec2(-uTexel.x,  uTexel.y)).rgb',
    '         + texture2D(uTexture, vUv + vec2( uTexel.x, -uTexel.y)).rgb',
    '         + texture2D(uTexture, vUv + vec2(-uTexel.x, -uTexel.y)).rgb;',
    '  gl_FragColor = vec4(c * 0.25, 1.0);',
    '}'
  ].join('\n');

  var F_BLUR = PREC_F + [
    'varying vec2 vUv;',
    'uniform sampler2D uTexture;',
    'uniform vec2 uDir;',
    'void main(){',
    '  vec3 c = texture2D(uTexture, vUv).rgb * 0.2270270270;',
    '  c += (texture2D(uTexture, vUv + uDir * 1.3846153846).rgb',
    '     +  texture2D(uTexture, vUv - uDir * 1.3846153846).rgb) * 0.3162162162;',
    '  c += (texture2D(uTexture, vUv + uDir * 3.2307692308).rgb',
    '     +  texture2D(uTexture, vUv - uDir * 3.2307692308).rgb) * 0.0702702703;',
    '  gl_FragColor = vec4(c, 1.0);',
    '}'
  ].join('\n');

  /* 浮遊要素の足元の水を測るプローブ（3px/要素、16bit パック） */
  var F_PROBE = PREC_F + [
    '#define MAXF ' + MAXF,
    'uniform sampler2D uRipple; uniform sampler2D uVelocity;',
    'uniform vec2 uRTexel; uniform vec2 uVTexel;',
    'uniform vec2 uPos[MAXF]; uniform vec2 uHalf[MAXF];',
    'uniform vec4 uScale;',
    '',
    'vec2 pack16(float v){',
    '  float s = clamp(v * 0.5 + 0.5, 0.0, 1.0) * 65535.0;',
    '  float hi = floor(s / 256.0);',
    '  float lo = floor(s - hi * 256.0);',
    '  return vec2(hi, lo) / 255.0;',
    '}',
    'vec2 grad(vec2 uv){',
    '  float l = texture2D(uRipple, uv - vec2(uRTexel.x, 0.0)).r;',
    '  float r = texture2D(uRipple, uv + vec2(uRTexel.x, 0.0)).r;',
    '  float t = texture2D(uRipple, uv + vec2(0.0, uRTexel.y)).r;',
    '  float b = texture2D(uRipple, uv - vec2(0.0, uRTexel.y)).r;',
    '  return vec2(r - l, t - b);',
    '}',
    'void main(){',
    '  float fx = floor(gl_FragCoord.x);',
    '  int idx = int(floor(fx / 3.0));',
    '  int sub = int(fx - floor(fx / 3.0) * 3.0);',
    '  vec2 c = vec2(0.5), hs = vec2(0.0);',
    '  for (int i = 0; i < MAXF; i++) { if (i == idx) { c = uPos[i]; hs = uHalf[i]; } }',
    '',
    '  vec2 o = hs * 0.62;',
    '  vec2 g = grad(c);',
    '  g += grad(c + vec2( o.x, 0.0)); g += grad(c + vec2(-o.x, 0.0));',
    '  g += grad(c + vec2(0.0,  o.y)); g += grad(c + vec2(0.0, -o.y));',
    '  g *= 0.2;',
    '',
    '  vec2 v = texture2D(uVelocity, c).xy;',
    '  v += texture2D(uVelocity, c + vec2( o.x, 0.0)).xy + texture2D(uVelocity, c + vec2(-o.x, 0.0)).xy;',
    '  v += texture2D(uVelocity, c + vec2(0.0,  o.y)).xy + texture2D(uVelocity, c + vec2(0.0, -o.y)).xy;',
    '  v *= 0.2;',
    '',
    '  float cl = 0.5 * ((texture2D(uVelocity, c + vec2(uVTexel.x, 0.0)).y - texture2D(uVelocity, c - vec2(uVTexel.x, 0.0)).y)',
    '                  - (texture2D(uVelocity, c + vec2(0.0, uVTexel.y)).x - texture2D(uVelocity, c - vec2(0.0, uVTexel.y)).x));',
    '  float h = texture2D(uRipple, c).r;',
    '',
    '  vec4 outc;',
    '  if (sub == 0)      outc = vec4(pack16(g.x / uScale.x), pack16(g.y / uScale.x));',
    '  else if (sub == 1) outc = vec4(pack16(v.x / uScale.y), pack16(v.y / uScale.y));',
    '  else               outc = vec4(pack16(h / uScale.z),  pack16(cl / uScale.w));',
    '  gl_FragColor = outc;',
    '}'
  ].join('\n');

  /* ガラス合成：水面の描画結果を «本物の厚みを持つガラス» で再屈折させる */
  var F_GLASS = PREC_F + [
    '#define MAXG ' + MAXF,
    'varying vec2 vUv;',
    'uniform sampler2D uScene; uniform sampler2D uBlur;',
    'uniform vec2 uRes;',
    'uniform vec4 uGRect[MAXG];  /* cx, cy, halfX, halfY (px) */',
    'uniform vec4 uGRot[MAXG];   /* cos, sin, radius, active */',
    'uniform vec4 uGOpt[MAXG];   /* thickness, parallaxX, parallaxY, frost */',
    'uniform float uBevel, uIor, uDisperse, uEdgeFrost, uReflect;',
    'uniform float uSpec, uEdge, uGain, uAbsorb, uShadow, uCaustic;',
    '',
    'float sdBox(vec2 p, vec2 b, float r){',
    '  vec2 q = abs(p) - b + r;',
    '  return min(max(q.x, q.y), 0.0) + length(max(q, vec2(0.0))) - r;',
    '}',
    'vec2 sdDir(vec2 p, vec2 b, float r){',
    '  vec2 q = abs(p) - b + r;',
    '  vec2 s = sign(p) + vec2(0.0000001);',
    '  if (max(q.x, q.y) > 0.0) return s * normalize(max(q, vec2(0.0)) + vec2(0.0000001));',
    '  return (q.x > q.y) ? vec2(s.x, 0.0) : vec2(0.0, s.y);',
    '}',
    '',
    'void main(){',
    '  vec2 fp = gl_FragCoord.xy;',
    '  vec3 col = texture2D(uScene, vUv).rgb;',
    '  vec2 L2 = normalize(vec2(-0.6, 0.8));',
    '',
    '  for (int i = 0; i < MAXG; i++) {',
    '    vec4 rot = uGRot[i];',
    '    if (rot.w > 0.5) {',
    '      vec4 rect = uGRect[i];',
    '      vec4 opt  = uGOpt[i];',
    '      vec2 d = fp - rect.xy;',
    '      vec2 p = vec2(d.x * rot.x + d.y * rot.y, -d.x * rot.y + d.y * rot.x);',
    '      vec2 hb = rect.zw;',
    '      float rad = rot.z;',
    '      float sd = sdBox(p, hb, rad);',
    '',
    '      /* 接地影 + ガラス下に落ちる集光 */',
    '      float ssd = sdBox(p - vec2(-4.0, -14.0), hb + 4.0, rad + 4.0);',
    '      col *= 1.0 - uShadow * smoothstep(26.0, -4.0, ssd) * smoothstep(-1.0, 3.0, sd);',
    '      float band = smoothstep(22.0, 0.0, sd) * step(0.5, sd);',
    '      col += vec3(0.85, 0.93, 1.0) * band * uCaustic * max(dot(sdDir(p, hb, rad), -L2), 0.0);',
    '',
    '      float inside = smoothstep(1.0, -1.0, sd);',
    '      if (inside > 0.002) {',
    '        float th = opt.x;',
    '        float t  = clamp(-sd / uBevel, 0.0, 1.0);',
    '        float hgt = sqrt(max(1.0 - (1.0 - t) * (1.0 - t), 0.0));',
    '        float slope = (1.0 - t) / max(hgt, 0.12);',
    '        vec2 g2 = sdDir(p, hb, rad);',
    '        vec2 gw = vec2(g2.x * rot.x - g2.y * rot.y, g2.x * rot.y + g2.y * rot.x);',
    '        vec3 n = normalize(vec3(gw * slope * 0.9, 1.0));',
    '',
    '        /* 屈折：厚み × (1 - 1/IOR) 分だけ背後の像をずらす */',
    '        vec2 base = n.xy * th * (1.0 - 1.0 / uIor) * 7.0 + opt.yz;',
    '        vec3 sharp;',
    '        sharp.r = texture2D(uScene, (fp + base * (1.0 + uDisperse)) / uRes).r;',
    '        sharp.g = texture2D(uScene, (fp + base) / uRes).g;',
    '        sharp.b = texture2D(uScene, (fp + base * (1.0 - uDisperse)) / uRes).b;',
    '        vec3 soft = texture2D(uBlur, (fp + base) / uRes).rgb;',
    '',
    '        float fmix = clamp(opt.w + (1.0 - t) * uEdgeFrost, 0.0, 1.0);',
    '        vec3 g = mix(sharp, soft, fmix);',
    '',
    '        /* 吸収（厚いほど僅かに青緑へ）＋ 透過ゲイン */',
    '        float path = mix(1.6, 1.0, t);',
    '        g *= exp(-vec3(1.35, 0.72, 0.90) * uAbsorb * path) * uGain;',
    '',
    '        /* 映り込み（フレネル）：空 + 周囲のぼけた景色 */',
    '        vec3 sky = mix(vec3(0.16, 0.21, 0.29), vec3(0.92, 0.96, 1.0), smoothstep(-0.7, 0.7, n.y));',
    '        vec3 refl = mix(texture2D(uBlur, (fp - n.xy * 90.0) / uRes).rgb, sky, 0.55);',
    '        float fres = 0.04 + 0.96 * pow(1.0 - n.z, 5.0);',
    '        g = mix(g, refl, clamp(fres * uReflect, 0.0, 0.86));',
    '',
    '        /* ハイライト（主光源 + 補助光） */',
    '        vec3 h1 = normalize(normalize(vec3(-0.45, 0.62, 0.64)) + vec3(0.0, 0.0, 1.0));',
    '        vec3 h2 = normalize(normalize(vec3(0.55, -0.45, 0.70)) + vec3(0.0, 0.0, 1.0));',
    '        float s1 = pow(max(dot(n, h1), 0.0), 120.0);',
    '        float s2 = pow(max(dot(n, h2), 0.0), 34.0) * 0.22;',
    '        g += (s1 * 1.5 + s2) * uSpec;',
    '',
    '        /* 磨かれた縁が光を拾う線 */',
    '        float edge = pow(1.0 - t, 3.0);',
    '        g += uEdge * edge * (0.35 + 0.65 * max(dot(gw, L2), 0.0));',
    '        g -= uEdge * 0.22 * edge * max(dot(gw, -L2), 0.0);',
    '',
    '        col = mix(col, g, inside);',
    '      }',
    '    }',
    '  }',
    '',
    '  float dth = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);',
    '  col += (dth - 0.5) / 255.0;',
    '  gl_FragColor = vec4(col, 1.0);',
    '}'
  ].join('\n');

  /* ------------------------------------------------------ プログラム生成 */
  function compile(type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.error(gl.getShaderInfoLog(s), src);
      return null;
    }
    return s;
  }

  function createProgram(fragSrc) {
    var vs = compile(gl.VERTEX_SHADER, VERT);
    var fs = compile(gl.FRAGMENT_SHADER, fragSrc);
    if (!vs || !fs) return null;
    var p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.bindAttribLocation(p, 0, 'aPos');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      console.error(gl.getProgramInfoLog(p));
      return null;
    }
    var u = {}, count = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (var i = 0; i < count; i++) {
      var nm = gl.getActiveUniform(p, i).name.replace('[0]', '');
      u[nm] = gl.getUniformLocation(p, nm);
    }
    return { p: p, u: u };
  }

  var progCopy     = createProgram(F_COPY);
  var progAdvect   = createProgram(F_ADVECT);
  var progDiv      = createProgram(F_DIVERGENCE);
  var progCurl     = createProgram(F_CURL);
  var progVort     = createProgram(F_VORTICITY);
  var progPressure = createProgram(F_PRESSURE);
  var progGradient = createProgram(F_GRADIENT);
  var progSplatV   = createProgram(F_SPLAT_VEL);
  var progSplatR   = createProgram(F_SPLAT_RIPPLE);
  var progRipple   = createProgram(F_RIPPLE);
  var progWater    = createProgram(F_WATER);
  var progDown     = createProgram(F_DOWN);
  var progBlur     = createProgram(F_BLUR);
  var progProbe    = createProgram(F_PROBE);
  var progGlass    = createProgram(F_GLASS);

  if (!progWater || !progRipple || !progAdvect) { disable(); return; }
  var glassOK = !!(progGlass && progProbe && progBlur && progDown);

  /* ------------------------------------------------------------ ジオメトリ */
  var quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  function blit(target) {
    if (target) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
      gl.viewport(0, 0, target.w, target.h);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  function bindTex(tex, unit) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    return unit;
  }

  /* ------------------------------------------------------------------ FBO */
  function createFBO(w, h, internal, type, filter) {
    w = Math.max(1, w | 0); h = Math.max(1, h | 0);
    var tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, gl.RGBA, type, null);
    var fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return { tex: tex, fbo: fbo, w: w, h: h, texelX: 1 / w, texelY: 1 / h };
  }
  function halfFBO(w, h, filter) { return createFBO(w, h, internalRGBA, texType, filter); }
  function byteFBO(w, h, filter) { return createFBO(w, h, internalByte, gl.UNSIGNED_BYTE, filter); }

  function doubleFBO(w, h, filter) {
    return {
      a: halfFBO(w, h, filter), b: halfFBO(w, h, filter),
      get read() { return this.a; },
      get write() { return this.b; },
      swap: function () { var t = this.a; this.a = this.b; this.b = t; }
    };
  }

  (function () {
    var t = halfFBO(4, 4, gl.NEAREST);
    var ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.deleteFramebuffer(t.fbo); gl.deleteTexture(t.tex);
    if (!ok) { disable(); throw new Error('no float render target'); }
  })();

  /* ------------------------------------------------------------ 背景画像 */
  var bgTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, bgTex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, 1, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, new Uint8Array([28, 36, 46]));

  var bgReady = false, bgAspect = 16 / 9;
  var img = new Image();
  img.decoding = 'async';
  img.src = './data/bg.jpg';
  img.onload = function () {
    bgAspect = img.naturalWidth / Math.max(1, img.naturalHeight);
    gl.bindTexture(gl.TEXTURE_2D, bgTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, img);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    bgReady = true;
    updateCover();
    dropAt(0.5, 0.62, 0.30);
  };
  img.onerror = function () { disable(); };

  /* ------------------------------------------------------------- リサイズ */
  var velocity, pressure, divergence, curlFBO, ripple;
  var scene, blurA, blurB, blurC, probeFBO;
  var aspect = 1, cover = [1, 1];
  var quality = 1.0, downgrades = 0;

  function resolution(base) {
    var a = canvas.width / Math.max(1, canvas.height);
    if (a < 1) a = 1 / a;
    var mn = Math.round(base), mx = Math.round(base * a);
    return (canvas.width > canvas.height) ? { w: mx, h: mn } : { w: mn, h: mx };
  }

  function initFramebuffers() {
    var sim = resolution(CONFIG.SIM_RES);
    var rip = resolution(CONFIG.RIPPLE_RES);
    rip.w = Math.min(rip.w, canvas.width);
    rip.h = Math.min(rip.h, canvas.height);

    velocity   = doubleFBO(sim.w, sim.h, gl.LINEAR);
    pressure   = doubleFBO(sim.w, sim.h, gl.NEAREST);
    divergence = halfFBO(sim.w, sim.h, gl.NEAREST);
    curlFBO    = halfFBO(sim.w, sim.h, gl.NEAREST);
    ripple     = doubleFBO(rip.w, rip.h, gl.LINEAR);

    if (glassOK) {
      scene = byteFBO(canvas.width, canvas.height, gl.LINEAR);
      blurA = byteFBO(canvas.width >> 1, canvas.height >> 1, gl.LINEAR);
      blurB = byteFBO(canvas.width >> 2, canvas.height >> 2, gl.LINEAR);
      blurC = byteFBO(canvas.width >> 2, canvas.height >> 2, gl.LINEAR);
      if (!probeFBO) probeFBO = byteFBO(MAXF * 3, 1, gl.NEAREST);
    }
  }

  function updateCover() {
    aspect = canvas.width / Math.max(1, canvas.height);
    var sx = 1, sy = 1;
    if (aspect > bgAspect) sy = bgAspect / aspect; else sx = aspect / bgAspect;
    cover[0] = sx * 0.988;
    cover[1] = sy * 0.988;
  }

  function resize() {
    var dpr = Math.min(window.devicePixelRatio || 1, CONFIG.DPR_MAX) * quality;
    var w = Math.max(1, Math.round(window.innerWidth * dpr));
    var h = Math.max(1, Math.round(window.innerHeight * dpr));
    var px = w * h;
    if (px > CONFIG.MAX_PIXELS) {
      var s = Math.sqrt(CONFIG.MAX_PIXELS / px);
      w = Math.round(w * s); h = Math.round(h * s);
    }
    if (canvas.width === w && canvas.height === h) return;
    canvas.width = w; canvas.height = h;
    initFramebuffers();
    updateCover();
  }

  /* --------------------------------------------------------- 浮遊要素 */
  var floaters = [];
  var pxScale = 1;

  function collectFloaters() {
    var list = document.querySelectorAll('[data-float]');
    floaters.length = 0;
    for (var i = 0; i < list.length && i < MAXF; i++) {
      floaters.push({
        el: list[i],
        glass: list[i].hasAttribute('data-glass'),
        bx: 0, by: 0, bw: 10, bh: 10, radius: 0,
        ox: 0, oy: 0, vx: 0, vy: 0,
        rz: 0, wz: 0, tx: 0, ty: 0, vtx: 0, vty: 0,
        px: 0, py: 0
      });
    }
    if (floaters.length && glassOK) document.body.classList.add('gl-glass');
  }

  function measure() {
    for (var i = 0; i < floaters.length; i++) {
      var f = floaters[i], el = f.el;
      var prev = el.style.transform;
      el.style.transform = 'none';
      var r = el.getBoundingClientRect();
      el.style.transform = prev;
      f.bx = r.left + r.width * 0.5;
      f.by = r.top + r.height * 0.5;
      f.bw = r.width; f.bh = r.height;
      var cs = window.getComputedStyle(el);
      f.radius = Math.min(parseFloat(cs.borderTopLeftRadius) || 0, Math.min(r.width, r.height) * 0.5);
    }
  }

  var lastScrollY = window.scrollY || 0;
  window.addEventListener('scroll', function () {
    var s = window.scrollY || 0, d = s - lastScrollY;
    lastScrollY = s;
    for (var i = 0; i < floaters.length; i++) floaters[i].by -= d;
  }, { passive: true });

  /* ---------------------------------------------------- プローブ読み戻し */
  var P_GRAD = 0.5, P_VEL = 800.0, P_H = 4.0, P_CURL = 140.0;
  var probeBuf = new Uint8Array(MAXF * 3 * 4);
  var pbo = null, fence = null, pboBusy = false;

  if (isGL2 && glassOK) {
    pbo = gl.createBuffer();
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, probeBuf.byteLength, gl.STREAM_READ);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
  }

  function dec16(o) { return ((probeBuf[o] * 256 + probeBuf[o + 1]) / 65535) * 2 - 1; }

  function probePass() {
    var n = floaters.length;
    if (!n) return;
    gl.useProgram(progProbe.p);
    gl.uniform2f(progProbe.u.uTexel, ripple.read.texelX, ripple.read.texelY);
    gl.uniform1i(progProbe.u.uRipple, bindTex(ripple.read.tex, 0));
    gl.uniform1i(progProbe.u.uVelocity, bindTex(velocity.read.tex, 1));
    gl.uniform2f(progProbe.u.uRTexel, ripple.read.texelX, ripple.read.texelY);
    gl.uniform2f(progProbe.u.uVTexel, velocity.read.texelX, velocity.read.texelY);
    gl.uniform4f(progProbe.u.uScale, P_GRAD, P_VEL, P_H, P_CURL);

    var pos = new Float32Array(MAXF * 2), hs = new Float32Array(MAXF * 2);
    var iw = window.innerWidth, ih = window.innerHeight;
    for (var i = 0; i < MAXF; i++) {
      if (i < n) {
        var f = floaters[i];
        pos[i * 2]     = (f.bx + f.ox) / iw;
        pos[i * 2 + 1] = 1 - (f.by + f.oy) / ih;
        hs[i * 2]      = (f.bw * 0.5) / iw;
        hs[i * 2 + 1]  = (f.bh * 0.5) / ih;
      } else { pos[i * 2] = 0.5; pos[i * 2 + 1] = 0.5; }
    }
    gl.uniform2fv(progProbe.u.uPos, pos);
    gl.uniform2fv(progProbe.u.uHalf, hs);
    blit(probeFBO);

    var pw = MAXF * 3;
    if (isGL2 && pbo && !pboBusy) {
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
      gl.readPixels(0, 0, pw, 1, gl.RGBA, gl.UNSIGNED_BYTE, 0);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      pboBusy = true;
    } else if (!isGL2) {
      gl.readPixels(0, 0, pw, 1, gl.RGBA, gl.UNSIGNED_BYTE, probeBuf);
    }
  }

  function pollProbe() {
    if (!pboBusy || !fence) return;
    var st = gl.clientWaitSync(fence, 0, 0);
    if (st === gl.ALREADY_SIGNALED || st === gl.CONDITION_SATISFIED) {
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, probeBuf);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      gl.deleteSync(fence); fence = null; pboBusy = false;
    }
  }

  /* -------------------------------------------------------- 浮遊物理 */
  function updateFloaters(dt) {
    var iw = window.innerWidth, ih = window.innerHeight;
    for (var i = 0; i < floaters.length; i++) {
      var f = floaters[i], o = i * 12;
      var gx = dec16(o) * P_GRAD;
      var gy = dec16(o + 2) * P_GRAD;
      var fvx = dec16(o + 4) * P_VEL;
      var fvy = dec16(o + 6) * P_VEL;
      var cz = dec16(o + 10) * P_CURL;

      /* 波の斜面を滑り落ちる + 流れに押される + 錨のばね + 水の抵抗 */
      var ax = -gx * CONFIG.FLOAT_SLIDE + fvx * CONFIG.FLOAT_FLOW;
      var ay =  gy * CONFIG.FLOAT_SLIDE - fvy * CONFIG.FLOAT_FLOW;
      ax += -CONFIG.FLOAT_SPRING * f.ox - CONFIG.FLOAT_DAMP * f.vx;
      ay += -CONFIG.FLOAT_SPRING * f.oy - CONFIG.FLOAT_DAMP * f.vy;

      f.vx += ax * dt; f.vy += ay * dt;
      f.ox += f.vx * dt; f.oy += f.vy * dt;

      var m = Math.sqrt(f.ox * f.ox + f.oy * f.oy), M = CONFIG.FLOAT_MAX_OFF;
      if (m > M) { var k = M / m; f.ox *= k; f.oy *= k; f.vx *= 0.5; f.vy *= 0.5; }

      /* 姿勢：波の傾斜で board が傾き、渦度で回る */
      var tgx = Math.max(-CONFIG.FLOAT_TILT_MAX, Math.min(CONFIG.FLOAT_TILT_MAX, gx * CONFIG.FLOAT_TILT));
      var tgy = Math.max(-CONFIG.FLOAT_TILT_MAX, Math.min(CONFIG.FLOAT_TILT_MAX, gy * CONFIG.FLOAT_TILT));
      var tgz = Math.max(-CONFIG.FLOAT_SPIN_MAX, Math.min(CONFIG.FLOAT_SPIN_MAX, cz * CONFIG.FLOAT_SPIN));
      var ks = CONFIG.FLOAT_SMOOTH, cs = 2 * Math.sqrt(ks) * 0.9;
      f.vtx += ((tgy - f.tx) * ks - f.vtx * cs) * dt; f.tx += f.vtx * dt;
      f.vty += ((tgx - f.ty) * ks - f.vty * cs) * dt; f.ty += f.vty * dt;
      f.wz  += ((tgz - f.rz) * ks - f.wz  * cs) * dt; f.rz += f.wz  * dt;

      f.el.style.transform =
        'translate3d(' + f.ox.toFixed(2) + 'px,' + f.oy.toFixed(2) + 'px,0)' +
        ' rotateZ(' + f.rz.toFixed(3) + 'deg)' +
        ' rotateX(' + f.tx.toFixed(3) + 'deg)' +
        ' rotateY(' + f.ty.toFixed(3) + 'deg)';

      /* 航跡：動いた分だけ小さな波を立てる（速度場は触らないので暴走しない） */
      var sp = Math.sqrt(f.vx * f.vx + f.vy * f.vy);
      if (CONFIG.FLOAT_WAKE > 0 && sp > 6) {
        var ux = (f.bx + f.ox) / iw, uy = 1 - (f.by + f.oy) / ih;
        var nx = f.vx / sp, ny = -f.vy / sp;
        var amp = -Math.min(0.05, sp * 0.00035) * CONFIG.FLOAT_WAKE;
        queueRipple(ux + nx * (f.bw * 0.5 / iw), uy + ny * (f.bh * 0.5 / ih),
                    amp, CONFIG.RIPPLE_RADIUS * 3.0, 0.01, 0);
      }
      f.px = f.ox; f.py = f.oy;
    }
  }

  /* --------------------------------------------------------------- 入力 */
  var pointer = { x: 0.5, y: 0.5, px: 0.5, py: 0.5, moved: false, active: false };
  var lastInput = performance.now();
  var pendingVel = [], pendingRip = [], delayed = [];

  function queueVel(x, y, fx, fy, r) { if (pendingVel.length < 48) pendingVel.push([x, y, fx, fy, r]); }
  function queueRipple(x, y, a, r, foam, ring) { if (pendingRip.length < 48) pendingRip.push([x, y, a, r, foam, ring || 0]); }
  function queueDelayed(ms, x, y, a, r, foam, ring) {
    if (delayed.length < 24) delayed.push({ t: performance.now() + ms, x: x, y: y, a: a, r: r, f: foam, g: ring || 0 });
  }

  function dropAt(x, y, s) {
    s = (s === undefined) ? 1 : s;
    var R = CONFIG.DROP_RADIUS;
    queueRipple(x, y, -CONFIG.DROP_DEPTH * s, R, 0.10 * s, CONFIG.DROP_RIM * s);
    queueDelayed(120, x, y, -0.30 * s, R * 0.75, 0.03 * s, 0.16 * s);
    queueDelayed(260, x, y, -0.12 * s, R * 0.55, 0.0, 0.07 * s);
  }

  function toUv(e) { return { x: e.clientX / window.innerWidth, y: 1 - e.clientY / window.innerHeight }; }

  window.addEventListener('pointermove', function (e) {
    if (e.isPrimary === false) return;
    var p = toUv(e);
    if (!pointer.active) { pointer.px = p.x; pointer.py = p.y; pointer.active = true; }
    pointer.x = p.x; pointer.y = p.y; pointer.moved = true;
    lastInput = performance.now();
  }, { passive: true });

  window.addEventListener('pointerdown', function (e) {
    if (e.isPrimary === false) return;
    var p = toUv(e);
    pointer.px = pointer.x = p.x; pointer.py = pointer.y = p.y;
    pointer.active = true; lastInput = performance.now();
    dropAt(p.x, p.y, 1.0);
  }, { passive: true });

  window.addEventListener('pointerleave', function () { pointer.active = false; }, { passive: true });
  window.addEventListener('blur', function () { pointer.active = false; }, { passive: true });

  function consumePointer(dt) {
    if (!pointer.moved) return;
    pointer.moved = false;
    var dx = pointer.x - pointer.px, dy = pointer.y - pointer.py;
    var dist = Math.sqrt(dx * dx * aspect * aspect + dy * dy);
    if (dist < 1e-5) { pointer.px = pointer.x; pointer.py = pointer.y; return; }

    var speed = dist / Math.max(dt, 0.008);
    var steps = Math.min(8, Math.max(1, Math.ceil(dist / 0.022)));
    var fS = CONFIG.FORCE / steps;
    var amp = -Math.min(0.55, speed * CONFIG.RIPPLE_AMP) / steps * 1.6;
    var foam = Math.min(0.22, speed * 0.0016) / steps;

    for (var i = 1; i <= steps; i++) {
      var t = i / steps, x = pointer.px + dx * t, y = pointer.py + dy * t;
      queueVel(x, y, dx * fS, dy * fS, CONFIG.SPLAT_RADIUS);
      queueRipple(x, y, amp, CONFIG.RIPPLE_RADIUS, foam, 0);
    }
    pointer.px = pointer.x; pointer.py = pointer.y;
  }

  /* ------------------------------------------------------------- パス */
  function splatVelocity(x, y, fx, fy, r) {
    gl.useProgram(progSplatV.p);
    gl.uniform2f(progSplatV.u.uTexel, velocity.read.texelX, velocity.read.texelY);
    gl.uniform1i(progSplatV.u.uTarget, bindTex(velocity.read.tex, 0));
    gl.uniform2f(progSplatV.u.uPoint, x, y);
    gl.uniform2f(progSplatV.u.uForce, fx, fy);
    gl.uniform1f(progSplatV.u.uAspect, aspect);
    gl.uniform1f(progSplatV.u.uRadius, r);
    blit(velocity.write); velocity.swap();
  }

  function splatRipple(x, y, a, r, foam, ring) {
    gl.useProgram(progSplatR.p);
    gl.uniform2f(progSplatR.u.uTexel, ripple.read.texelX, ripple.read.texelY);
    gl.uniform1i(progSplatR.u.uTarget, bindTex(ripple.read.tex, 0));
    gl.uniform2f(progSplatR.u.uPoint, x, y);
    gl.uniform1f(progSplatR.u.uAspect, aspect);
    gl.uniform1f(progSplatR.u.uRadius, r);
    gl.uniform1f(progSplatR.u.uAmp, a);
    gl.uniform1f(progSplatR.u.uRing, ring);
    gl.uniform1f(progSplatR.u.uFoam, foam);
    blit(ripple.write); ripple.swap();
  }

  function flushSplats() {
    var i;
    for (i = 0; i < pendingVel.length; i++) { var v = pendingVel[i]; splatVelocity(v[0], v[1], v[2], v[3], v[4]); }
    for (i = 0; i < pendingRip.length; i++) { var r = pendingRip[i]; splatRipple(r[0], r[1], r[2], r[3], r[4], r[5]); }
    pendingVel.length = 0; pendingRip.length = 0;
  }

  var simTime = 0;

  function step(dt) {
    var tx = velocity.read.texelX, ty = velocity.read.texelY;

    gl.useProgram(progCurl.p);
    gl.uniform2f(progCurl.u.uTexel, tx, ty);
    gl.uniform1i(progCurl.u.uVelocity, bindTex(velocity.read.tex, 0));
    blit(curlFBO);

    gl.useProgram(progVort.p);
    gl.uniform2f(progVort.u.uTexel, tx, ty);
    gl.uniform1i(progVort.u.uVelocity, bindTex(velocity.read.tex, 0));
    gl.uniform1i(progVort.u.uCurl, bindTex(curlFBO.tex, 1));
    gl.uniform1f(progVort.u.uCurlStrength, CONFIG.CURL);
    gl.uniform1f(progVort.u.uDt, dt);
    blit(velocity.write); velocity.swap();

    gl.useProgram(progDiv.p);
    gl.uniform2f(progDiv.u.uTexel, tx, ty);
    gl.uniform1i(progDiv.u.uVelocity, bindTex(velocity.read.tex, 0));
    blit(divergence);

    gl.useProgram(progCopy.p);
    gl.uniform2f(progCopy.u.uTexel, tx, ty);
    gl.uniform1i(progCopy.u.uTexture, bindTex(pressure.read.tex, 0));
    gl.uniform1f(progCopy.u.uValue, 0.8);
    blit(pressure.write); pressure.swap();

    gl.useProgram(progPressure.p);
    gl.uniform2f(progPressure.u.uTexel, tx, ty);
    gl.uniform1i(progPressure.u.uDivergence, bindTex(divergence.tex, 0));
    for (var i = 0; i < CONFIG.PRESSURE_ITER; i++) {
      gl.uniform1i(progPressure.u.uPressure, bindTex(pressure.read.tex, 1));
      blit(pressure.write); pressure.swap();
    }

    gl.useProgram(progGradient.p);
    gl.uniform2f(progGradient.u.uTexel, tx, ty);
    gl.uniform1i(progGradient.u.uPressure, bindTex(pressure.read.tex, 0));
    gl.uniform1i(progGradient.u.uVelocity, bindTex(velocity.read.tex, 1));
    blit(velocity.write); velocity.swap();

    gl.useProgram(progAdvect.p);
    gl.uniform2f(progAdvect.u.uTexel, tx, ty);
    gl.uniform1i(progAdvect.u.uVelocity, bindTex(velocity.read.tex, 0));
    gl.uniform1i(progAdvect.u.uSource, bindTex(velocity.read.tex, 0));
    gl.uniform1f(progAdvect.u.uDt, dt);
    gl.uniform1f(progAdvect.u.uDissipation, CONFIG.VEL_DISSIPATION);
    blit(velocity.write); velocity.swap();

    simTime += dt;
    gl.useProgram(progRipple.p);
    gl.uniform2f(progRipple.u.uTexel, ripple.read.texelX, ripple.read.texelY);
    gl.uniform1i(progRipple.u.uTex, bindTex(ripple.read.tex, 0));
    gl.uniform1i(progRipple.u.uVelocity, bindTex(velocity.read.tex, 1));
    gl.uniform1f(progRipple.u.uDt, dt);
    gl.uniform1f(progRipple.u.uTime, simTime);
    gl.uniform1f(progRipple.u.uC2, CONFIG.WAVE_C2);
    gl.uniform1f(progRipple.u.uDamp, CONFIG.WAVE_DAMP);
    gl.uniform1f(progRipple.u.uAdvect, CONFIG.WAVE_ADVECT);
    gl.uniform1f(progRipple.u.uFoamDecay, CONFIG.FOAM_DECAY);
    gl.uniform1f(progRipple.u.uAmbient, CONFIG.AMBIENT);
    blit(ripple.write); ripple.swap();
  }

  function renderWater(target, final) {
    var u = progWater.u;
    gl.useProgram(progWater.p);
    gl.uniform2f(u.uTexel, ripple.read.texelX, ripple.read.texelY);
    gl.uniform1i(u.uBg, bindTex(bgTex, 0));
    gl.uniform1i(u.uRipple, bindTex(ripple.read.tex, 1));
    gl.uniform1i(u.uVelocity, bindTex(velocity.read.tex, 2));
    gl.uniform2f(u.uCover, cover[0], cover[1]);
    gl.uniform2f(u.uRes, canvas.width, canvas.height);
    gl.uniform1f(u.uAspect, aspect);
    gl.uniform1f(u.uRefract, CONFIG.REFRACT);
    gl.uniform1f(u.uFlow, CONFIG.FLOW_DISTORT);
    gl.uniform1f(u.uNormalScale, CONFIG.NORMAL_SCALE);
    gl.uniform1f(u.uCaustic, CONFIG.CAUSTIC);
    gl.uniform1f(u.uSpecular, CONFIG.SPECULAR);
    gl.uniform1f(u.uShininess, CONFIG.SHININESS);
    gl.uniform1f(u.uFresnel, CONFIG.FRESNEL);
    gl.uniform1f(u.uFoamOpacity, CONFIG.FOAM_OPACITY);
    gl.uniform1f(u.uSharpen, CONFIG.SHARPEN);
    gl.uniform1f(u.uSaturation, CONFIG.SATURATION);
    gl.uniform1f(u.uBrightness, CONFIG.BRIGHTNESS);
    gl.uniform1f(u.uFinal, final ? 1 : 0);
    blit(target);
  }

  function buildBlur() {
    gl.useProgram(progDown.p);
    gl.uniform2f(progDown.u.uTexel, 1 / canvas.width, 1 / canvas.height);
    gl.uniform1i(progDown.u.uTexture, bindTex(scene.tex, 0));
    blit(blurA);

    gl.uniform2f(progDown.u.uTexel, blurA.texelX, blurA.texelY);
    gl.uniform1i(progDown.u.uTexture, bindTex(blurA.tex, 0));
    blit(blurB);

    gl.useProgram(progBlur.p);
    gl.uniform2f(progBlur.u.uTexel, blurB.texelX, blurB.texelY);
    gl.uniform1i(progBlur.u.uTexture, bindTex(blurB.tex, 0));
    gl.uniform2f(progBlur.u.uDir, blurB.texelX, 0);
    blit(blurC);

    gl.uniform1i(progBlur.u.uTexture, bindTex(blurC.tex, 0));
    gl.uniform2f(progBlur.u.uDir, 0, blurC.texelY);
    blit(blurB);
  }

  var gRect = new Float32Array(MAXF * 4);
  var gRot  = new Float32Array(MAXF * 4);
  var gOpt  = new Float32Array(MAXF * 4);

  function renderGlass() {
    var s = canvas.width / window.innerWidth;
    var H = canvas.height;
    for (var i = 0; i < MAXF; i++) {
      var b = i * 4;
      if (i < floaters.length && floaters[i].glass) {
        var f = floaters[i];
        var cx = (f.bx + f.ox) * s;
        var cy = H - (f.by + f.oy) * s;
        var a = -f.rz * Math.PI / 180;
        gRect[b] = cx; gRect[b + 1] = cy;
        gRect[b + 2] = f.bw * 0.5 * s; gRect[b + 3] = f.bh * 0.5 * s;
        gRot[b] = Math.cos(a); gRot[b + 1] = Math.sin(a);
        gRot[b + 2] = f.radius * s; gRot[b + 3] = 1;
        gOpt[b] = CONFIG.GLASS_THICK * s;
        gOpt[b + 1] = -f.ty * 1.6 * s;
        gOpt[b + 2] = -f.tx * 1.6 * s;
        gOpt[b + 3] = CONFIG.GLASS_FROST;
      } else {
        gRot[b + 3] = 0;
      }
    }

    var u = progGlass.u;
    gl.useProgram(progGlass.p);
    gl.uniform2f(u.uTexel, 1 / canvas.width, 1 / canvas.height);
    gl.uniform1i(u.uScene, bindTex(scene.tex, 0));
    gl.uniform1i(u.uBlur, bindTex(blurB.tex, 1));
    gl.uniform2f(u.uRes, canvas.width, canvas.height);
    gl.uniform4fv(u.uGRect, gRect);
    gl.uniform4fv(u.uGRot, gRot);
    gl.uniform4fv(u.uGOpt, gOpt);
    gl.uniform1f(u.uBevel, CONFIG.GLASS_BEVEL * s);
    gl.uniform1f(u.uIor, CONFIG.GLASS_IOR);
    gl.uniform1f(u.uDisperse, CONFIG.GLASS_DISPERSE);
    gl.uniform1f(u.uEdgeFrost, CONFIG.GLASS_EDGE_FROST);
    gl.uniform1f(u.uReflect, CONFIG.GLASS_REFLECT);
    gl.uniform1f(u.uSpec, CONFIG.GLASS_SPEC);
    gl.uniform1f(u.uEdge, CONFIG.GLASS_EDGE);
    gl.uniform1f(u.uGain, CONFIG.GLASS_GAIN);
    gl.uniform1f(u.uAbsorb, CONFIG.GLASS_ABSORB);
    gl.uniform1f(u.uShadow, CONFIG.GLASS_SHADOW);
    gl.uniform1f(u.uCaustic, CONFIG.GLASS_CAUSTIC);
    blit(null);
  }

  function draw() {
    var useGlass = glassOK && floaters.length > 0;
    if (!useGlass) { renderWater(null, true); return; }
    renderWater(scene, false);
    buildBlur();
    renderGlass();
  }

  /* --------------------------------------------------------------- ループ */
  var STEP = 1 / 60, acc = 0, last = performance.now(), raf = 0;
  var running = true, shown = false, smoothDt = 16.7, slowFrames = 0;
  var nextDrop = last + 5000 + Math.random() * 3000;
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var needMeasure = true;

  function frame(now) {
    raf = requestAnimationFrame(frame);
    var dt = (now - last) / 1000; last = now;
    if (dt > 0.25) dt = 0.25;
    smoothDt = smoothDt * 0.92 + dt * 1000 * 0.08;

    if (needMeasure) { measure(); needMeasure = false; }

    pollProbe();
    consumePointer(dt);

    for (var i = delayed.length - 1; i >= 0; i--) {
      if (now >= delayed[i].t) {
        var d = delayed[i];
        queueRipple(d.x, d.y, d.a, d.r, d.f, d.g);
        delayed.splice(i, 1);
      }
    }

    if (CONFIG.AUTO_DROPS && now > nextDrop) {
      nextDrop = now + 4500 + Math.random() * 5000;
      if (now - lastInput > 2500) {
        dropAt(0.1 + Math.random() * 0.8, 0.1 + Math.random() * 0.8, 0.13 + Math.random() * 0.08);
      }
    }

    if (glassOK) updateFloaters(Math.min(dt, 0.033));

    flushSplats();

    acc += dt;
    var st = 0;
    while (acc >= STEP && st < 3) { step(STEP); acc -= STEP; st++; }
    if (acc > STEP * 3) acc = 0;

    draw();
    if (glassOK && floaters.length) probePass();

    if (!shown && bgReady) { shown = true; canvas.classList.add('ready'); }

    if (smoothDt > 30 && downgrades < 2) {
      if (++slowFrames > 100) { slowFrames = 0; downgrades++; quality *= 0.8; resize(); needMeasure = true; }
    } else if (slowFrames > 0) { slowFrames--; }
  }

  function start() { if (!raf) { last = performance.now(); acc = 0; raf = requestAnimationFrame(frame); } }
  function stop() { if (raf) { cancelAnimationFrame(raf); raf = 0; } }

  var resizeTimer = 0;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { resize(); needMeasure = true; }, 140);
  }, { passive: true });

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) stop(); else if (running) start();
  });

  /* --------------------------------------------------------------- 外部API
     script.js からフローター（ビート板）の再収集や、音声解析に連動した
     波紋・水流の発生をトリガーするための橋渡し。WebGL 初期化に成功した
     場合のみ、このオブジェクトが「本物」に差し替わる。                */
  window.LiquidBG = {
    ready: true,
    isGlassOK: function () { return glassOK; },
    /* data-float / data-glass を付け替えた後に呼ぶ：フローター再収集＋再計測 */
    refresh: function () { collectFloaters(); needMeasure = true; },
    remeasure: function () { needMeasure = true; },
    /* uv 座標（x:0-1 左→右, y:0-1 下→上）に波紋を1発 */
    ripple: function (x, y, amp, radius, foam, ring) {
      queueRipple(x, y, amp, radius || CONFIG.RIPPLE_RADIUS, foam || 0, ring || 0);
    },
    /* uv 座標に流れ（速度）を加える。音の低域や動きで水を「流す」用途 */
    splat: function (x, y, fx, fy, radius) {
      queueVel(x, y, fx, fy, radius || CONFIG.SPLAT_RADIUS);
    },
    /* 一滴落ちたような波紋（強さ s: 0-1程度） */
    dropAt: function (x, y, s) { dropAt(x, y, s); },
    setEnabled: function (on) {
      running = !!on;
      if (running) start(); else { stop(); draw(); }
    }
  };

  /* --------------------------------------------------------------- 起動 */
  collectFloaters();
  resize();
  measure();
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(function () { needMeasure = true; });
  }
  window.addEventListener('load', function () { needMeasure = true; }, { passive: true });

  if (reduceMotion) {
    running = false;
    (function once() {
      draw();
      if (!shown && bgReady) { shown = true; canvas.classList.add('ready'); }
      else if (!bgReady) setTimeout(once, 120);
    })();
  } else {
    start();
  }
})();
