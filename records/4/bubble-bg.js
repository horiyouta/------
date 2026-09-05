/* ============================================================================
   bubble-bg.js — DREAM CYBER BUBBLE（背景レイヤー専用・軽量版）
   ----------------------------------------------------------------------------
   dreamy-cyber-bubbles.html から、調整用UI・マウスによるカメラ操作・
   診断/エラーパネルを取り除き、Python(機械学習) + 人手調整で確定した
   固定パラメータのみで動かす版。horiyouta のホームページでは、この
   canvas (#bubbleGl) がまず単独でアニメーションを描画し、その上に
   liquid-bg.js の Navier-Stokes 流体シミュレーションが「水として」
   かき混ぜる、という二重構造の一番奥のレイヤーになる。

   画面には一切表示されないオフスクリーンのソースレイヤーで、liquid-bg.js が
   毎フレーム #bubbleGl をテクスチャとして読み取り、水面シェーダに渡す
   （#liquid だけが実際に画面へ描かれる）。

   以前は「事前レンダリングした mp4 を最初に見せている間に、この裏で
   重いシェーダコンパイルを済ませる」という事前レンダリング動画＋
   クロスフェード方式（bg-crossfade.js）を使っていたが、実測したところ
   このスクリプト自体の初期化は動画の長さ(10秒)よりずっと短く終わって
   おり、逆に動画ファイルのダウンロード/デコードが初期表示の帯域・
   メインスレッドを奪って全体を遅くしていた。そのため事前レンダリング
   動画・クロスフェードの仕組みは完全に廃止し、boot() が終わり次第
   即座に実描画を開始する、以前よりシンプルな方式に戻した。

   固定パラメータ（もう調整しない。将来値を変える場合はここだけ触ればよい）:
     exposure=0.4805  saturation=1.1722 bloom=1.1666    hueBias=0.0036
     violetBoost=2.0  glintCount=14.1083 glintCore=1.0418 glintHalo=1.0135
     glintSize=0.6043 film=0.9887      ior=1.3380       wobble=0.9722
     fuse=0.5347      count=9.9549 (→ 10個に丸め)

   window.BubbleBG （liquid-bg.js から参照される最小限の外部インターフェース）:
     .canvas : 描画先 <canvas> 要素（背景テクスチャとして毎フレーム読み取られる）
     .ready  : 初回フレームを描画し終えたら true
     .tick   : 描画フレーム数（更新検知用。基本的には liquid-bg.js 側は
               毎フレーム texImage2D するだけなので必須ではないが、
               デバッグ・将来の最適化のために公開しておく）
   ========================================================================= */
window.BubbleBG = window.BubbleBG || { canvas: null, ready: false, tick: 0 };

(function(){
'use strict';

/* boot() に本体を丸ごと入れて呼び出しを1〜2フレーム遅らせることで、
   このあとに続く重いシェーダコンパイル等が原因で最初のペイントが
   ブロックされないようにする（= 事前レンダリング動画やナビゲーション
   バーなど、他の画面要素を先に表示させるための措置）。 */
function boot(){

/* ============================================================
   0. canvas 取得/生成
   ============================================================ */
const canvas = document.getElementById('bubbleGl') || (function(){
  const c = document.createElement('canvas');
  c.id = 'bubbleGl';
  document.body.insertBefore(c, document.body.firstChild);
  return c;
})();
window.BubbleBG.canvas = canvas;

/* 背景レイヤーとしてのみ使うため、フルDPRで描く必要はない。
   この上に liquid-bg.js の流体歪みが被さり最終的に画面へ出るため、
   内部解像度を多少落としても仕上がりの差はごくわずか。その代わり
   GPU負荷・FBO確保コストを大きく削減できる
   （= 起動直後のカクつき/初期化コストを短縮する本質的な変更点）。
   数値を上げれば元のフル解像度寄りの絵にできる。 */
const RES_CONFIG = { DPR_MAX: 0.75, MAX_SHORT_SIDE: 450 };

/* ============================================================
   1. WebGL2 コンテキスト取得
   ------------------------------------------------------------
   背景装飾なので、取得に失敗しても致命エラー画面は出さず、
   黙って無効化する（liquid-bg.js 側が .custom-bg のCSSフォールバック
   グラデーションで受け止める）。
   ============================================================ */
const ATTEMPTS = [
  { antialias:false, alpha:false, depth:false, stencil:false, powerPreference:'high-performance', preserveDrawingBuffer: !!window.BG_PRESERVE_DRAWING_BUFFER },
  { antialias:false, alpha:false, depth:false, stencil:false, preserveDrawingBuffer: !!window.BG_PRESERVE_DRAWING_BUFFER },
  { antialias:false, preserveDrawingBuffer: !!window.BG_PRESERVE_DRAWING_BUFFER },
  { preserveDrawingBuffer: !!window.BG_PRESERVE_DRAWING_BUFFER }
];
let gl = null;
for(let i=0;i<ATTEMPTS.length;i++){
  try{ gl = canvas.getContext('webgl2', ATTEMPTS[i]); }catch(e){}
  if(gl) break;
}
if(!gl){
  console.warn('[bubble-bg] WebGL2 is unavailable — falling back to the CSS gradient background.');
  return;
}

/* ============================================================
   2. シェーダ compile/link ヘルパ
   ============================================================ */
function compile(type, src, name){
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if(!gl.getShaderParameter(s, gl.COMPILE_STATUS)){
    const log = gl.getShaderInfoLog(s) || '(no log)';
    console.error('[bubble-bg] shader compile failed: ' + name + '\n' + log);
    throw new Error('shader compile failed: ' + name);
  }
  return s;
}
function link(vsSrc, fsSrc, name){
  const vs = compile(gl.VERTEX_SHADER, vsSrc, name+':VS');
  const fs = compile(gl.FRAGMENT_SHADER, fsSrc, name+':FS');
  const p = gl.createProgram();
  gl.attachShader(p, vs); gl.attachShader(p, fs);
  gl.linkProgram(p);
  if(!gl.getProgramParameter(p, gl.LINK_STATUS)){
    const log = gl.getProgramInfoLog(p) || '(no log)';
    console.error('[bubble-bg] program link failed: ' + name + '\n' + log);
    throw new Error('program link failed: ' + name);
  }
  gl.deleteShader(vs); gl.deleteShader(fs);
  const P = { p: p, u: {} };
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for(let i=0;i<n;i++){
    const info = gl.getActiveUniform(p, i);
    let nm = info.name.replace(/\[0\]$/, '');
    P.u[nm] = gl.getUniformLocation(p, nm);
  }
  return P;
}

let buildOK = true;
let progMain, progDown, progUp, progComposite, progLine, progDust;

/* MAXB はシェーダ生成にも後続の JS ロジックにも使うため、
   try{} の外側（関数スコープ）で宣言しておく */
const MAXB = 14;

try{

/* ============================================================
   3. シェーダソース（dreamy-cyber-bubbles.html と同一。見た目の
      仕上がりに関わる部分なので変更していない）
   ============================================================ */
const HEAD = `#version 300 es
precision highp float;
precision highp int;
#define PI 3.14159265359
#define TAU 6.28318530718
`;

const LIB = `
float hash11(float p){ p = fract(p*0.1031); p *= p+33.33; p *= p+p; return fract(p); }
float hash13(vec3 p){
  p = fract(p*0.3183099 + vec3(0.71,0.113,0.419));
  p *= 17.0;
  return fract(p.x*p.y*p.z*(p.x+p.y+p.z));
}
float noise3(vec3 x){
  vec3 i = floor(x), f = fract(x);
  f = f*f*(3.0-2.0*f);
  float a = mix(mix(hash13(i+vec3(0,0,0)), hash13(i+vec3(1,0,0)), f.x),
                mix(hash13(i+vec3(0,1,0)), hash13(i+vec3(1,1,0)), f.x), f.y);
  float b = mix(mix(hash13(i+vec3(0,0,1)), hash13(i+vec3(1,0,1)), f.x),
                mix(hash13(i+vec3(0,1,1)), hash13(i+vec3(1,1,1)), f.x), f.y);
  return mix(a,b,f.z);
}
float fbm3(vec3 p){
  float s = 0.0, a = 0.55;
  for(int i=0;i<2;i++){ s += a*noise3(p); p = p*2.05 + vec3(3.1,1.7,9.2); a *= 0.5; }
  return s;
}
vec3 pastelPalette(float t){
  t = fract(t);
  vec3 A = vec3(1.00,0.760,0.520);
  vec3 B = vec3(1.00,0.780,0.900);
  vec3 C = vec3(0.790,0.720,1.000);
  vec3 E = vec3(0.640,0.940,1.000);
  float x = t*4.0; float i = floor(x); float f = smoothstep(0.0,1.0,fract(x));
  vec3 c0,c1;
  if(i<0.5){ c0=A; c1=B; } else if(i<1.5){ c0=B; c1=C; } else if(i<2.5){ c0=C; c1=E; } else { c0=E; c1=A; }
  return mix(c0,c1,f);
}
vec3 orbTerm(vec3 d, vec3 od, vec3 oc, float core, float halo){
  float c = 1.0 - max(dot(d, od), 0.0);
  return oc * (core*exp(-c*950.0) + halo*exp(-c*16.0));
}
vec3 orbCores(vec3 d){
  vec3 s = vec3(0.0);
  s += orbTerm(d, normalize(vec3(-0.53, 0.39,-0.75)), vec3(1.00,0.86,0.72), 4.5, 0.45);
  s += orbTerm(d, normalize(vec3( 0.77, 0.15, 0.62)), vec3(1.00,0.72,0.86), 3.0, 0.34);
  s += orbTerm(d, normalize(vec3( 0.10, 0.84,-0.53)), vec3(0.72,0.95,1.00), 2.6, 0.32);
  return s;
}
/* ---- グリント（大小さまざまな光の粒／ボケハイライト）フィールド ----
   参照画像に散らばる丸いソフトハイライトや小さな星のきらめきを再現する。
   位置・色・サイズはインデックスからハッシュ生成するので JS 側の配列送信は不要。 */
uniform float uGlintCount;
uniform float uGlintCore;
uniform float uGlintHalo;
uniform float uGlintSize;
uniform float uHueBias;
uniform float uVioletBoost;
vec3 glintTerm(vec3 d, vec3 od, vec3 oc, float core, float halo, float coreW, float haloW){
  float c = 1.0 - max(dot(d, od), 0.0);
  return oc * (core*exp(-c*coreW) + halo*exp(-c*haloW));
}
vec3 glintField(vec3 d, float t){
  vec3 s = vec3(0.0);
  int n = int(min(uGlintCount, 24.0));
  for(int i=0;i<6;i++){
    if(i>=n) break;
    float fi = float(i);
    float h1=hash11(fi*12.9+3.1), h2=hash11(fi*7.7+9.3), h3=hash11(fi*5.3+1.7), h4=hash11(fi*3.1+6.6);
    float az = h1*TAU + t*(0.010+0.014*h2);
    float el = (h2-0.5)*PI*0.86;
    vec3 od = normalize(vec3(cos(el)*cos(az), sin(el), cos(el)*sin(az)));
    /* パレットの中でも桜～ラベンダー寄りの帯を優先的に選び、ピンク/パープルの光点を増やす */
    float hueSel = fract(0.62 + h3*0.55 + uHueBias);
    vec3 oc = pastelPalette(hueSel);
    float sizeMix = mix(0.15, 1.0, h4);
    float coreW = mix(2600.0, 260.0, uGlintSize*sizeMix);
    float haloW = mix(60.0, 6.0, uGlintSize*sizeMix);
    float core = uGlintCore*mix(0.5,1.8,h1)*step(0.55,sizeMix);
    float halo = uGlintHalo*mix(0.6,1.6,h2);
    s += glintTerm(d, od, oc, core, halo, coreW, haloW);
  }
  return s;
}
uniform float uTime;
uniform float uFlow;
vec3 bgColor(vec3 d, float speedMul){
  float t = uTime*speedMul*0.45;
  vec3 p = d*2.2 + vec3(0.0, -t*0.02, t*0.03);
  float w1 = fbm3(p*0.80 + vec3(0.0, t*0.045, 0.0));
  float w2 = fbm3(p*0.80 + vec3(5.10, 2.30, 7.40) - vec3(t*0.028, 0.0, 0.0));
  vec3 q  = p + 1.6*vec3(w1, w2, w1*1.1 - w2*0.7);
  float m = fbm3(q*0.85 + vec3(0.0, t*0.02, 0.0));
  m = m*0.75 + w1*0.35 + 0.12;
  float hue = m*1.35 + 0.05*sin(t*0.06) + uHueBias;
  vec3 col = pastelPalette(hue);
  col *= 0.42 + 1.02*smoothstep(0.05,0.95,m);
  col  = mix(col, vec3(1.02,0.98,1.00), 0.10*pow(smoothstep(0.78,1.05,m),2.0));
  col += vec3(0.20,0.10,0.06)*pow(smoothstep(0.62,1.05,m),3.0);
  float lv    = m*22.0 - t*0.35;
  float vein  = smoothstep(0.09, 0.0, abs(fract(lv)-0.5));
  float sfield= w2*8.0 + w1*4.0;
  float pulse = pow(0.5+0.5*sin(sfield*3.0 - t*2.2), 20.0);
  vec3 veinCol= mix(vec3(0.62,0.95,1.00), vec3(1.00,0.80,0.95), 0.5+0.5*sin(m*8.0+t*0.2));
  col += vein*veinCol*(0.08 + 1.1*pulse);
  float fil = smoothstep(0.05,0.0, abs(fract(m*58.0 + t*0.42)-0.5)) * smoothstep(0.30,0.70,m);
  col += fil*vec3(0.80,0.98,1.00)*0.12;
  vec3 g = floor(d*38.0 + 0.5);
  float hs = hash13(g*1.31);
  col += step(0.9965,hs)*(0.5+0.5*sin(t*2.1+hs*66.0))*vec3(1.0)*1.5;
  col *= 0.92 + 0.22*smoothstep(-0.7,0.9,d.y);
  /* ピンク/パープル方向へのティント（彩度ブースト前に効かせる） */
  col = mix(col, col*vec3(1.06,0.90,1.16), clamp(uVioletBoost,0.0,2.0)*0.5);
  float lu = dot(col, vec3(0.299,0.587,0.114));
  col = mix(vec3(lu), col, 1.30);
  return max(col, vec3(0.0));
}
`;

const VS_QUAD = HEAD + `
void main(){
  vec2 p = vec2(float((gl_VertexID<<1)&2), float(gl_VertexID&2));
  gl_Position = vec4(p*2.0-1.0, 0.0, 1.0);
}`;

const FS_MAIN = HEAD + LIB + `
uniform vec2  uRes;
uniform vec3  uCamPos, uRight, uUp, uFwd;
uniform float uFocal;
uniform int   uCount;
uniform vec4  uB[${MAXB}];
uniform vec3  uBoundC;
uniform float uBoundR;
uniform float uK;
uniform float uIOR;
uniform float uWobble;
uniform float uFilm;
uniform float uExposure;
uniform float uSaturation;
out vec4 fragColor;

float smin(float a, float b, float k){
  float h = clamp(0.5 + 0.5*(b-a)/max(k,1e-4), 0.0, 1.0);
  return mix(b,a,h) - k*h*(1.0-h);
}
float sdScene(vec3 p){
  float d = 1e6;
  for(int i=0;i<${MAXB};i++){
    if(i>=uCount) break;
    vec4 b = uB[i];
    d = smin(d, length(p-b.xyz)-b.w, uK);
  }
  d += uWobble*0.05*sin(p.x*1.6+uTime*0.28)*sin(p.y*1.5-uTime*0.21)*sin(p.z*1.7+uTime*0.23);
  return d;
}
vec3 calcNormal(vec3 p){
  const float e = 0.0035;
  vec2 k = vec2(1.0,-1.0);
  vec3 n = k.xyy*sdScene(p+k.xyy*e) + k.yyx*sdScene(p+k.yyx*e)
         + k.yxy*sdScene(p+k.yxy*e) + k.xxx*sdScene(p+k.xxx*e);
  float L = length(n);
  return (L>1e-6) ? n/L : vec3(0.0,1.0,0.0);
}
vec3 iridescence(vec3 p, float cosTheta, vec3 n){
  float base = fbm3(p*3.1 + n*0.6 + uTime*0.022);
  float hue = fract(base*0.9 + cosTheta*0.55 + uTime*0.007);
  return pastelPalette(hue);
}
void main(){
  vec2 fc = gl_FragCoord.xy;
  vec2 uv = (fc - 0.5*uRes)/uRes.y;
  vec3 ro = uCamPos;
  vec3 rd = normalize(uRight*uv.x + uUp*uv.y + uFwd*uFocal);

  vec3 col;
  vec3 oc = ro - uBoundC;
  float bb = dot(oc, rd);
  float cc = dot(oc, oc) - uBoundR*uBoundR;
  float disc = bb*bb - cc;
  bool hit = false;
  vec3 hitP;

  if(disc > 0.0){
    float sq = sqrt(disc);
    float tmin = max(-bb - sq, 0.0);
    float tmax = -bb + sq;
    if(tmax > 0.0){
      float span = max(tmax-tmin, 1e-4);
      float minStp = span*0.006;
      float t = tmin;
      const int MAXSTEP = 16;
      for(int i=0;i<MAXSTEP;i++){
        if(t > tmax) break;
        vec3 p = ro + rd*t;
        float d = sdScene(p);
        if(d < span*0.0015){ hit = true; hitP = p; break; }
        t += max(d*0.6, minStp);
      }
    }
  }

  if(hit){
    vec3 nn = calcNormal(hitP);
    vec3 nf = (dot(nn,rd) > 0.0) ? -nn : nn;
    float cosTheta = clamp(-dot(nf, rd), 0.0, 1.0);

    float F0 = pow((1.0-uIOR)/(1.0+uIOR), 2.0);
    float fres = F0 + (1.0-F0)*pow(1.0-cosTheta, 5.0);

    vec3 irid = mix(vec3(1.0), iridescence(hitP, cosTheta, nf), clamp(uFilm,0.0,2.5));

    vec3 reflDir = reflect(rd, nf);
    vec3 refrDir = refract(rd, nf, 1.0/uIOR);
    if(dot(refrDir,refrDir) < 0.25) refrDir = reflDir;

    vec3 reflCol = bgColor(reflDir, uFlow) + orbCores(reflDir) + glintField(reflDir, uTime);
    vec3 refrCol = bgColor(refrDir, uFlow) + glintField(refrDir, uTime)*0.4;

    col = mix(refrCol*mix(vec3(1.0), irid, 0.35), reflCol*irid, fres);
    col += pow(1.0-cosTheta, 3.0)*irid*0.55;

    float sparkle = pow(fbm3(hitP*9.0 + uTime*0.14), 10.0);
    col += sparkle*irid*3.0*fres;
  } else {
    col = bgColor(rd, uFlow) + orbCores(rd) + glintField(rd, uTime);
  }

  {
    float lu = dot(col, vec3(0.299,0.587,0.114));
    col = mix(vec3(lu), col, uSaturation);
  }
  col *= uExposure;
  col = col/(1.0+col);
  col = pow(clamp(col,0.0,1.0), vec3(1.0/2.2));
  fragColor = vec4(col, 1.0);
}`;

const FS_DOWN = HEAD + `
uniform sampler2D uTex;
uniform vec2 uRes, uTexel;
uniform float uFirst, uThreshold, uKnee;
out vec4 fragColor;
vec3 T(vec2 o){ return texture(uTex, (gl_FragCoord.xy/uRes) + o*uTexel).rgb; }
void main(){
  vec3 a=T(vec2(-2.0,2.0)), b=T(vec2(0.0,2.0)), c=T(vec2(2.0,2.0));
  vec3 d=T(vec2(-2.0,0.0)), e=T(vec2(0.0,0.0)), f=T(vec2(2.0,0.0));
  vec3 g=T(vec2(-2.0,-2.0)), h=T(vec2(0.0,-2.0)), i=T(vec2(2.0,-2.0));
  vec3 j=T(vec2(-1.0,1.0)), k=T(vec2(1.0,1.0)), l=T(vec2(-1.0,-1.0)), m=T(vec2(1.0,-1.0));
  vec3 col = e*0.125 + (a+c+g+i)*0.03125 + (b+d+f+h)*0.0625 + (j+k+l+m)*0.125;
  if(uFirst > 0.5){
    float br = max(col.r, max(col.g,col.b));
    float kn = max(uThreshold*uKnee, 1e-4);
    float soft = clamp(br-uThreshold+kn, 0.0, 2.0*kn);
    soft = soft*soft/(4.0*kn);
    col *= max(soft, br-uThreshold)/max(br,1e-4);
  }
  fragColor = vec4(col, 1.0);
}`;

const FS_UP = HEAD + `
uniform sampler2D uTex;
uniform vec2 uRes, uTexel;
uniform float uAniso;
out vec4 fragColor;
vec3 T(vec2 o){ return texture(uTex, (gl_FragCoord.xy/uRes) + o*vec2(uTexel.x*uAniso, uTexel.y)).rgb; }
void main(){
  vec3 s = T(vec2(-1.0,1.0))*1.0 + T(vec2(0.0,1.0))*2.0 + T(vec2(1.0,1.0))*1.0
         + T(vec2(-1.0,0.0))*2.0 + T(vec2(0.0,0.0))*4.0 + T(vec2(1.0,0.0))*2.0
         + T(vec2(-1.0,-1.0))*1.0 + T(vec2(0.0,-1.0))*2.0 + T(vec2(1.0,-1.0))*1.0;
  fragColor = vec4(s/16.0, 1.0);
}`;

const FS_COMPOSITE = HEAD + `
uniform sampler2D uScene, uBloom;
uniform vec2 uRes;
uniform float uTime, uBloomStr;
out vec4 fragColor;
float hash(vec2 p){ p=fract(p*vec2(123.34,456.21)); p+=dot(p,p+45.32); return fract(p.x*p.y); }
void main(){
  vec2 uv = gl_FragCoord.xy/uRes;
  vec2 dd = uv-0.5;
  float r2 = dot(dd,dd);
  vec3 col = texture(uScene, uv).rgb;
  col += texture(uBloom, uv).rgb*uBloomStr;
  col *= smoothstep(1.05,0.20,r2*1.3)*0.12 + 0.88;
  float gnoise = hash(gl_FragCoord.xy + fract(uTime)*137.0) - 0.5;
  col += gnoise*0.012;
  fragColor = vec4(clamp(col,0.0,1.0), 1.0);
}`;

const VLIB = `float hash11(float p){ p=fract(p*0.1031); p*=p+33.33; p*=p+p; return fract(p); }`;

const VS_LINE = HEAD + VLIB + `
uniform vec3 uCamPos2, uRight2, uUp2, uFwd2;
uniform float uFocal2, uAspect, uTime, uSegs;
out vec3 vCol;
vec3 curvePoint(float id, float u, float t){
  float s = hash11(id*1.7+0.3)*20.0;
  float spin = t*(0.035+0.06*hash11(id+7.3))+s;
  float R = 1.3+2.6*hash11(id+2.1);
  float yspan = 3.2+2.2*hash11(id+5.5);
  float turns = 1.1+2.4*hash11(id+9.9);
  float ang = u*TAU*turns + spin;
  float rr = R*(0.62+0.48*sin(u*4.7+s));
  vec3 p = vec3(cos(ang)*rr, (u-0.5)*yspan+0.5*sin(u*5.0+s), sin(ang)*rr);
  p += 0.4*vec3(sin(u*9.0+t*0.6+s), sin(u*7.0-t*0.5+s*1.7), sin(u*8.0+t*0.55+s*0.3));
  return p;
}
void main(){
  int vid = gl_VertexID;
  float k = float(vid>>1);
  float end = float(vid&1);
  float cid = floor(k/uSegs);
  float sid = k - cid*uSegs;
  float u = (sid+end)/uSegs;
  vec3 P = curvePoint(cid, u, uTime);
  vec3 v = P - uCamPos2;
  float a = dot(v,uRight2), b = dot(v,uUp2), c = dot(v,uFwd2);
  gl_Position = vec4(2.0*uFocal2*a/uAspect, 2.0*uFocal2*b, 0.0, max(c,0.001));
  float ph = fract(u*0.85 - uTime*0.10 + hash11(cid+3.3));
  float pulse = exp(-ph*13.0) + exp(-fract(ph+0.5)*22.0)*0.45;
  float ends = smoothstep(0.0,0.14,u)*smoothstep(1.0,0.86,u);
  float hh = hash11(cid+4.4);
  vec3 base = (hh<0.34) ? vec3(0.62,0.95,1.00) : (hh<0.67) ? vec3(1.00,0.76,0.92) : vec3(0.84,0.78,1.00);
  vCol = base*(0.10+1.7*pulse)*ends*(0.5+0.5*sin(uTime*0.7+cid*3.0));
}`;
const FS_LINE = HEAD + `
in vec3 vCol;
out vec4 fragColor;
void main(){ fragColor = vec4(vCol, 0.0); }`;

const VS_PT = HEAD + VLIB + `
uniform vec3 uCamPos2, uRight2, uUp2, uFwd2;
uniform float uFocal2, uAspect, uTime, uPxScale;
out vec3 vCol;
void main(){
  float id = float(gl_VertexID);
  float h1 = hash11(id*1.13+0.7);
  float h2 = hash11(id*2.31+3.1);
  float h3 = hash11(id*3.77+9.4);
  float h4 = hash11(id*5.19+5.5);
  float rad = 0.9+5.0*h1;
  float ang = h2*TAU + uTime*(0.045+0.06*h4);
  float yy = mod(h3*8.0 + uTime*(0.045+0.08*h2), 8.0) - 4.0;
  vec3 P = vec3(cos(ang)*rad, yy, sin(ang)*rad);
  P += 0.6*vec3(sin(uTime*0.7+h1*30.0), sin(uTime*0.55+h2*22.0), sin(uTime*0.63+h3*17.0));
  vec3 v = P - uCamPos2;
  float a = dot(v,uRight2), b = dot(v,uUp2), c = dot(v,uFwd2);
  gl_Position = vec4(2.0*uFocal2*a/uAspect, 2.0*uFocal2*b, 0.0, max(c,0.001));
  gl_PointSize = clamp(uPxScale*(0.5+1.6*h4)/max(c,0.15), 1.0, 30.0);
  float tw = pow(0.5+0.5*sin(uTime*0.9+h1*60.0), 3.0);
  vec3 base = (h2<0.34) ? vec3(1.00,0.86,0.94) : (h2<0.67) ? vec3(0.76,0.96,1.00) : vec3(0.92,0.86,1.00);
  vCol = base*(0.15+1.3*tw)*(0.35+0.65*h1);
}`;
const FS_PT = HEAD + `
in vec3 vCol;
out vec4 fragColor;
void main(){
  vec2 q = gl_PointCoord-0.5;
  float r2 = dot(q,q)*4.0;
  if(r2>1.0) discard;
  float a = exp(-r2*3.2)*(1.0-r2*r2);
  fragColor = vec4(vCol*a, 0.0);
}`;

progMain      = link(VS_QUAD, FS_MAIN, 'main');
progDown      = link(VS_QUAD, FS_DOWN, 'down');
progUp        = link(VS_QUAD, FS_UP, 'up');
progComposite = link(VS_QUAD, FS_COMPOSITE, 'composite');
progLine      = link(VS_LINE, FS_LINE, 'line');
progDust      = link(VS_PT, FS_PT, 'dust');
}catch(e){
  buildOK = false;
  console.error('[bubble-bg] shader build failed: ' + e.message);
}
if(!buildOK) return;

/* ============================================================
   4. FBO ヘルパ（RGBA8 のみ — 追加拡張チェック不要）
   ============================================================ */
const vao = gl.createVertexArray();
gl.bindVertexArray(vao);
function drawQuad(){ gl.drawArrays(gl.TRIANGLES, 0, 3); }

function makeRT(w, h){
  w = Math.max(1, w|0); h = Math.max(1, h|0);
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if(status !== gl.FRAMEBUFFER_COMPLETE){
    console.warn('[bubble-bg] FBO incomplete (' + w + 'x' + h + '): status ' + status);
  }
  return { tex, fb, w, h };
}

let W=0, H=0, rtScene=null, rtBloom=[];
function buildTargets(w, h){
  W=w; H=h;
  rtScene = makeRT(w, h);
  rtBloom = [];
  let bw = Math.max(4, w>>1), bh = Math.max(4, h>>1);
  for(let i=0;i<4;i++){
    rtBloom.push(makeRT(bw, bh));
    bw = Math.max(4, bw>>1); bh = Math.max(4, bh>>1);
  }
}

/* ============================================================
   5. バブル物理（CPU側の軽量シミュレーション）
   ============================================================ */
const MAXB_JS = MAXB;
let bub = [];
let currentSeed = null;
function mulberry32(seed){
  let a = seed >>> 0;
  return function(){
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function initBubbles(n, seed){
  const rnd = (seed===undefined || seed===null) ? Math.random : mulberry32(seed);
  if(seed!==undefined && seed!==null) currentSeed = seed;
  bub = [];
  for(let i=0;i<n;i++){
    const theta = rnd()*Math.PI*2, phi = Math.acos(2*rnd()-1);
    const rad = rnd()*1.5;
    bub.push({
      x: rad*Math.sin(phi)*Math.cos(theta),
      y: rad*Math.sin(phi)*Math.sin(theta),
      z: rad*Math.cos(phi),
      vx:(rnd()-0.5)*0.4, vy:(rnd()-0.5)*0.4, vz:(rnd()-0.5)*0.4,
      r: 0.32 + rnd()*0.55,
      seed: rnd()*1000
    });
  }
}
function stepBubbles(dt, t){
  const BOUND = 2.05;
  for(let i=0;i<bub.length;i++){
    const b = bub[i];
    b.vx += Math.sin(b.y*0.6+t*0.35+b.seed)*0.02*dt;
    b.vy += Math.sin(b.z*0.6+t*0.31+b.seed*1.3)*0.02*dt;
    b.vz += Math.sin(b.x*0.6+t*0.28+b.seed*0.7)*0.02*dt;
    b.vx*=0.986; b.vy*=0.986; b.vz*=0.986;
  }
  for(let i=0;i<bub.length;i++){
    for(let j=i+1;j<bub.length;j++){
      const a=bub[i], c=bub[j];
      let dx=a.x-c.x, dy=a.y-c.y, dz=a.z-c.z;
      const d = Math.sqrt(dx*dx+dy*dy+dz*dz) || 1e-4;
      const minD = (a.r+c.r)*0.82;
      if(d<minD){
        const f = (minD-d)/minD*0.6;
        dx/=d; dy/=d; dz/=d;
        a.vx+=dx*f*dt; a.vy+=dy*f*dt; a.vz+=dz*f*dt;
        c.vx-=dx*f*dt; c.vy-=dy*f*dt; c.vz-=dz*f*dt;
      }
    }
  }
  for(let i=0;i<bub.length;i++){
    const b = bub[i];
    b.x += b.vx*dt; b.y += b.vy*dt; b.z += b.vz*dt;
    const d = Math.sqrt(b.x*b.x+b.y*b.y+b.z*b.z);
    const maxD = BOUND - b.r*0.5;
    if(d > maxD && d > 1e-5){
      const nx=b.x/d, ny=b.y/d, nz=b.z/d;
      b.x=nx*maxD; b.y=ny*maxD; b.z=nz*maxD;
      const vn = b.vx*nx+b.vy*ny+b.vz*nz;
      b.vx -= 1.7*vn*nx; b.vy -= 1.7*vn*ny; b.vz -= 1.7*vn*nz;
      b.vx*=0.55; b.vy*=0.55; b.vz*=0.55;
    }
  }
}

/* ============================================================
   6. カメラ（固定。マウスドラッグ/ホイールでの操作は撤去 —
      背景レイヤーなのでユーザー入力を奪う必要がない）
   ============================================================ */
let yaw = 0.5, pitch = 0.28, dist = 4.4;
let autoYaw = 0;

/* ============================================================
   7. パラメータ（Python最適化 + 人手調整で確定した固定値）
   ------------------------------------------------------------
   ?exposure=0.4805&saturation=1.1722&bloom=1.1666&hueBias=0.0036
   &violetBoost=2.0000&glintCount=14.1083&glintCore=1.0418
   &glintHalo=1.0135&glintSize=0.6043&film=0.9887&ior=1.3380
   &wobble=0.9722&fuse=0.5347&count=9.9549
   count はバブル生成数として整数が必要なため、ここで一度だけ丸める
   （UIが無いので実行中に変わることはない）。
   flow / spin / quality は最適化対象に含まれていなかったため、
   dreamy-cyber-bubbles.html のデフォルト値をそのまま踏襲している。
   ============================================================ */
const params = {
  count: 10,          // = Math.round(9.9549)
  fuse: 0.5347,
  ior: 1.3380,
  wobble: 0.9722,
  film: 0.9887,
  flow: 1.0,
  spin: 1.0,
  exposure: 0.4805,
  bloom: 1.1666,
  quality: 0.75,
  saturation: 1.1722,
  hueBias: 0.0036,
  violetBoost: 2.0000,
  glintCount: 14.1083,
  glintCore: 1.0418,
  glintHalo: 1.0135,
  glintSize: 0.6043
};
const toggles = { rotate: true, lines: true, dust: true, paused: false };

/* ============================================================
   7b. 初期配置の乱数シード
   ------------------------------------------------------------
   バブル初期配置の乱数シード。prerender_bg.py など他のハーネス側と
   揃えたい場合のために window.BG_FIXED_SEED で上書き可能にしてある。
   ============================================================ */
const FIXED_SEED = (typeof window.BG_FIXED_SEED === 'number') ? window.BG_FIXED_SEED : 20260901;

initBubbles(params.count, FIXED_SEED);

/* ============================================================
   8. リサイズ（背景専用に内部解像度を抑える）
   ============================================================ */
function resize(){
  const cw = Math.max(1, Math.floor(window.innerWidth));
  const ch = Math.max(1, Math.floor(window.innerHeight));
  canvas.style.width = cw+'px'; canvas.style.height = ch+'px';

  const dpr = Math.min(window.devicePixelRatio||1, RES_CONFIG.DPR_MAX);
  let bw = Math.max(1, Math.round(cw*dpr));
  let bh = Math.max(1, Math.round(ch*dpr));
  const shortSide = Math.min(bw,bh);
  if(shortSide > RES_CONFIG.MAX_SHORT_SIDE){
    const s = RES_CONFIG.MAX_SHORT_SIDE/shortSide;
    bw = Math.max(1, Math.round(bw*s));
    bh = Math.max(1, Math.round(bh*s));
  }
  canvas.width = bw; canvas.height = bh;

  const w = Math.max(1, Math.floor(canvas.width * params.quality));
  const h = Math.max(1, Math.floor(canvas.height * params.quality));
  buildTargets(w, h);
}
window.addEventListener('resize', resize);
/* ============================================================
   9. メインループ
   ============================================================ */
let simTime = 0, prevTs = performance.now();
const arrB = new Float32Array(MAXB*4);
const SEGS = 26, LINE_CURVES = 7, LINE_VERTS = LINE_CURVES*SEGS*2, PT_COUNT = 260;

function renderPass(dt){
  if(toggles.rotate) autoYaw += dt*0.005*params.spin;
  const cy = yaw+autoYaw, cp = pitch;
  const px = Math.sin(cy)*Math.cos(cp)*dist, py = Math.sin(cp)*dist, pz = Math.cos(cy)*Math.cos(cp)*dist;
  const fx=-px/dist, fy=-py/dist, fz=-pz/dist;
  const upTmp = [0,1,0];
  let rx = fy*upTmp[2]-fz*upTmp[1], ry = fz*upTmp[0]-fx*upTmp[2], rz = fx*upTmp[1]-fy*upTmp[0];
  const rl = Math.hypot(rx,ry,rz)||1; rx/=rl; ry/=rl; rz/=rl;
  const ux = ry*fz-rz*fy, uy = rz*fx-rx*fz, uz = rx*fy-ry*fx;
  const FOCAL = 1.55;

  stepBubbles(dt, simTime);
  let bound = {x:0,y:0,z:0,r:0.5};
  {
    let mx=0,my=0,mz=0;
    for(let i=0;i<bub.length;i++){ mx+=bub[i].x; my+=bub[i].y; mz+=bub[i].z; }
    if(bub.length){ mx/=bub.length; my/=bub.length; mz/=bub.length; }
    let mr=0.6;
    for(let i=0;i<bub.length;i++){
      const b=bub[i];
      const d = Math.hypot(b.x-mx,b.y-my,b.z-mz)+b.r;
      if(d>mr) mr=d;
    }
    bound = {x:mx,y:my,z:mz,r:mr+0.6};
  }
  arrB.fill(0);
  const n = Math.min(params.count|0, bub.length, MAXB);
  for(let i=0;i<n;i++){
    arrB[i*4+0]=bub[i].x; arrB[i*4+1]=bub[i].y; arrB[i*4+2]=bub[i].z; arrB[i*4+3]=bub[i].r;
  }

  gl.bindVertexArray(vao);

  /* pass 1: main scene */
  gl.disable(gl.BLEND);
  gl.bindFramebuffer(gl.FRAMEBUFFER, rtScene.fb);
  gl.viewport(0,0,W,H);
  {
    const P = progMain;
    gl.useProgram(P.p);
    gl.uniform2f(P.u.uRes, W, H);
    gl.uniform1f(P.u.uTime, simTime);
    gl.uniform1f(P.u.uFlow, params.flow);
    gl.uniform3f(P.u.uCamPos, px,py,pz);
    gl.uniform3f(P.u.uRight, rx,ry,rz);
    gl.uniform3f(P.u.uUp, ux,uy,uz);
    gl.uniform3f(P.u.uFwd, fx,fy,fz);
    gl.uniform1f(P.u.uFocal, FOCAL);
    gl.uniform1i(P.u.uCount, n);
    gl.uniform4fv(P.u.uB, arrB);
    gl.uniform3f(P.u.uBoundC, bound.x, bound.y, bound.z);
    gl.uniform1f(P.u.uBoundR, bound.r);
    gl.uniform1f(P.u.uK, params.fuse);
    gl.uniform1f(P.u.uIOR, params.ior);
    gl.uniform1f(P.u.uWobble, params.wobble);
    gl.uniform1f(P.u.uFilm, params.film);
    gl.uniform1f(P.u.uExposure, params.exposure);
    gl.uniform1f(P.u.uSaturation, params.saturation);
    gl.uniform1f(P.u.uHueBias, params.hueBias);
    gl.uniform1f(P.u.uVioletBoost, params.violetBoost);
    gl.uniform1f(P.u.uGlintCount, params.glintCount);
    gl.uniform1f(P.u.uGlintCore, params.glintCore);
    gl.uniform1f(P.u.uGlintHalo, params.glintHalo);
    gl.uniform1f(P.u.uGlintSize, params.glintSize);
    drawQuad();
  }

  /* pass 2: additive lines + dust straight into scene target */
  if(toggles.lines || toggles.dust){
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    const aspect = W/H;
    if(toggles.lines){
      const P = progLine;
      gl.useProgram(P.p);
      gl.uniform3f(P.u.uCamPos2, px,py,pz);
      gl.uniform3f(P.u.uRight2, rx,ry,rz);
      gl.uniform3f(P.u.uUp2, ux,uy,uz);
      gl.uniform3f(P.u.uFwd2, fx,fy,fz);
      gl.uniform1f(P.u.uFocal2, FOCAL);
      gl.uniform1f(P.u.uAspect, aspect);
      gl.uniform1f(P.u.uTime, simTime);
      gl.uniform1f(P.u.uSegs, SEGS);
      gl.drawArrays(gl.LINES, 0, LINE_VERTS);
    }
    if(toggles.dust){
      const P = progDust;
      gl.useProgram(P.p);
      gl.uniform3f(P.u.uCamPos2, px,py,pz);
      gl.uniform3f(P.u.uRight2, rx,ry,rz);
      gl.uniform3f(P.u.uUp2, ux,uy,uz);
      gl.uniform3f(P.u.uFwd2, fx,fy,fz);
      gl.uniform1f(P.u.uFocal2, FOCAL);
      gl.uniform1f(P.u.uAspect, aspect);
      gl.uniform1f(P.u.uTime, simTime);
      gl.uniform1f(P.u.uPxScale, H*0.010);
      gl.drawArrays(gl.POINTS, 0, PT_COUNT);
    }
    gl.disable(gl.BLEND);
  }

  /* pass 3: bloom (down chain with threshold, then up chain additive) */
  gl.useProgram(progDown.p);
  gl.uniform1i(progDown.u.uTex, 0);
  gl.uniform1f(progDown.u.uThreshold, 0.85);
  gl.uniform1f(progDown.u.uKnee, 0.7);
  gl.activeTexture(gl.TEXTURE0);
  for(let i=0;i<rtBloom.length;i++){
    const src = (i===0) ? rtScene : rtBloom[i-1], dst = rtBloom[i];
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb);
    gl.viewport(0,0,dst.w,dst.h);
    gl.bindTexture(gl.TEXTURE_2D, src.tex);
    gl.uniform2f(progDown.u.uRes, dst.w, dst.h);
    gl.uniform2f(progDown.u.uTexel, 1/src.w, 1/src.h);
    gl.uniform1f(progDown.u.uFirst, i===0 ? 1.0 : 0.0);
    drawQuad();
  }
  gl.useProgram(progUp.p);
  gl.uniform1i(progUp.u.uTex, 0);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE);
  for(let i=rtBloom.length-1;i>0;i--){
    const src = rtBloom[i], dst = rtBloom[i-1];
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb);
    gl.viewport(0,0,dst.w,dst.h);
    gl.bindTexture(gl.TEXTURE_2D, src.tex);
    gl.uniform2f(progUp.u.uRes, dst.w, dst.h);
    gl.uniform2f(progUp.u.uTexel, 1/src.w, 1/src.h);
    gl.uniform1f(progUp.u.uAniso, 1.0 + 1.5*(i/rtBloom.length));
    drawQuad();
  }
  gl.disable(gl.BLEND);

  /* pass 4: composite to canvas */
  {
    const P = progComposite;
    gl.useProgram(P.p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0,0,canvas.width, canvas.height);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, rtScene.tex);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, rtBloom[0].tex);
    gl.uniform1i(P.u.uScene, 0);
    gl.uniform1i(P.u.uBloom, 1);
    gl.uniform2f(P.u.uRes, canvas.width, canvas.height);
    gl.uniform1f(P.u.uTime, simTime);
    gl.uniform1f(P.u.uBloomStr, params.bloom);
    drawQuad();
  }

  renderTick++;
  window.BubbleBG.tick = renderTick;
  if(!window.BubbleBG.ready) window.BubbleBG.ready = true;
}

function frame(ts){
  raf = requestAnimationFrame(frame);
  let dt = Math.min(0.05, (ts-prevTs)/1000); prevTs = ts;
  if(toggles.paused) dt = 0;
  simTime += dt;
  renderPass(dt);
}

/* ============================================================
   10. 起動 / 表示状態に応じた一時停止
   ============================================================ */
let renderTick = 0;
let raf = 0;
function startLoop(){ if(!raf){ prevTs = performance.now(); raf = requestAnimationFrame(frame); } }
function stopLoop(){ if(raf){ cancelAnimationFrame(raf); raf = 0; } }
document.addEventListener('visibilitychange', function(){
  if(document.hidden) stopLoop(); else if(revealed) startLoop();
});

resize();

/* ============================================================
   11. 起動
   ------------------------------------------------------------
   以前はここで「事前レンダリング mp4 の長さぶん物理演算を早送りし、
   bg-crossfade.js から beginReveal() が呼ばれるまで時間を凍結する」
   処理を挟んでいたが、事前レンダリング動画そのものを廃止したため、
   boot() が終わり次第すぐ実時間でアニメーションループを開始する。
   window.BubbleBG.ready は最初の renderPass() が終わった時点
   （frame() の初回呼び出し内）で自動的に立つので、liquid-bg.js は
   それを検知した瞬間から #bubbleGl を背景として読み取り始める。
   ============================================================ */
let revealed = true;
startLoop();

} /* end boot() */

if('requestIdleCallback' in window){
  requestAnimationFrame(function(){ requestIdleCallback(boot, {timeout: 300}); });
}else{
  requestAnimationFrame(function(){ requestAnimationFrame(boot); });
}

})();