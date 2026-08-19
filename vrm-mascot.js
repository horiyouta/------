/* ============================================================================
   vrm-mascot.js — トップページ限定の VRM マスコット（tiramisu）
   ----------------------------------------------------------------------------
   ベースは「VRM Desktop Mascot」デモ（idle.fbx 待機モーション + マウス追従の
   視線/首振り + フレーミング自動計算）。このサイト用に以下を変更している。

     1. 開発者用のホットキー調整（Q/E/W/S/Z/X/I）は全て削除。CONFIG の数値は
        参考元のまま変更せず使用する。
     2. トップページ（#mode-0）が非表示になったら描画ループを止め、再表示で
        再開する（他モードでの無駄な GPU/CPU 消費を防ぐ）。
     3. liquid-bg.js の波紋API（window.LiquidBG.ripple）と連動し、マスコットが
        画面下端から「水面から現れた」ように見せる淡い波紋を出す（任意演出）。
     4. 見た目は style.css 側の #vrmStage / #vrmGlow / #vrmHud で
        「ゆめふわ×サイバー×流体」のガラス質感に合わせている。
   ========================================================================= */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';

const stageEl = document.getElementById('vrmStage');
const mode0El = document.getElementById('mode-0');
if (!stageEl || !mode0El) {
  // このページに配置先が無ければ何もしない（トップページ専用のため）
} else {
  runMascot();
}

function runMascot() {
  const canvas = document.getElementById('vrmCanvas');
  const hud = document.getElementById('vrmHud');
  const stage = stageEl;

  /* ================================================================
   * 調整用パラメータ（参考元 CONFIG をそのまま流用。パスのみサイトの
   * ./data/ 規約に合わせてある。他のプロジェクトで使う場合はここを
   * 差し替えれば良い）
   * ================================================================ */
  const CONFIG = {
    vrmUrl: './data/tiramisu.vrm',
    fbxUrl: './data/idle.fbx',

    framing: {
      headroom: 0.26,
      below:    0.72,
      margin:   0.5,
      offsetY:  0.15,
      widthUse: 0.80,
    },

    gaze: {
      invertY:   true,
      rangeX:    1.60,
      rangeY:    1.10,
      smooth:    8.0,
      headYaw:   0.30,
      headPitch: 0.20,
    },

    light: {
      exposure:  1.25,
      hemi:      2.10,
      ambient:   0.55,
      key:       1.55,
      fill:      0.75,
      rim:       0.90,
      flattenShade: 0.60,
      shadingShift: 0.28,
      giEqualization: 0.90,
    },
  };

  /* Mixamo リグ名 → VRM ヒューマノイドボーン名 */
  const MIXAMO_TO_VRM = {
    mixamorigHips:              'hips',
    mixamorigSpine:             'spine',
    mixamorigSpine1:            'chest',
    mixamorigSpine2:            'upperChest',
    mixamorigNeck:              'neck',
    mixamorigHead:              'head',

    mixamorigLeftShoulder:      'leftShoulder',
    mixamorigLeftArm:           'leftUpperArm',
    mixamorigLeftForeArm:       'leftLowerArm',
    mixamorigLeftHand:          'leftHand',
    mixamorigLeftHandThumb1:    'leftThumbMetacarpal',
    mixamorigLeftHandThumb2:    'leftThumbProximal',
    mixamorigLeftHandThumb3:    'leftThumbDistal',
    mixamorigLeftHandIndex1:    'leftIndexProximal',
    mixamorigLeftHandIndex2:    'leftIndexIntermediate',
    mixamorigLeftHandIndex3:    'leftIndexDistal',
    mixamorigLeftHandMiddle1:   'leftMiddleProximal',
    mixamorigLeftHandMiddle2:   'leftMiddleIntermediate',
    mixamorigLeftHandMiddle3:   'leftMiddleDistal',
    mixamorigLeftHandRing1:     'leftRingProximal',
    mixamorigLeftHandRing2:     'leftRingIntermediate',
    mixamorigLeftHandRing3:     'leftRingDistal',
    mixamorigLeftHandPinky1:    'leftLittleProximal',
    mixamorigLeftHandPinky2:    'leftLittleIntermediate',
    mixamorigLeftHandPinky3:    'leftLittleDistal',

    mixamorigRightShoulder:     'rightShoulder',
    mixamorigRightArm:          'rightUpperArm',
    mixamorigRightForeArm:      'rightLowerArm',
    mixamorigRightHand:         'rightHand',
    mixamorigRightHandThumb1:   'rightThumbMetacarpal',
    mixamorigRightHandThumb2:   'rightThumbProximal',
    mixamorigRightHandThumb3:   'rightThumbDistal',
    mixamorigRightHandIndex1:   'rightIndexProximal',
    mixamorigRightHandIndex2:   'rightIndexIntermediate',
    mixamorigRightHandIndex3:   'rightIndexDistal',
    mixamorigRightHandMiddle1:  'rightMiddleProximal',
    mixamorigRightHandMiddle2:  'rightMiddleIntermediate',
    mixamorigRightHandMiddle3:  'rightMiddleDistal',
    mixamorigRightHandRing1:    'rightRingProximal',
    mixamorigRightHandRing2:    'rightRingIntermediate',
    mixamorigRightHandRing3:    'rightRingDistal',
    mixamorigRightHandPinky1:   'rightLittleProximal',
    mixamorigRightHandPinky2:   'rightLittleIntermediate',
    mixamorigRightHandPinky3:   'rightLittleDistal',

    mixamorigLeftUpLeg:         'leftUpperLeg',
    mixamorigLeftLeg:           'leftLowerLeg',
    mixamorigLeftFoot:          'leftFoot',
    mixamorigLeftToeBase:       'leftToes',
    mixamorigRightUpLeg:        'rightUpperLeg',
    mixamorigRightLeg:          'rightLowerLeg',
    mixamorigRightFoot:         'rightFoot',
    mixamorigRightToeBase:      'rightToes',
  };

  /* ================================================================
   * 基本セットアップ
   * ================================================================ */
  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
    premultipliedAlpha: false,
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.LinearToneMapping;
  renderer.toneMappingExposure = CONFIG.light.exposure;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 30);
  camera.position.set(0, 1.25, 2.0);

  const hemiLight = new THREE.HemisphereLight(0xffffff, 0x8899aa, CONFIG.light.hemi);
  scene.add(hemiLight);

  const ambientLight = new THREE.AmbientLight(0xffffff, CONFIG.light.ambient);
  scene.add(ambientLight);

  const keyLight = new THREE.DirectionalLight(0xfff6ea, CONFIG.light.key);
  keyLight.position.set(1.1, 2.0, 1.8);
  scene.add(keyLight);

  const fillLight = new THREE.DirectionalLight(0xdfeaff, CONFIG.light.fill);
  fillLight.position.set(-1.6, 0.9, 1.0);
  scene.add(fillLight);

  const rimLight = new THREE.DirectionalLight(0xffffff, CONFIG.light.rim);
  rimLight.position.set(-0.6, 1.6, -2.0);
  scene.add(rimLight);

  function resize() {
    const w = Math.max(1, Math.floor(stage.clientWidth));
    const h = Math.max(1, Math.floor(stage.clientHeight));
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    frameCamera();
  }

  /* ================================================================
   * Mixamo FBX → VRM 用 AnimationClip 変換
   * ================================================================ */
  function normalizeRigName(name) {
    return name.replace(/:/g, '').replace(/^mixamorig\d+/i, 'mixamorig');
  }

  async function loadMixamoAnimation(url, vrm) {
    const asset = await new FBXLoader().loadAsync(url);
    const clip =
      THREE.AnimationClip.findByName(asset.animations, 'mixamo.com') ??
      asset.animations[0];

    if (!clip) throw new Error(`${url} にアニメーションが含まれていません`);

    const rigNodes = new Map();
    asset.traverse((o) => {
      const key = normalizeRigName(o.name);
      if (!rigNodes.has(key)) rigNodes.set(key, o);
    });

    const _v = new THREE.Vector3();
    const hipsNode = rigNodes.get('mixamorigHips');
    const motionHipsHeight = hipsNode ? hipsNode.position.y : 1;

    const vrmHips = vrm.humanoid.getNormalizedBoneNode('hips');
    const vrmHipsY = vrmHips.getWorldPosition(_v).y;
    const vrmRootY = vrm.scene.getWorldPosition(_v).y;
    const hipsPositionScale =
      Math.abs(vrmHipsY - vrmRootY) / (Math.abs(motionHipsHeight) || 1);

    const isVRM0 = vrm.meta?.metaVersion === '0';

    const restRotationInverse = new THREE.Quaternion();
    const parentRestWorldRotation = new THREE.Quaternion();
    const quat = new THREE.Quaternion();
    const tracks = [];

    for (const track of clip.tracks) {
      const [rawName, propertyName] = track.name.split('.');
      const rigName = normalizeRigName(rawName);

      const vrmBoneName = MIXAMO_TO_VRM[rigName];
      if (!vrmBoneName) continue;

      const vrmNode = vrm.humanoid.getNormalizedBoneNode(vrmBoneName);
      const rigNode = rigNodes.get(rigName);
      if (!vrmNode || !rigNode || !rigNode.parent) continue;

      rigNode.getWorldQuaternion(restRotationInverse).invert();
      rigNode.parent.getWorldQuaternion(parentRestWorldRotation);

      if (track instanceof THREE.QuaternionKeyframeTrack) {
        const values = Array.from(track.values);
        for (let i = 0; i < values.length; i += 4) {
          quat
            .fromArray(values, i)
            .premultiply(parentRestWorldRotation)
            .multiply(restRotationInverse);
          if (isVRM0) { quat.x = -quat.x; quat.z = -quat.z; }
          quat.toArray(values, i);
        }
        tracks.push(
          new THREE.QuaternionKeyframeTrack(
            `${vrmNode.name}.quaternion`,
            Array.from(track.times),
            values,
          ),
        );
      } else if (
        track instanceof THREE.VectorKeyframeTrack &&
        propertyName === 'position' &&
        vrmBoneName === 'hips'
      ) {
        const values = Array.from(track.values).map(
          (v, i) => (isVRM0 && i % 3 !== 1 ? -v : v) * hipsPositionScale,
        );
        tracks.push(
          new THREE.VectorKeyframeTrack(
            `${vrmNode.name}.position`,
            Array.from(track.times),
            values,
          ),
        );
      }
    }

    if (tracks.length === 0) {
      throw new Error('変換後のトラックが 0 本です（Mixamo リグ名が想定外の可能性）');
    }

    return new THREE.AnimationClip('vrmIdle', clip.duration, tracks);
  }

  /* ================================================================
   * MToon を明るめに寄せる（サイトの淡いガラス背景に馴染ませる）
   * ================================================================ */
  function brightenMaterials(root) {
    const L = CONFIG.light;
    root.traverse((obj) => {
      const mats = Array.isArray(obj.material)
        ? obj.material
        : obj.material ? [obj.material] : [];

      for (const m of mats) {
        if (m.shadeColorFactor && m.color) {
          m.shadeColorFactor.lerp(m.color, L.flattenShade);
          if (typeof m.shadingShiftFactor === 'number') {
            m.shadingShiftFactor = THREE.MathUtils.clamp(
              m.shadingShiftFactor + L.shadingShift, -1, 1,
            );
          }
          if (typeof m.shadingToonyFactor === 'number') {
            m.shadingToonyFactor = Math.min(1, m.shadingToonyFactor + 0.05);
          }
          if (typeof m.giEqualizationFactor === 'number') {
            m.giEqualizationFactor = L.giEqualization;
          }
          m.needsUpdate = true;
        } else if (m.isMeshStandardMaterial) {
          m.envMapIntensity = 1.0;
          m.needsUpdate = true;
        }
      }
    });
  }

  /* ================================================================
   * 状態
   * ================================================================ */
  let vrm = null;
  let mixer = null;
  let lookTarget = null;
  let ready = false;

  const modelBox = new THREE.Box3();
  const headRestPosition = new THREE.Vector3(0, 1.35, 0);

  const pointer = { x: window.innerWidth * 0.5, y: window.innerHeight * 0.35, active: false };
  const gaze = { x: 0, y: 0 };

  const clock = new THREE.Clock();
  let blinkTimer = 0;
  let nextBlink = 1.5 + Math.random() * 3;
  let blinkPhase = -1;

  window.addEventListener('pointermove', (e) => {
    pointer.x = e.clientX;
    pointer.y = e.clientY;
    pointer.active = true;
  }, { passive: true });

  window.addEventListener('pointerleave', () => { pointer.active = false; });

  /* ================================================================
   * カメラのフレーミング
   * ================================================================ */
  function frameCamera() {
    if (!vrm) return;
    const f = CONFIG.framing;

    const top = modelBox.max.y + f.headroom;
    const bottom = Math.max(modelBox.min.y, headRestPosition.y - f.below);
    const centerY = (top + bottom) * 0.5 + f.offsetY;

    const height = Math.max(0.3, top - bottom);
    const width = Math.max(0.3, (modelBox.max.x - modelBox.min.x) * f.widthUse);

    const vFov = THREE.MathUtils.degToRad(camera.fov);
    const hFov = 2 * Math.atan(Math.tan(vFov * 0.5) * camera.aspect);

    const distByHeight = (height * 0.5) / Math.tan(vFov * 0.5);
    const distByWidth  = (width  * 0.5) / Math.tan(hFov * 0.5);
    const dist = Math.max(distByHeight, distByWidth) * f.margin;

    camera.position.set(0, centerY, dist);
    camera.lookAt(0, centerY, 0);
    camera.updateProjectionMatrix();
  }

  /* ================================================================
   * HUD（読み込み表示のみ。調整用ホットキーは持たない）
   * ================================================================ */
  function setHud(text, isError = false) {
    if (!hud) return;
    hud.textContent = text;
    hud.classList.toggle('error', isError);
    hud.classList.remove('is-hidden');
  }
  let hudTimer = 0;
  function flashHud(text) {
    setHud(text);
    clearTimeout(hudTimer);
    hudTimer = setTimeout(() => hud && hud.classList.add('is-hidden'), 1600);
  }

  /* ================================================================
   * liquid-bg.js との連動 — 画面下端から「水面から現れた」演出
   * ================================================================ */
  function rippleAtStageFoot(amp) {
    if (!window.LiquidBG || typeof window.LiquidBG.ripple !== 'function') return;
    const rect = stage.getBoundingClientRect();
    const x = (rect.left + rect.width * 0.5) / window.innerWidth;
    // liquid-bg の uv は y:0が下・1が上。画面下端に近いほど y は小さい。
    const y = 1 - (rect.bottom - rect.height * 0.06) / window.innerHeight;
    window.LiquidBG.ripple(
      Math.min(0.98, Math.max(0.02, x)),
      Math.min(0.98, Math.max(0.02, y)),
      amp,
    );
  }

  /* ================================================================
   * 読み込み
   * ================================================================ */
  async function init() {
    const loader = new GLTFLoader();
    loader.crossOrigin = 'anonymous';
    loader.register((parser) => new VRMLoaderPlugin(parser));

    setHud('モデル読み込み中…');
    const gltf = await loader.loadAsync(CONFIG.vrmUrl, (progress) => {
      if (progress.total) {
        const pct = Math.round((progress.loaded / progress.total) * 100);
        setHud(`モデル読み込み中… ${pct}%`);
      }
    });

    vrm = gltf.userData.vrm;

    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    if (typeof VRMUtils.combineSkeletons === 'function') {
      VRMUtils.combineSkeletons(gltf.scene);
    }
    VRMUtils.rotateVRM0(vrm);

    vrm.scene.traverse((obj) => { obj.frustumCulled = false; });
    brightenMaterials(vrm.scene);
    scene.add(vrm.scene);

    lookTarget = new THREE.Object3D();
    scene.add(lookTarget);
    if (vrm.lookAt) vrm.lookAt.target = lookTarget;

    vrm.scene.updateMatrixWorld(true);
    vrm.humanoid.getNormalizedBoneNode('head').getWorldPosition(headRestPosition);
    modelBox.setFromObject(vrm.scene);

    resize();
    lookTarget.position.copy(headRestPosition).add(new THREE.Vector3(0, 0, 1.3));

    setHud('モーション読み込み中…');

    const clip = await loadMixamoAnimation(CONFIG.fbxUrl, vrm);
    mixer = new THREE.AnimationMixer(vrm.scene);
    const action = mixer.clipAction(clip);
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.play();

    ready = true;
    stage.classList.add('vrm-ready');
    flashHud('準備完了');
    rippleAtStageFoot(0.018); // 登場時にふわっと水面が揺れる演出
  }

  /* ================================================================
   * マウス追従（視線 + 首）
   * ================================================================ */
  const _proj = new THREE.Vector3();
  const _euler = new THREE.Euler();
  const _quat = new THREE.Quaternion();

  function updateLook(delta) {
    if (!vrm || !lookTarget) return;
    const G = CONFIG.gaze;

    const rect = stage.getBoundingClientRect();
    _proj.copy(headRestPosition).project(camera);
    const headScreenX = rect.left + (_proj.x * 0.5 + 0.5) * rect.width;
    const headScreenY = rect.top + (-_proj.y * 0.5 + 0.5) * rect.height;

    let tx = 0;
    let ty = 0;
    if (pointer.active) {
      const half = Math.max(window.innerWidth, window.innerHeight) * 0.5;
      const yDir = G.invertY ? -1 : 1;
      tx = THREE.MathUtils.clamp((pointer.x - headScreenX) / half, -1.4, 1.4);
      ty = THREE.MathUtils.clamp(((headScreenY - pointer.y) / half) * yDir, -1.2, 1.2);
    }

    const k = 1 - Math.exp(-delta * G.smooth);
    gaze.x += (tx - gaze.x) * k;
    gaze.y += (ty - gaze.y) * k;

    lookTarget.position.set(
      headRestPosition.x + gaze.x * G.rangeX,
      headRestPosition.y + gaze.y * G.rangeY,
      headRestPosition.z + 1.3,
    );

    const yaw   = THREE.MathUtils.clamp(gaze.x * G.headYaw,  -0.42, 0.42);
    const pitch = THREE.MathUtils.clamp(-gaze.y * G.headPitch, -0.26, 0.26);

    applyBoneOffset('head',  yaw * 0.60, pitch * 0.60);
    applyBoneOffset('neck',  yaw * 0.25, pitch * 0.25);
    applyBoneOffset('spine', yaw * 0.12, 0);
  }

  function applyBoneOffset(boneName, yaw, pitch) {
    const node = vrm.humanoid.getNormalizedBoneNode(boneName);
    if (!node) return;
    _euler.set(pitch, yaw, 0, 'YXZ');
    _quat.setFromEuler(_euler);
    node.quaternion.multiply(_quat);
  }

  let sinceLastRipple = 0;
  function updateBlink(delta) {
    const em = vrm?.expressionManager;
    if (!em) return;

    if (blinkPhase < 0) {
      blinkTimer += delta;
      if (blinkTimer >= nextBlink) {
        blinkTimer = 0;
        nextBlink = 1.8 + Math.random() * 4;
        blinkPhase = 0;
        // まばたきに合わせてごく淡い波紋を一発（水辺の生き物感の演出。任意）
        sinceLastRipple += 1;
        if (sinceLastRipple >= 2) { // 毎回だとうるさいので間引く
          sinceLastRipple = 0;
          rippleAtStageFoot(0.006);
        }
      }
      em.setValue('blink', 0);
      return;
    }

    blinkPhase += delta;
    const duration = 0.16;
    if (blinkPhase >= duration) {
      blinkPhase = -1;
      em.setValue('blink', 0);
    } else {
      em.setValue('blink', Math.sin((blinkPhase / duration) * Math.PI));
    }
  }

  /* ================================================================
   * メインループ — #mode-0 が非表示の間は完全に止める
   * ================================================================ */
  let active = !mode0El.classList.contains('hidden');
  let rafId = null;

  function frame() {
    rafId = requestAnimationFrame(frame);
    const delta = Math.min(clock.getDelta(), 0.1);

    if (mixer) mixer.update(delta);
    updateLook(delta);
    updateBlink(delta);
    if (vrm) vrm.update(delta);

    renderer.render(scene, camera);
  }

  function startLoop() {
    if (rafId !== null) return;
    clock.getDelta(); // 再開直前の空白時間を捨てる
    frame();
  }
  function stopLoop() {
    if (rafId === null) return;
    cancelAnimationFrame(rafId);
    rafId = null;
  }

  function setActive(on) {
    active = !!on && !document.hidden;
    if (active) startLoop(); else stopLoop();
  }

  // #mode-0 の class="... hidden" 切り替え（script.js の setMode）を監視
  const modeObserver = new MutationObserver(() => {
    setActive(!mode0El.classList.contains('hidden'));
  });
  modeObserver.observe(mode0El, { attributes: true, attributeFilter: ['class'] });

  document.addEventListener('visibilitychange', () => {
    setActive(!mode0El.classList.contains('hidden'));
  });

  resize();
  new ResizeObserver(resize).observe(stage);
  window.addEventListener('resize', resize);

  setActive(active);

  init().catch((err) => {
    console.error('[vrm-mascot]', err);
    setHud(`読み込み失敗: ${err.message}`, true);
  });
}