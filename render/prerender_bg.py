#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
prerender_bg.py
================================================================================
背景アニメーション（bubble-bg.js が描画し、liquid-bg.js が水として歪ませる
合成レイヤー）を、決定論的な固定シード・固定タイムステップの「仮想クロック」で
駆動しながら PREROLL_SECONDS 秒ぶんだけ 1 フレームずつスクリーンショットし、
最後に ffmpeg で mp4 に結合するオフラインレンダラです。

なぜ仮想クロックが必要か
--------------------------------------------------------------------------------
実時間（performance.now() の素の値）で録画すると、レンダリングマシンの
速度や録画のコマ落ちによって「動画の1フレーム = 何秒分のシミュレーション」が
毎回変わってしまい、本番ページ側の早送り（bubble-bg.js の fast-forward）と
1フレーム単位で一致しなくなります。
そこでこのスクリプトは Playwright の add_init_script で
performance.now() / requestAnimationFrame を「仮想時間」で動く実装に
差し替え、必ず 1/--fps 秒刻みで時間を進めます。本番ページ側の
bubble-bg.js も同じ刻み幅 (FF_STEP = 1/60) ・同じ乱数シード
(window.BG_FIXED_SEED) で早送りするため、mp4 の最終フレームと、
ページが実描画を始める瞬間の状態がフレーム単位でほぼ一致します。

前提条件
--------------------------------------------------------------------------------
  pip install playwright
  playwright install chromium
  ffmpeg が PATH 上にあること

使い方
--------------------------------------------------------------------------------
  python prerender_bg.py \
      --seconds 10 \
      --fps 60 \
      --seed 20260901 \
      --width 1920 --height 1080 \
      --out ../assets/bg-preroll.mp4

  * --seconds / --seed は、必ず index.html の
    window.BG_PREROLL_SECONDS / window.BG_FIXED_SEED と同じ値にしてください。
    値をどちらか一方だけ変えると、動画とライブ描画の状態がずれます。
  * --width/--height は録画する解像度（= 出力mp4の解像度）です。実際の
    表示ではCSSで画面いっぱいに引き伸ばされる（object-fit: cover）ので、
    配信先で想定する代表的なウィンドウサイズに合わせておけば十分です。

既知の制約
--------------------------------------------------------------------------------
  - liquid-bg.js 側の自動水滴（AUTO_DROPS）は Math.random() で発生タイミングを
    決めており、シードで固定していません。そのため動画に写る自動水滴の
    タイミングと、実際のライブ描画の水滴タイミングは一致しません
    （見た目は一瞬の波紋なので実用上はほぼ気になりません）。
  - 録画開始からBubbleBG.readyになるまでの間にも仮想クロックは進むため、
    録画0フレーム目は本番の t=0 から理論上 1/fps 秒ほどずれます。
    アンビエントな漂うようなアニメーションのため実害はありません。
"""
import argparse
import asyncio
import os
import shutil
import subprocess
import sys
import tempfile

try:
    from playwright.async_api import async_playwright
except ImportError:
    print("playwright が見つかりません。`pip install playwright` のあと "
          "`playwright install chromium` を実行してください。", file=sys.stderr)
    sys.exit(1)


INIT_SCRIPT_TEMPLATE = """
(() => {
  // ---- 決定論的な仮想クロック --------------------------------------
  // performance.now() と requestAnimationFrame を仮想時間で駆動し、
  // 実機の性能や録画のコマ落ちに左右されない、完全に再現可能な
  // タイムステップ (1000/%(fps)s ms 固定) でアニメーションを進める。
  const STEP_MS = 1000 / %(fps)s;
  let virtualNow = 0;
  window.performance.now = () => virtualNow;

  let rafCallbacks = [];
  window.requestAnimationFrame = (cb) => { rafCallbacks.push(cb); return rafCallbacks.length; };
  window.cancelAnimationFrame = () => {};

  window.__advanceFrame = () => {
    virtualNow += STEP_MS;
    const cbs = rafCallbacks; rafCallbacks = [];
    for (const cb of cbs) { try { cb(virtualNow); } catch (e) { console.error(e); } }
    return virtualNow;
  };

  // 本番の index.html と必ず同じ値を渡すこと
  window.BG_FIXED_SEED = %(seed)s;
  window.BG_PREROLL_SECONDS = %(seconds)s;
  window.BG_MANUAL_REVEAL = false; // ハーネスでは即座に実時間(=仮想時間)で動かす
})();
"""


async def wait_until_ready(page, max_real_wait_s: float = 60.0):
    """boot() 完了 (= window.BubbleBG.ready) まで、仮想クロックを刻みながら待つ。
    boot() 自体はシェーダコンパイル等で実時間がかかるため、ここは実時間で
    ポーリングしてよい（結果に写るのは仮想クロックの進みだけなので、
    実時間の揺らぎは録画内容に影響しない）。"""
    loop = asyncio.get_event_loop()
    start = loop.time()
    while loop.time() - start < max_real_wait_s:
        await page.evaluate("window.__advanceFrame && window.__advanceFrame()")
        ready = await page.evaluate(
            "!!(window.BubbleBG && window.BubbleBG.ready)"
        )
        if ready:
            return
        await asyncio.sleep(0.05)
    raise RuntimeError(
        "window.BubbleBG.ready が既定時間内に true になりませんでした。"
        "WebGL2 が使えない環境か、harness.html の読み込みに失敗している可能性があります。"
    )


async def capture_frames(page, out_dir: str, total_frames: int):
    digits = len(str(total_frames))
    for i in range(total_frames):
        await page.evaluate("window.__advanceFrame()")
        path = os.path.join(out_dir, f"frame_{i:0{digits}d}.png")
        await page.screenshot(path=path)
        if (i + 1) % 60 == 0 or i == total_frames - 1:
            print(f"  captured {i + 1}/{total_frames} frames", file=sys.stderr)


def encode_mp4(frame_glob_pattern: str, fps: int, out_path: str):
    if shutil.which("ffmpeg") is None:
        raise RuntimeError("ffmpeg が見つかりません。PATH に追加してください。")
    os.makedirs(os.path.dirname(os.path.abspath(out_path)) or ".", exist_ok=True)
    cmd = [
        "ffmpeg", "-y",
        "-framerate", str(fps),
        "-i", frame_glob_pattern,
        "-vf", "format=yuv420p",
        "-c:v", "libx264",
        "-crf", "18",
        "-movflags", "+faststart",
        out_path,
    ]
    subprocess.run(cmd, check=True)


async def main_async(args):
    harness_path = os.path.abspath(
        os.path.join(os.path.dirname(__file__), "harness.html")
    )
    if not os.path.exists(harness_path):
        raise FileNotFoundError(f"harness.html が見つかりません: {harness_path}")

    init_script = INIT_SCRIPT_TEMPLATE % {
        "fps": args.fps,
        "seed": args.seed,
        "seconds": args.seconds,
    }

    total_frames = int(round(args.seconds * args.fps))

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            args=[
                # headless Chromium は既定でGPUを無効化しており、そのままだと
                # WebGL2のコンテキスト取得に失敗して canvas が真っ黒のままになる。
                # SwiftShader (ソフトウェアGL実装) を明示的に有効化する。
                "--use-gl=angle",
                "--use-angle=swiftshader",
                "--enable-webgl",
                "--enable-webgl2",
                "--ignore-gpu-blocklist",
                "--enable-unsafe-swiftshader",
                "--disable-gpu-sandbox",
                "--no-sandbox",
            ]
        )
        page = await browser.new_page(
            viewport={"width": args.width, "height": args.height}
        )
        await page.add_init_script(init_script)
        await page.goto(f"file://{harness_path}")

        gl_info = await page.evaluate("""
            () => {
                const c = document.createElement('canvas');
                const gl = c.getContext('webgl2');
                if (!gl) return null;
                const dbg = gl.getExtension('WEBGL_debug_renderer_info');
                return {
                    vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
                    renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
                };
            }
        """)
        if gl_info is None:
            raise RuntimeError(
                "WebGL2 context を取得できませんでした。headless Chromiumの起動引数 "
                "(--use-gl=angle --use-angle=swiftshader 等) を確認してください。"
            )
        print(f"WebGL2 OK: vendor={gl_info['vendor']!r} renderer={gl_info['renderer']!r}",
              file=sys.stderr)

        print("waiting for bubble-bg.js to finish initializing "
              "(this mirrors the real page's slow first load)...", file=sys.stderr)
        await wait_until_ready(page, max_real_wait_s=args.max_wait)

        with tempfile.TemporaryDirectory(prefix="bg-preroll-") as tmp:
            print(f"capturing {total_frames} frames at {args.fps}fps "
                  f"({args.seconds}s) ...", file=sys.stderr)
            await capture_frames(page, tmp, total_frames)

            digits = len(str(total_frames))
            pattern = os.path.join(tmp, f"frame_%0{digits}d.png")
            print(f"encoding -> {args.out}", file=sys.stderr)
            encode_mp4(pattern, args.fps, args.out)

        await browser.close()

    print(f"done: {args.out}", file=sys.stderr)


def parse_args():
    ap = argparse.ArgumentParser(description=__doc__,
                                  formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--seconds", type=float, default=10.0,
                     help="動画の長さ（= index.html の BG_PREROLL_SECONDS と一致させること）")
    ap.add_argument("--fps", type=int, default=60, help="固定フレームレート")
    ap.add_argument("--seed", type=int, default=20260901,
                     help="バブル初期化シード（= index.html の BG_FIXED_SEED と一致させること）")
    ap.add_argument("--width", type=int, default=1920)
    ap.add_argument("--height", type=int, default=1080)
    ap.add_argument("--max-wait", type=float, default=60.0,
                     help="boot()完了を待つ最大の実時間（秒）")
    ap.add_argument("--out", type=str, default="../assets/bg-preroll.mp4")
    return ap.parse_args()


if __name__ == "__main__":
    asyncio.run(main_async(parse_args()))