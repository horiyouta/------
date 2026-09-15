/* ============================================================================
   bubble-bg.js — DREAM CYBER BUBBLE v2（背景レイヤー専用・軽量HDR版）
   ----------------------------------------------------------------------------
   horiyouta のホームページ最奥レイヤー。#bubbleGl にオフスクリーン描画し、
   liquid-bg.js が毎フレームテクスチャとして読み取る（画面には #liquid のみ）。

   v2 での主な変更（見た目は大幅強化、コストは旧版と同等以下）:
     * 背景の墨流しは 512x256 の等距円筒「環境マップ」に毎フレーム1回だけ描画。
       画面側・反射・屈折は全てテクスチャ参照になり、旧版で最重量だった
       「毎ピクセル×2回の fbm」が消える。浮いた予算で fbm を 4 オクターブ×3段
       ドメインワープに増強。細い脈は環境マップ α に焼いたスカラー場から
       ピクセル単位で解析復元（fwidth で AA）するので低解像度でも鮮明。
     * シャボン玉: 薄膜干渉（光路差→3波長）＋パステル化、表面/裏面の2重ハイ
       ライト、内部再マーチによる出射屈折、薄膜(直進)と水滴(屈折)のブレンド。
     * 光: カメラ追従キーライト + 世界固定2灯、解析的コア、ソフトハロー、
       被写界深度連動ボケ玉、放射状ライトシャフト、シルエットのリムライト。
     * サイバー線: グロー付きリボン、信号パケット、屈折歪みを受ける。
     * EXT_color_buffer_float があれば RGBA16F の HDR パイプライン。
       無ければ自動で RGBA8 / LDR にフォールバック（絵作りは同じ）。

   window.BubbleBG（liquid-bg.js から参照される外部インターフェース。不変）:
     .canvas / .ready / .tick
   ========================================================================= */
window.BubbleBG = window.BubbleBG || { canvas: null, ready: false, tick: 0 };

(function(){
'use strict';

function boot(){

/* ============================================================
   0. canvas
   ============================================================ */
const canvas = document.getElementById('bubbleGl') || (function(){
  const c = document.createElement('canvas');
  c.id = 'bubbleGl';
  document.body.insertBefore(c, document.body.firstChild);
  return c;
})();
window.BubbleBG.canvas = canvas;

const RES_CONFIG = { DPR_MAX: 0.75, MAX_SHORT_SIDE: 450 };
const ENV_W = 512, ENV_H = 256;   // 環境マップ解像度（背景の墨流しはここに描く）

/* ============================================================
   1. WebGL2
   ============================================================ */
const PDB = !!window.BG_PRESERVE_DRAWING_BUFFER;
const ATTEMPTS = [
  { antialias:false, alpha:false, depth:false, stencil:false, powerPreference:'high-performance', preserveDrawingBuffer: PDB },
  { antialias:false, alpha:false, depth:false, stencil:false, preserveDrawingBuffer: PDB },
  { antialias:false, preserveDrawingBuffer: PDB },
  { preserveDrawingBuffer: PDB }
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
   2. RT ヘルパ & HDR 対応チェック
   ============================================================ */
const extF = gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float');

function makeRT(w, h, isFloat){
  w = Math.max(1, w|0); h = Math.max(1, h|0);
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  if(isFloat) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
  else        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8,   w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  const ok = status === gl.FRAMEBUFFER_COMPLETE;
  if(!ok) console.warn('[bubble-bg] FBO incomplete (' + w + 'x' + h + (isFloat?' f16':'') + '): status ' + status);
  return { tex, fb, w, h, ok };
}
function freeRT(rt){ if(!rt) return; gl.deleteFramebuffer(rt.fb); gl.deleteTexture(rt.tex); }

let HDR = false;
if(extF){
  const probe = makeRT(4, 4, true);
  HDR = probe.ok;
  freeRT(probe);
}
if(!HDR) console.info('[bubble-bg] float render targets unavailable — using LDR pipeline.');

/* ============================================================
   3. シェーダ compile/link
   ============================================================ */
function compile(type, src, name){
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if(!gl.getShaderParameter(s, gl.COMPILE_STATUS)){
    console.error('[bubble-bg] shader compile failed: ' + name + '\n' + (gl.getShaderInfoLog(s)||'(no log)'));
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
    console.error('[bubble-bg] program link failed: ' + name + '\n' + (gl.getProgramInfoLog(p)||'(no log)'));
    throw new Error('program link failed: ' + name);
  }
  gl.deleteShader(vs); gl.deleteShader(fs);
  const P = { p: p, u: {} };
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for(let i=0;i<n;i++){
    const info = gl.getActiveUniform(p, i);
    const nm = info.name.replace(/\[0\]$/, '');
    P.u[nm] = gl.getUniformLocation(p, nm);
  }
  return P;
}

const MAXB = 12;
let buildOK = true;
let progEnv, progMain, progDown, progUp, progComposite, progLine, progDust;

try{

/* ============================================================
   4. シェーダソース
   ============================================================ */
const HEAD = `#version 300 es
precision highp float;
precision highp int;
#define PI 3.14159265359
#define TAU 6.28318530718
#define MAXB ${MAXB}
#define HDR ${HDR?1:0}
`;

/* 共通ライブラリ（uniform を含まない純関数のみ） */
const LIB = `
float hash11(float p){ p = fract(p*0.1031); p *= p+33.33; p *= p+p; return fract(p); }
float hash13(vec3 p){
  p = fract(p*0.3183099 + vec3(0.71,0.113,0.419));
  p *= 17.0;
  return fract(p.x*p.y*p.z*(p.x+p.y+p.z));
}
float noise3(vec3 x){
  vec3 i = floor(x), f = fract(x);
  f = f*f*f*(f*(f*6.0-15.0)+10.0);
  float a = mix(mix(hash13(i+vec3(0,0,0)), hash13(i+vec3(1,0,0)), f.x),
                mix(hash13(i+vec3(0,1,0)), hash13(i+vec3(1,1,0)), f.x), f.y);
  float b = mix(mix(hash13(i+vec3(0,0,1)), hash13(i+vec3(1,0,1)), f.x),
                mix(hash13(i+vec3(0,1,1)), hash13(i+vec3(1,1,1)), f.x), f.y);
  return mix(a,b,f.z);
}
float fbm2(vec3 p){
  float s = 0.0, a = 0.55;
  for(int i=0;i<2;i++){ s += a*noise3(p); p = p*2.05 + vec3(3.1,1.7,9.2); a *= 0.5; }
  return s;
}
float fbm4(vec3 p){
  float s = 0.0, a = 0.5;
  for(int i=0;i<4;i++){ s += a*noise3(p); p = p*2.03 + vec3(3.1,1.7,9.2); a *= 0.5; }
  return s;
}
/* パステル4色パレット: 桃 → 桜 → ラベンダー → 空 → 桃 */
vec3 pastelPalette(float t){
  t = fract(t);
  vec3 c0, c1;
  float x = t*6.0; float i = floor(x); float f = fract(x); f = f*f*(3.0-2.0*f);
  vec3 P0 = vec3(1.00,0.78,0.92);   /* 桜ピンク */
  vec3 P1 = vec3(0.86,0.76,1.00);   /* ラベンダー */
  vec3 P2 = vec3(0.76,0.66,1.00);   /* すみれ */
  vec3 P3 = vec3(0.70,0.90,1.00);   /* 空色（サブ） */
  vec3 P4 = vec3(0.90,0.78,1.00);   /* 藤 */
  vec3 P5 = vec3(1.00,0.82,0.70);   /* 桃オレンジ（サブ） */
  if(i<0.5){c0=P0;c1=P1;} else if(i<1.5){c0=P1;c1=P2;} else if(i<2.5){c0=P2;c1=P3;}
  else if(i<3.5){c0=P3;c1=P4;} else if(i<4.5){c0=P4;c1=P5;} else {c0=P5;c1=P0;}
  return mix(c0,c1,f);
}
/* 環境マップ（等距円筒）: rgb = HDR色, a = 墨流しスカラー場 */
vec2 envUV(vec3 d){ return vec2(atan(d.z,d.x)/TAU + 0.5, asin(clamp(d.y,-1.0,1.0))/PI + 0.5); }
#if HDR
vec4 encodeEnv(vec3 c, float m){ return vec4(c, m); }
vec4 decodeEnv(vec4 e){ return e; }
#else
vec4 encodeEnv(vec3 c, float m){ return vec4(sqrt(max(c,0.0)/4.0), m); }
vec4 decodeEnv(vec4 e){ return vec4(e.rgb*e.rgb*4.0, e.a); }
#endif
`;

/* パステル向けトーンマップ（HDR時は composite、LDR時は main で適用） */
const GRADE = `
uniform float uExposure;
vec3 grade(vec3 c){
  c *= uExposure;
  float W = 3.2;
  c = c*(1.0 + c/(W*W))/(1.0 + c);              /* 拡張 Reinhard */
  float l = dot(c, vec3(0.2126,0.7152,0.0722));
  c = mix(c, vec3(l), 0.35*smoothstep(0.55,1.05,l)); /* ハイライトは白へ抜ける */
  c = pow(clamp(c,0.0,1.0), vec3(1.0/2.2));
  c = c*0.90 + vec3(0.085,0.060,0.105);   /* 暗部をよりラベンダー寄りに */
  return c;
}
`;

const VS_QUAD = HEAD + `
void main(){
  vec2 p = vec2(float((gl_VertexID<<1)&2), float(gl_VertexID&2));
  gl_Position = vec4(p*2.0-1.0, 0.0, 1.0);
}`;

/* ---------- 環境マップ: 墨流し + ハロー + 遠景ボケ ---------- */
const FS_ENV = HEAD + LIB + `
uniform vec2  uEnvRes;
uniform float uTime, uHueBias;
uniform vec3  uLightDir[3];
uniform vec3  uLightCol[3];
out vec4 fragColor;
void main(){
  vec2 uv = gl_FragCoord.xy/uEnvRes;
  float az = (uv.x-0.5)*TAU, el = (uv.y-0.5)*PI;
  vec3 d = vec3(cos(el)*cos(az), sin(el), cos(el)*sin(az));
  float t = uTime;
  vec3 p = d*1.9;

  /* 3段ドメインワープ（墨流しの渦） */
  float w1 = fbm4(p*0.9 + vec3(0.0, t*0.020, 0.0));
  float w2 = fbm4(p*0.9 + vec3(5.1,2.3,7.4) - vec3(t*0.016, 0.0, 0.0));
  vec3 q = p + 1.9*vec3(w1-0.5, w2-0.5, (w1-w2)*0.9);
  float w3 = fbm4(q*1.15 + vec3(1.7,9.2,3.1) + vec3(0.0, 0.0, t*0.012));
  float w4 = fbm4(q*1.15 + vec3(8.3,2.8,4.1) + vec3(t*0.010, 0.0, 0.0));
  vec3 r = q + 1.5*vec3(w3-0.5, (w4-0.5)*0.8, (w3-w4));
  float m = fbm4(r + vec3(0.0, t*0.008, 0.0));
  float mn = clamp((m-0.20)/0.56, 0.0, 1.0);

  float hue = mn*0.80 + 0.18*(w3-0.5) + 0.03*sin(t*0.05) + uHueBias;
  vec3 col = pastelPalette(hue);
  col *= 0.62 + 0.60*smoothstep(0.15,0.85,mn);
  col = mix(col, col*vec3(1.05,0.90,1.14), 0.55);   /* ← 追加: 紫寄りティント */

  float milk = pow(1.0-abs(2.0*w4-1.0), 7.0);

  /* ミルク色を桜白に（変更前: vec3(1.0,0.98,0.97)） */
  col = mix(col, vec3(1.0,0.95,0.99), 0.40*milk);
  /* 少し濃い墨の糸（w3 の稜線） */
  float ink = pow(1.0-abs(2.0*w3-1.0), 9.0);
  col *= 1.0 - 0.18*ink;

  /* 上方が明るい */
  col *= 0.90 + 0.16*smoothstep(-0.9,0.9,d.y);

  /* キーライトのソフトハロー（鋭いコアは main 側で解析的に足す） */
  for(int i=0;i<3;i++){
    float c = 1.0 - max(dot(d, uLightDir[i]), 0.0);
    col += uLightCol[i]*(1.2*exp(-c*45.0) + 0.45*exp(-c*9.0) + 0.14*exp(-c*2.2));
  }
  /* 遠景の大きなソフトボケ光 */
  for(int i=0;i<6;i++){
    float fi = float(i);
    float h1=hash11(fi*12.9+3.1), h2=hash11(fi*7.7+9.3), h3=hash11(fi*5.3+1.7), h4=hash11(fi*3.1+6.6);
    float a2 = h1*TAU + t*0.006*(0.5+h2);
    float e2 = (h2-0.5)*2.2;
    vec3 od = vec3(cos(e2)*cos(a2), sin(e2), cos(e2)*sin(a2));
    float c = 1.0 - max(dot(d, od), 0.0);
    col += pastelPalette(h3*0.45 + uHueBias)*0.35*exp(-c*mix(60.0,160.0,h4));
  }

  fragColor = encodeEnv(max(col, vec3(0.0)), mn);
}`;

/* ---------- メイン: メタボール・シャボン玉 ---------- */
const FS_MAIN = HEAD + LIB + (HDR ? '' : GRADE) + `
uniform vec2  uRes;
uniform vec3  uCamPos, uRight, uUp, uFwd;
uniform float uFocal;
uniform int   uCount;
uniform vec4  uB[MAXB];
uniform vec3  uBoundC;
uniform float uBoundR;
uniform float uK, uIOR, uWobble, uFilm, uWater, uTime, uHueBias, uSaturation;
uniform vec3  uLightDir[3];
uniform vec3  uLightCol[3];
uniform sampler2D uEnv, uFX;
out vec4 fragColor;

float smin(float a, float b, float k){
  float h = clamp(0.5 + 0.5*(b-a)/max(k,1e-4), 0.0, 1.0);
  return mix(b,a,h) - k*h*(1.0-h);
}
float sdScene(vec3 p){
  float d = 1e6;
  for(int i=0;i<MAXB;i++){
    if(i>=uCount) break;
    vec4 b = uB[i];
    d = smin(d, length(p-b.xyz)-b.w, uK);
  }
  d += uWobble*0.045*sin(p.x*1.6+uTime*0.14)*sin(p.y*1.5-uTime*0.11)*sin(p.z*1.7+uTime*0.12);
  return d;
}
vec3 calcNormal(vec3 p){
  const float e = 0.004;
  vec2 k = vec2(1.0,-1.0);
  vec3 n = k.xyy*sdScene(p+k.xyy*e) + k.yyx*sdScene(p+k.yyx*e)
         + k.yxy*sdScene(p+k.yxy*e) + k.xxx*sdScene(p+k.xxx*e);
  float L = length(n);
  return (L>1e-6) ? n/L : vec3(0.0,1.0,0.0);
}
vec4 env(vec3 d){ return decodeEnv(texture(uEnv, envUV(d))); }
vec3 envC(vec3 d){ return env(d).rgb; }

/* 薄膜干渉: 光路差 → 3波長の反射率 */
vec3 thinFilm(float cosT, float thick){
  float n = 1.33;
  float sinT2 = (1.0-cosT*cosT)/(n*n);
  float cosT2 = sqrt(max(1.0-sinT2, 0.0));
  float opd = 2.0*n*thick*cosT2;
  vec3 lam = vec3(650.0, 540.0, 450.0);
  vec3 ph = TAU*opd/lam + PI;
  return 0.5 - 0.5*cos(ph);
}
/* 解析的な光源コア（環境マップ解像度に依存しない鋭さ） */
vec3 lightCores(vec3 d){
  vec3 s = vec3(0.0);
  for(int i=0;i<3;i++){
    float c = 1.0 - max(dot(d, uLightDir[i]), 0.0);
    s += uLightCol[i]*(3.5*exp(-c*1400.0) + 0.8*exp(-c*220.0));
  }
  return s;
}
/* ボケ玉（縁がやや明るい円盤）＋小さな星 */
vec3 bokehField(vec3 d, float t){
  vec3 s = vec3(0.0);
  for(int i=0;i<10;i++){
    float fi = float(i);
    float h1=hash11(fi*12.9+3.1), h2=hash11(fi*7.7+9.3), h3=hash11(fi*5.3+1.7), h4=hash11(fi*3.1+6.6);
    float az = h1*TAU + t*(0.004+0.006*h2);
    float el = (h2-0.5)*PI*0.8 + 0.02*sin(t*0.1+h3*9.0);
    vec3 od = vec3(cos(el)*cos(az), sin(el), cos(el)*sin(az));
    float c = 1.0 - max(dot(d, od), 0.0);
    float r = mix(0.0006, 0.0045, h4*h4);
    float disc = smoothstep(r, r*0.72, c);
    float rim  = smoothstep(r*0.5, r, c)*disc;
    float tw = 0.75 + 0.45*sin(t*0.35 + h1*21.0);
    vec3 oc = pastelPalette(h3*0.42 + uHueBias);   /* 桜〜すみれの帯だけ使う */
    s += oc*((disc*(0.55+0.8*rim))*mix(0.35,1.0,h4) + 0.12*exp(-c/r*0.6))*tw;
    /* 小さな星（大きいボケには付けない） */
    s += oc*step(h4,0.5)*2.2*exp(-c*9000.0)*tw;
  }
  return s;
}
/* 墨流しスカラー場から復元する電気信号の脈 */
vec3 veins(float m, vec3 d, float t, float w){
  float lv = m*24.0 - t*0.10;
  float f = abs(fract(lv)-0.5);
  float line = 1.0 - smoothstep(0.0, w, f);
  float lv2 = m*70.0 + t*0.16;
  float line2 = 1.0 - smoothstep(0.0, w*2.5, abs(fract(lv2)-0.5));
  float pulse = pow(0.5+0.5*sin(m*36.0 + dot(d,vec3(1.3,0.7,1.9))*2.0 - t*0.7), 18.0);
  vec3 vc = mix(vec3(0.60,0.95,1.00), vec3(1.00,0.78,0.95), 0.5+0.5*sin(m*11.0+t*0.15));
  float band = smoothstep(0.22,0.50,m)*smoothstep(0.98,0.72,m);
  return vc*band*(line*(0.12 + 1.5*pulse) + line2*0.05);
}
/* 前方キーライトのレンズフレア（放射シャフト＋十字ストリーク） */
vec3 keyFlare(vec2 uv, float t){
  vec3 L = uLightDir[0];
  float c = dot(L, uFwd);
  if(c < 0.05) return vec3(0.0);
  vec2 luv = vec2(dot(L,uRight), dot(L,uUp))/c*uFocal;
  vec2 dv = uv - luv;
  float r = length(dv) + 1e-4;
  float ang = atan(dv.y, dv.x);
  float N = 28.0;
  float a1 = ang/TAU*N + t*0.03; float i1 = floor(a1), f1 = fract(a1); f1 = f1*f1*(3.0-2.0*f1);
  float n1 = mix(hash11(mod(i1,N)*1.7+2.0), hash11(mod(i1+1.0,N)*1.7+2.0), f1);
  float a2 = ang/TAU*14.0 - t*0.02; float i2 = floor(a2), f2 = fract(a2); f2 = f2*f2*(3.0-2.0*f2);
  float n2 = mix(hash11(mod(i2,14.0)*3.1+7.0), hash11(mod(i2+1.0,14.0)*3.1+7.0), f2);
  float rays = pow(n1*0.6 + n2*0.4, 2.5);
  float shaft  = rays*exp(-r*1.8)*smoothstep(0.0,0.10,r)*0.45;
  float streak = (pow(abs(cos(ang)),300.0) + 0.5*pow(abs(sin(ang)),300.0))*exp(-r*5.0)*0.6;
  float glow   = 0.10*exp(-r*r*9.0);
  return uLightCol[0]*(shaft + streak + glow);
}

void main(){
  vec2 fc = gl_FragCoord.xy;
  vec2 uv = (fc - 0.5*uRes)/uRes.y;
  vec2 suv = fc/uRes;
  vec3 ro = uCamPos;
  vec3 rd = normalize(uRight*uv.x + uUp*uv.y + uFwd*uFocal);

  /* 背景は全ピクセルで先に引く（fwidth のため分岐の外） */
  vec4 e0 = env(rd);
  float vw = fwidth(e0.a)*24.0*0.8 + 0.010;

  vec3 oc = ro - uBoundC;
  float bb = dot(oc, rd);
  float cc = dot(oc, oc) - uBoundR*uBoundR;
  float disc = bb*bb - cc;
  bool hit = false;
  vec3 hitP = vec3(0.0);

  if(disc > 0.0){
    float sq = sqrt(disc);
    float tmin = max(-bb - sq, 0.0);
    float tmax = -bb + sq;
    if(tmax > 0.0){
      float span = max(tmax-tmin, 1e-4);
      float minStp = span*0.006;
      float t = tmin;
      for(int i=0;i<18;i++){
        if(t > tmax) break;
        vec3 p = ro + rd*t;
        float d = sdScene(p);
        if(d < span*0.0015){ hit = true; hitP = p; break; }
        t += max(d*0.65, minStp);
      }
    }
  }

  vec3 col;
  if(hit){
    vec3 nn = calcNormal(hitP);
    vec3 nf = (dot(nn,rd) > 0.0) ? -nn : nn;
    float cosT = clamp(-dot(nf, rd), 0.0, 1.0);

    float F0 = pow((uIOR-1.0)/(uIOR+1.0), 2.0);
    float fres = F0 + (1.0-F0)*pow(1.0-cosT, 5.0);
    fres = clamp(fres*1.6, 0.0, 1.0);

    /* 膜厚: ノイズ + 重力で下側が厚い */
    float thick = 220.0 + 330.0*fbm2(hitP*2.4 + vec3(0.0,-uTime*0.05,0.0) + nf*0.5) + 160.0*(0.5-0.5*nf.y);
    vec3 R = thinFilm(cosT, thick);
    vec3 tint = mix(vec3(1.0), R*vec3(1.05,0.95,1.10), clamp(uFilm,0.0,1.0)*0.85);
    tint = mix(tint, vec3(1.0), 0.28);   /* パステル化 */

    /* 反射 */
    vec3 reflDir = reflect(rd, nf);
    vec3 reflCol = envC(reflDir)*1.05 + lightCores(reflDir)*0.6 + bokehField(reflDir, uTime)*0.7;

    /* 内部再マーチ → 出射屈折 */
    vec3 rin = refract(rd, nf, 1.0/uIOR);
    if(dot(rin,rin) < 0.5) rin = rd;
    vec3 p2 = hitP + rin*0.03;
    for(int i=0;i<10;i++){
      float dd = sdScene(p2);
      if(dd > 0.0) break;
      p2 += rin*max(-dd*0.9, 0.025);
    }
    vec3 nout = calcNormal(p2);
    vec3 rout = refract(rin, -nout, uIOR);
    if(dot(rout,rout) < 0.5) rout = reflect(rin, nout);

    /* 薄膜(直進)と水滴(屈折)のブレンド + 分散 */
    vec3 rG = normalize(mix(rd, rout, uWater));
    vec3 dv = rG - rd;
    vec3 rR = normalize(rG + dv*0.05), rB = normalize(rG - dv*0.05);
    vec4 eG = env(rG);
    vec3 through = vec3(envC(rR).r, eG.g, envC(rB).b);
    through += veins(eG.a, rG, uTime, 0.02)*0.7 + bokehField(rG, uTime)*0.5 + lightCores(rG)*0.35;
    through *= mix(1.0, 0.93, uWater);

    /* FXレイヤー（サイバー線/塵）を屈折歪みで参照 */
    vec2 off = vec2(dot(dv,uRight), dot(dv,uUp))*0.35;
    vec3 fx = texture(uFX, suv + off).rgb;

    /* 表面・裏面の二重ハイライト */
    vec3 spec = vec3(0.0);
    for(int i=0;i<3;i++){
      vec3 L = uLightDir[i];
      vec3 h = normalize(L - rd + vec3(1e-5));
      float ndh = max(dot(nf,h),0.0);
      spec += uLightCol[i]*(pow(ndh,1200.0)*4.0 + pow(ndh,90.0)*0.35)*(0.25+fres);
      float ndh2 = max(dot(-nout,h),0.0);
      spec += uLightCol[i]*(pow(ndh2,700.0)*1.4 + pow(ndh2,60.0)*0.15)*(1.0-fres)*0.8;
    }
    vec3 rim = pow(1.0-cosT, 4.0)*R*0.9;
    float sparkle = pow(fbm2(hitP*12.0 + uTime*0.04), 12.0)*4.0*fres;

    col = through*(1.0-fres*0.8)*mix(vec3(1.0), tint, 0.2)
        + reflCol*fres*tint*1.1
        + spec + rim + sparkle*R + fx;
  } else {
    col = e0.rgb + veins(e0.a, rd, uTime, vw) + lightCores(rd) + bokehField(rd, uTime)
        + texture(uFX, suv).rgb;
  }
  col += keyFlare(uv, uTime);

  float lu = dot(col, vec3(0.2126,0.7152,0.0722));
  col = mix(vec3(lu), col, uSaturation);
#if !HDR
  col = grade(col);
#endif
  fragColor = vec4(col, 1.0);
}`;

/* ---------- ブルーム ---------- */
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
  vec3 s = T(vec2(-1.0,1.0)) + T(vec2(0.0,1.0))*2.0 + T(vec2(1.0,1.0))
         + T(vec2(-1.0,0.0))*2.0 + T(vec2(0.0,0.0))*4.0 + T(vec2(1.0,0.0))*2.0
         + T(vec2(-1.0,-1.0)) + T(vec2(0.0,-1.0))*2.0 + T(vec2(1.0,-1.0));
  fragColor = vec4(s/16.0, 1.0);
}`;

const FS_COMPOSITE = HEAD + (HDR ? GRADE : '') + `
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
  vec3 bl  = texture(uBloom, uv).rgb;
  col += bl*uBloomStr;
#if HDR
  col = grade(col);
#endif
  col *= smoothstep(1.05,0.20,r2*1.3)*0.10 + 0.90;
  float gnoise = hash(gl_FragCoord.xy + fract(uTime)*137.0) - 0.5;
  col += gnoise*0.010;
  fragColor = vec4(clamp(col,0.0,1.0), 1.0);
}`;

/* ---------- サイバー線（グロー付きリボン + 信号パケット） ---------- */
const VLIB = `float hash11(float p){ p=fract(p*0.1031); p*=p+33.33; p*=p+p; return fract(p); }`;

const VS_LINE = HEAD + VLIB + `
uniform vec3 uCamPos2, uRight2, uUp2, uFwd2;
uniform float uFocal2, uAspect, uTime, uSegs, uWidth;
out vec3 vCol;
out float vA;
vec3 curvePoint(float id, float u, float t){
  float s = hash11(id*1.7+0.3)*20.0;
  float spin = t*(0.018+0.03*hash11(id+7.3))+s;
  float R = 1.4+2.6*hash11(id+2.1);
  float yspan = 3.2+2.2*hash11(id+5.5);
  float turns = 1.1+2.4*hash11(id+9.9);
  float ang = u*TAU*turns + spin;
  float rr = R*(0.62+0.48*sin(u*4.7+s));
  vec3 p = vec3(cos(ang)*rr, (u-0.5)*yspan+0.5*sin(u*5.0+s), sin(ang)*rr);
  p += 0.4*vec3(sin(u*9.0+t*0.3+s), sin(u*7.0-t*0.25+s*1.7), sin(u*8.0+t*0.27+s*0.3));
  return p;
}
vec2 proj(vec3 P, out float depth){
  vec3 v = P - uCamPos2;
  float a = dot(v,uRight2), b = dot(v,uUp2), c = max(dot(v,uFwd2), 0.3);
  depth = c;
  return vec2(2.0*uFocal2*a/(uAspect*c), 2.0*uFocal2*b/c);
}
void main(){
  int vid = gl_VertexID;
  int seg = vid/6;
  int corner = vid - seg*6;
  float cid = floor(float(seg)/uSegs);
  float sid = float(seg) - cid*uSegs;
  float e = (corner==1||corner==4||corner==5) ? 1.0 : 0.0;
  float side = (corner==0||corner==1||corner==4) ? -1.0 : 1.0;
  float u0 = sid/uSegs, u1 = (sid+1.0)/uSegs;
  float d0, d1;
  vec2 s0 = proj(curvePoint(cid,u0,uTime), d0);
  vec2 s1 = proj(curvePoint(cid,u1,uTime), d1);
  vec2 dir = s1 - s0; dir.x *= uAspect;
  float L = length(dir);
  dir = (L>1e-5) ? dir/L : vec2(1.0,0.0);
  vec2 nrm = vec2(-dir.y, dir.x); nrm.x /= uAspect;
  float u = mix(u0,u1,e);
  vec2 s = mix(s0,s1,e);
  float dep = mix(d0,d1,e);
  gl_Position = vec4(s + nrm*(uWidth/dep)*side, 0.0, 1.0);
  vA = side;

  float ph = fract(u*0.85 - uTime*0.05 + hash11(cid+3.3));
  float packet = exp(-ph*16.0) + exp(-fract(ph+0.5)*26.0)*0.45;
  float ends = smoothstep(0.0,0.14,u)*smoothstep(1.0,0.86,u);
  float hh = hash11(cid+4.4);
  vec3 base = (hh<0.22) ? vec3(0.66,0.94,1.00) : (hh<0.60) ? vec3(1.00,0.76,0.94) : vec3(0.82,0.72,1.00);
  float near = smoothstep(0.3, 1.2, dep);
  vCol = base*(0.12+2.2*packet)*ends*near*(0.55+0.45*sin(uTime*0.35+cid*3.0));
}`;
const FS_LINE = HEAD + `
in vec3 vCol;
in float vA;
out vec4 fragColor;
void main(){
  float a2 = vA*vA;
  float core = exp(-a2*40.0);
  float glow = exp(-a2*4.0)*0.22;
  fragColor = vec4(vCol*(core+glow), 0.0);
}`;

/* ---------- 塵（ボケ玉スプライト） ---------- */
const VS_PT = HEAD + VLIB + `
uniform vec3 uCamPos2, uRight2, uUp2, uFwd2;
uniform float uFocal2, uAspect, uTime, uPxScale;
out vec3 vCol;
out float vSoft;
void main(){
  float id = float(gl_VertexID);
  float h1 = hash11(id*1.13+0.7);
  float h2 = hash11(id*2.31+3.1);
  float h3 = hash11(id*3.77+9.4);
  float h4 = hash11(id*5.19+5.5);
  float rad = 0.9+5.0*h1;
  float ang = h2*TAU + uTime*(0.02+0.03*h4);
  float yy = mod(h3*8.0 + uTime*(0.02+0.04*h2), 8.0) - 4.0;
  vec3 P = vec3(cos(ang)*rad, yy, sin(ang)*rad);
  P += 0.6*vec3(sin(uTime*0.35+h1*30.0), sin(uTime*0.27+h2*22.0), sin(uTime*0.31+h3*17.0));
  vec3 v = P - uCamPos2;
  float a = dot(v,uRight2), b = dot(v,uUp2), c = dot(v,uFwd2);
  gl_Position = vec4(2.0*uFocal2*a/uAspect, 2.0*uFocal2*b, 0.0, max(c,0.001));
  /* 焦点面(距離4.4)から離れるほど大きくボケる */
  float defocus = clamp(abs(c-4.4)/4.0, 0.0, 1.0);
  gl_PointSize = clamp(uPxScale*(0.4+1.4*h4)*(0.5+2.5*defocus)/max(c,0.15), 1.5, 40.0);
  vSoft = defocus;
  float tw = pow(0.5+0.5*sin(uTime*0.45+h1*60.0), 3.0);
  vec3 base = (h2<0.42) ? vec3(1.00,0.84,0.95) : (h2<0.62) ? vec3(0.78,0.94,1.00) : vec3(0.88,0.80,1.00);
  vCol = base*(0.15+1.3*tw)*(0.35+0.65*h1)*mix(1.0,0.35,defocus)*step(0.3,c);
}`;
const FS_PT = HEAD + `
in vec3 vCol;
in float vSoft;
out vec4 fragColor;
void main(){
  vec2 q = gl_PointCoord-0.5;
  float r2 = dot(q,q)*4.0;
  if(r2>1.0) discard;
  float disc = smoothstep(1.0, 0.72, r2)*(0.6+0.6*smoothstep(0.45,1.0,r2));
  float soft = exp(-r2*3.2)*(1.0-r2*r2);
  fragColor = vec4(vCol*mix(soft, disc, vSoft), 0.0);
}`;

progEnv       = link(VS_QUAD, FS_ENV, 'env');
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
   5. レンダーターゲット
   ============================================================ */
const vao = gl.createVertexArray();
gl.bindVertexArray(vao);
function drawQuad(){ gl.drawArrays(gl.TRIANGLES, 0, 3); }

const rtEnv = makeRT(ENV_W, ENV_H, HDR);
gl.bindTexture(gl.TEXTURE_2D, rtEnv.tex);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);  /* 経度方向の継ぎ目対策 */

let W=0, H=0, rtScene=null, rtFX=null, rtBloom=[];
function buildTargets(w, h){
  freeRT(rtScene); freeRT(rtFX); rtBloom.forEach(freeRT);
  W=w; H=h;
  rtScene = makeRT(w, h, HDR);
  rtFX    = makeRT(Math.max(4,w>>1), Math.max(4,h>>1), HDR);
  rtBloom = [];
  let bw = Math.max(4, w>>1), bh = Math.max(4, h>>1);
  for(let i=0;i<4;i++){
    rtBloom.push(makeRT(bw, bh, HDR));
    bw = Math.max(4, bw>>1); bh = Math.max(4, bh>>1);
  }
}

/* ============================================================
   6. バブル物理（旧版よりゆっくり・ふわふわ）
   ============================================================ */
let bub = [];
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
  bub = [];
  for(let i=0;i<n;i++){
    const theta = rnd()*Math.PI*2, phi = Math.acos(2*rnd()-1);
    const rad = rnd()*1.5;
    bub.push({
      x: rad*Math.sin(phi)*Math.cos(theta),
      y: rad*Math.sin(phi)*Math.sin(theta),
      z: rad*Math.cos(phi),
      vx:(rnd()-0.5)*0.25, vy:(rnd()-0.5)*0.25, vz:(rnd()-0.5)*0.25,
      r: 0.32 + rnd()*0.55,
      seed: rnd()*1000
    });
  }
}
function stepBubbles(dt, t){
  const BOUND = 2.05;
  for(let i=0;i<bub.length;i++){
    const b = bub[i];
    b.vx += Math.sin(b.y*0.6+t*0.18+b.seed)*0.012*dt;
    b.vy += (Math.sin(b.z*0.6+t*0.16+b.seed*1.3)*0.012 + 0.004)*dt;  /* わずかな浮力 */
    b.vz += Math.sin(b.x*0.6+t*0.14+b.seed*0.7)*0.012*dt;
    b.vx*=0.990; b.vy*=0.990; b.vz*=0.990;
  }
  for(let i=0;i<bub.length;i++){
    for(let j=i+1;j<bub.length;j++){
      const a=bub[i], c=bub[j];
      let dx=a.x-c.x, dy=a.y-c.y, dz=a.z-c.z;
      const d = Math.sqrt(dx*dx+dy*dy+dz*dz) || 1e-4;
      const minD = (a.r+c.r)*0.82;
      if(d<minD){
        const f = (minD-d)/minD*0.4;
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
      b.vx*=0.6; b.vy*=0.6; b.vz*=0.6;
    }
  }
}

/* ============================================================
   7. カメラ・パラメータ
   ============================================================ */
let yaw = 0.5, pitch = 0.22, dist = 4.5;
let autoYaw = 0;

const params = {
  count: 10,
  fuse: 0.55,
  ior: 1.338,
  wobble: 0.9,
  film: 0.99,      /* 薄膜干渉の強さ */
  water: 0.35,     /* 0=シャボン玉(直進) … 1=水滴(屈折) */
  spin: 1.0,
  exposure: 1.0,
  bloom: 0.9,
  quality: 0.75,
  saturation: 1.15,
  hueBias: 0.0036
};
const toggles = { rotate: true, lines: true, dust: true, paused: false };

const FIXED_SEED = (typeof window.BG_FIXED_SEED === 'number') ? window.BG_FIXED_SEED : 20260901;
initBubbles(params.count, FIXED_SEED);

/* ============================================================
   8. リサイズ
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
  buildTargets(Math.max(1, Math.floor(bw*params.quality)), Math.max(1, Math.floor(bh*params.quality)));
}
window.addEventListener('resize', resize);

/* ============================================================
   9. メインループ
   ============================================================ */
let simTime = 0, prevTs = performance.now();
let renderTick = 0, raf = 0;
const arrB = new Float32Array(MAXB*4);
const SEGS = 40, LINE_CURVES = 8, LINE_VERTS = LINE_CURVES*SEGS*6, PT_COUNT = 220;
const lightDir = new Float32Array(9);
const lightCol = new Float32Array([
  1.00, 0.86, 0.96,   /* 前方の「太陽」: 桜白 */
  0.92, 0.84, 1.00,   /* カメラ側キーライト: 藤白 */
  0.74, 0.92, 1.00    /* 世界固定: 空色（サブ） */
]);
function setLight(i, x,y,z){
  const l = Math.hypot(x,y,z)||1;
  lightDir[i*3]=x/l; lightDir[i*3+1]=y/l; lightDir[i*3+2]=z/l;
}
function setCam(P, px,py,pz, rx,ry,rz, ux,uy,uz, fx,fy,fz, FOCAL, aspect){
  gl.uniform3f(P.u.uCamPos2, px,py,pz);
  gl.uniform3f(P.u.uRight2, rx,ry,rz);
  gl.uniform3f(P.u.uUp2, ux,uy,uz);
  gl.uniform3f(P.u.uFwd2, fx,fy,fz);
  gl.uniform1f(P.u.uFocal2, FOCAL);
  gl.uniform1f(P.u.uAspect, aspect);
  gl.uniform1f(P.u.uTime, simTime);
}

function renderPass(dt){
  if(toggles.rotate) autoYaw += dt*0.0025*params.spin;
  const cy = yaw+autoYaw, cp = pitch + 0.03*Math.sin(simTime*0.05);
  const px = Math.sin(cy)*Math.cos(cp)*dist, py = Math.sin(cp)*dist, pz = Math.cos(cy)*Math.cos(cp)*dist;
  const fx=-px/dist, fy=-py/dist, fz=-pz/dist;
  let rx = fy*0-fz*1, ry = fz*0-fx*0, rz = fx*1-fy*0;
  const rl = Math.hypot(rx,ry,rz)||1; rx/=rl; ry/=rl; rz/=rl;
  const ux = ry*fz-rz*fy, uy = rz*fx-rx*fz, uz = rx*fy-ry*fx;
  const FOCAL = 1.55;
  const aspect = W/H;

  /* ライト: 0=前方(画面内, フレア), 1=カメラ側(ハイライト), 2=世界固定 */
  setLight(0, -0.45*rx+0.40*ux+0.80*fx, -0.45*ry+0.40*uy+0.80*fy, -0.45*rz+0.40*uz+0.80*fz);
  setLight(1,  0.50*rx+0.60*ux-0.62*fx,  0.50*ry+0.60*uy-0.62*fy,  0.50*rz+0.60*uz-0.62*fz);
  setLight(2, 0.6, 0.3, 0.7);

  stepBubbles(dt, simTime);
  let mx=0,my=0,mz=0;
  for(let i=0;i<bub.length;i++){ mx+=bub[i].x; my+=bub[i].y; mz+=bub[i].z; }
  if(bub.length){ mx/=bub.length; my/=bub.length; mz/=bub.length; }
  let mr=0.6;
  for(let i=0;i<bub.length;i++){
    const b=bub[i];
    const d = Math.hypot(b.x-mx,b.y-my,b.z-mz)+b.r;
    if(d>mr) mr=d;
  }
  const boundR = mr+0.6;
  arrB.fill(0);
  const n = Math.min(params.count|0, bub.length, MAXB);
  for(let i=0;i<n;i++){
    arrB[i*4]=bub[i].x; arrB[i*4+1]=bub[i].y; arrB[i*4+2]=bub[i].z; arrB[i*4+3]=bub[i].r;
  }

  gl.bindVertexArray(vao);
  gl.disable(gl.BLEND);

  /* pass 0: 環境マップ（墨流し） */
  {
    const P = progEnv;
    gl.useProgram(P.p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, rtEnv.fb);
    gl.viewport(0,0,ENV_W,ENV_H);
    gl.uniform2f(P.u.uEnvRes, ENV_W, ENV_H);
    gl.uniform1f(P.u.uTime, simTime);
    gl.uniform1f(P.u.uHueBias, params.hueBias);
    gl.uniform3fv(P.u.uLightDir, lightDir);
    gl.uniform3fv(P.u.uLightCol, lightCol);
    drawQuad();
  }

  /* pass 1: FX レイヤー（サイバー線 + 塵）を加算で別RTへ */
  gl.bindFramebuffer(gl.FRAMEBUFFER, rtFX.fb);
  gl.viewport(0,0,rtFX.w,rtFX.h);
  gl.clearColor(0,0,0,0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  if(toggles.lines || toggles.dust){
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    if(toggles.lines){
      const P = progLine;
      gl.useProgram(P.p);
      setCam(P, px,py,pz, rx,ry,rz, ux,uy,uz, fx,fy,fz, FOCAL, aspect);
      gl.uniform1f(P.u.uSegs, SEGS);
      gl.uniform1f(P.u.uWidth, 0.075);
      gl.drawArrays(gl.TRIANGLES, 0, LINE_VERTS);
    }
    if(toggles.dust){
      const P = progDust;
      gl.useProgram(P.p);
      setCam(P, px,py,pz, rx,ry,rz, ux,uy,uz, fx,fy,fz, FOCAL, aspect);
      gl.uniform1f(P.u.uPxScale, rtFX.h*0.012);
      gl.drawArrays(gl.POINTS, 0, PT_COUNT);
    }
    gl.disable(gl.BLEND);
  }

  /* pass 2: メイン（メタボール） */
  gl.bindFramebuffer(gl.FRAMEBUFFER, rtScene.fb);
  gl.viewport(0,0,W,H);
  {
    const P = progMain;
    gl.useProgram(P.p);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, rtEnv.tex);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, rtFX.tex);
    gl.uniform1i(P.u.uEnv, 0);
    gl.uniform1i(P.u.uFX, 1);
    gl.uniform2f(P.u.uRes, W, H);
    gl.uniform1f(P.u.uTime, simTime);
    gl.uniform3f(P.u.uCamPos, px,py,pz);
    gl.uniform3f(P.u.uRight, rx,ry,rz);
    gl.uniform3f(P.u.uUp, ux,uy,uz);
    gl.uniform3f(P.u.uFwd, fx,fy,fz);
    gl.uniform1f(P.u.uFocal, FOCAL);
    gl.uniform1i(P.u.uCount, n);
    gl.uniform4fv(P.u.uB, arrB);
    gl.uniform3f(P.u.uBoundC, mx,my,mz);
    gl.uniform1f(P.u.uBoundR, boundR);
    gl.uniform1f(P.u.uK, params.fuse);
    gl.uniform1f(P.u.uIOR, params.ior);
    gl.uniform1f(P.u.uWobble, params.wobble);
    gl.uniform1f(P.u.uFilm, params.film);
    gl.uniform1f(P.u.uWater, params.water);
    gl.uniform1f(P.u.uSaturation, params.saturation);
    gl.uniform1f(P.u.uHueBias, params.hueBias);
    gl.uniform3fv(P.u.uLightDir, lightDir);
    gl.uniform3fv(P.u.uLightCol, lightCol);
    if(!HDR) gl.uniform1f(P.u.uExposure, params.exposure);
    drawQuad();
  }

  /* pass 3: ブルーム */
  gl.useProgram(progDown.p);
  gl.uniform1i(progDown.u.uTex, 0);
  gl.uniform1f(progDown.u.uThreshold, HDR ? 1.0 : 0.80);
  gl.uniform1f(progDown.u.uKnee, 0.6);
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

  /* pass 4: 合成 → canvas */
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
    if(HDR) gl.uniform1f(P.u.uExposure, params.exposure);
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
function startLoop(){ if(!raf){ prevTs = performance.now(); raf = requestAnimationFrame(frame); } }
function stopLoop(){ if(raf){ cancelAnimationFrame(raf); raf = 0; } }
document.addEventListener('visibilitychange', function(){
  if(document.hidden) stopLoop(); else startLoop();
});

resize();
startLoop();

} /* end boot() */

if('requestIdleCallback' in window){
  requestAnimationFrame(function(){ requestIdleCallback(boot, {timeout: 300}); });
}else{
  requestAnimationFrame(function(){ requestAnimationFrame(boot); });
}

})();