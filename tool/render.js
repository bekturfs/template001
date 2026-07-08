#!/usr/bin/env node
/*
 * scrollcast — рендер сайта в видео с плавным «пружинным» скроллом.
 *
 * Как это работает: страница загружается в headless Chromium, после чего
 * виртуальное время браузера ставится на паузу и продвигается вручную
 * ровно на 1/fps за кадр. Позиция скролла для каждого кадра берётся из
 * математической кривой (недодемпфированная пружина — лёгкий «накат» и
 * мягкая остановка, как палец на iOS). Поэтому итоговое видео идеально
 * гладкое независимо от скорости машины, а все CSS-анимации страницы
 * идут в правильном темпе.
 *
 * Использование:
 *   node render.js <url> [опции]
 *
 * Опции (все необязательны):
 *   --out <file>          выходной mp4 (по умолчанию render.mp4)
 *   --width <px>          ширина вьюпорта (390)
 *   --height <px>         высота вьюпорта (844)
 *   --scale <n>           devicePixelRatio → разрешение видео (2)
 *   --fps <n>             кадров в секунду (30)
 *   --tap <selector>      кликнуть элемент перед скроллом (заставки, конверты)
 *   --wait <sec>          сколько показывать страницу до клика (2.5)
 *   --settle <sec>        пауза после клика до начала скролла (4)
 *   --stops <sel,sel,..>  секции-остановки; без опции — экраны по 88% высоты
 *   --dwell <sec>         пауза на каждой остановке (2.4)
 *   --travel <sec>        длительность проезда между остановками (1.6)
 *   --end-hold <sec>      сколько держать последний кадр (1.5)
 *   --music <file>        аудиодорожка (mp3/m4a)
 *   --music-start <sec>   с какой секунды трека начинать (0)
 *   --fade-in <sec>       нарастание громкости (8)
 *   --fade-out <sec>      затухание в конце (2.5)
 *   --ffmpeg <path>       бинарь ffmpeg (по умолчанию ffmpeg из PATH или $FFMPEG)
 *   --chromium <path>     бинарь Chromium (по умолчанию channel playwright)
 *   --keep-frames         не удалять папку с кадрами
 *
 * Музыка стартует в момент клика --tap (или с нулевой секунды видео,
 * если --tap не задан) — так звук совпадает с «открытием» страницы.
 */
const { chromium } = require('playwright-core');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ── разбор аргументов ──────────────────────────────────────────
const argv = process.argv.slice(2);
if (!argv.length || argv[0].startsWith('--')) {
  console.error('Использование: node render.js <url> [опции] (см. шапку файла)');
  process.exit(1);
}
const url = argv[0];
const opt = (name, def) => {
  const i = argv.indexOf('--' + name);
  return i > -1 ? argv[i + 1] : def;
};
const flag = name => argv.includes('--' + name);

const OUT      = opt('out', 'render.mp4');
const WIDTH    = +opt('width', 390);
const HEIGHT   = +opt('height', 844);
const SCALE    = +opt('scale', 2);
const FPS      = +opt('fps', 30);
const TAP      = opt('tap', null);
const WAIT     = +opt('wait', 2.5);
const SETTLE   = +opt('settle', 4);
const STOPS    = opt('stops', null);
const DWELL    = +opt('dwell', 2.4);
const TRAVEL   = +opt('travel', 1.6);
const ENDHOLD  = +opt('end-hold', 1.5);
const MUSIC    = opt('music', null);
const MSTART   = +opt('music-start', 0);
const FADEIN   = +opt('fade-in', 8);
const FADEOUT  = +opt('fade-out', 2.5);
const FFMPEG   = opt('ffmpeg', process.env.FFMPEG || 'ffmpeg');
const CHROMIUM = opt('chromium', process.env.CHROMIUM_PATH || undefined);

// пружина: быстрый старт, мягкое торможение, едва заметный перелёт
function springEase(u) {
  if (u >= 1) return 1;
  const zeta = 0.82, omega = 9;
  const wd = omega * Math.sqrt(1 - zeta * zeta);
  return 1 - Math.exp(-zeta * omega * u) *
    (Math.cos(wd * u) + (zeta * omega / wd) * Math.sin(wd * u));
}

(async () => {
  const launchArgs = ['--no-sandbox', '--disable-gpu', '--mute-audio'];
  // проксируемые окружения (например, облачные песочницы)
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (proxy && !url.startsWith('file:')) {
    launchArgs.push(`--proxy-server=${proxy}`, '--ignore-certificate-errors');
  }
  const browser = await chromium.launch({
    executablePath: CHROMIUM,
    args: launchArgs,
  });
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: SCALE,
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);

  console.log('Загружаю', url);
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
  await page.evaluate(() => document.fonts ? document.fonts.ready : null).catch(() => {});
  await page.waitForTimeout(700);

  // план остановок скролла
  const plan = await page.evaluate(sel => {
    const max = Math.max(0,
      document.documentElement.scrollHeight - window.innerHeight);
    let stops;
    if (sel) {
      stops = sel.split(',').map(s => {
        const el = document.querySelector(s.trim());
        return el ? Math.min(el.getBoundingClientRect().top + window.scrollY, max) : null;
      }).filter(v => v !== null);
    } else {
      stops = [];
      const step = window.innerHeight * 0.88;
      for (let y = step; y < max - 40; y += step) stops.push(y);
      stops.push(max);
    }
    return { max, stops };
  }, STOPS);
  console.log(`Высота прокрутки: ${plan.max}px, остановок: ${plan.stops.length}`);

  // таймлайн: [время старта сегмента, функция y(t)]
  const segs = [];
  let t = 0, curY = 0;
  const hold = (dur, y) => { segs.push({ t0: t, t1: t + dur, y: () => y }); t += dur; };
  const move = (dur, from, to) => {
    segs.push({ t0: t, t1: t + dur, y: u => from + (to - from) * springEase(u) });
    t += dur;
  };
  const tapAt = TAP ? WAIT : 0;
  hold(TAP ? WAIT + SETTLE : WAIT, 0);
  for (const stopY of plan.stops) {
    move(TRAVEL, curY, stopY);
    curY = stopY;
    hold(DWELL, curY);
  }
  hold(ENDHOLD, curY);
  const DURATION = t;
  const TOTAL = Math.round(DURATION * FPS);
  console.log(`Длительность: ${DURATION.toFixed(1)}с, кадров: ${TOTAL}`);

  // покадровый рендер на виртуальном времени
  const framesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrollcast-'));
  // явный override: без него Page.captureScreenshot отдаёт кадр в CSS-пикселях
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH, height: HEIGHT, deviceScaleFactor: SCALE, mobile: true,
  });
  await cdp.send('Emulation.setVirtualTimePolicy', { policy: 'pause' });
  const advance = () => new Promise(res => {
    cdp.once('Emulation.virtualTimeBudgetExpired', res);
    cdp.send('Emulation.setVirtualTimePolicy', {
      policy: 'pauseIfNetworkFetchesPending', budget: 1000 / FPS,
    });
  });

  let tapped = false;
  const started = Date.now();
  for (let f = 0; f < TOTAL; f++) {
    const tf = f / FPS;
    if (TAP && !tapped && tf >= tapAt) {
      await page.evaluate(s => { const el = document.querySelector(s); if (el) el.click(); }, TAP);
      tapped = true;
    }
    const seg = segs.find(s => tf >= s.t0 && tf < s.t1) || segs[segs.length - 1];
    const y = seg.y((tf - seg.t0) / Math.max(seg.t1 - seg.t0, 1e-6));
    await page.evaluate(v => window.scrollTo(0, v), Math.round(y));
    await advance();
    const shot = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 92 });
    fs.writeFileSync(path.join(framesDir, `f${String(f).padStart(5, '0')}.jpg`),
                     Buffer.from(shot.data, 'base64'));
    if (f % 150 === 0) {
      const spd = ((f + 1) / ((Date.now() - started) / 1000)).toFixed(1);
      console.log(`  кадр ${f}/${TOTAL} (${spd} к/с)`);
    }
  }
  await browser.close();

  // сборка mp4
  console.log('Кодирую', OUT);
  const args = ['-hide_banner', '-loglevel', 'warning', '-y',
    '-framerate', String(FPS), '-i', path.join(framesDir, 'f%05d.jpg')];
  if (MUSIC) {
    args.push('-ss', String(MSTART), '-i', MUSIC);
    const delayMs = Math.round(tapAt * 1000);
    const fadeOutStart = Math.max(0, DURATION - FADEOUT).toFixed(2);
    args.push('-filter_complex',
      `[1:a]afade=t=in:st=0:d=${FADEIN},adelay=${delayMs}|${delayMs},` +
      `afade=t=out:st=${fadeOutStart}:d=${FADEOUT}[a]`,
      '-map', '0:v', '-map', '[a]', '-c:a', 'aac', '-b:a', '160k');
  }
  args.push('-c:v', 'libx264', '-preset', 'slow', '-crf', '19',
    '-pix_fmt', 'yuv420p', '-t', DURATION.toFixed(2),
    '-movflags', '+faststart', OUT);
  const res = spawnSync(FFMPEG, args, { stdio: 'inherit' });
  if (!flag('keep-frames')) fs.rmSync(framesDir, { recursive: true, force: true });
  if (res.status !== 0) { console.error('ffmpeg завершился с ошибкой'); process.exit(1); }
  console.log('Готово:', OUT);
})().catch(e => { console.error(e); process.exit(1); });
