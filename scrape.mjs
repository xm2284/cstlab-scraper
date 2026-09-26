// 用真浏览器抓题目（复用登录态），支持索引页抓整份作业
// 用法: node scrape.mjs 8690 [8691 ...]
import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';

const CDP      = process.env.CDP || 'http://127.0.0.1:9222';
const HEADLESS = process.env.HEADLESS !== '0';   // 默认无头
const EDGE     = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const CHROME   = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROFILE  = path.resolve('./.browser-profile');
const COOKIE_FILE = path.resolve('./cookies.json');
const CONFIG_FILE = path.resolve('./config.json');

const ARGV = process.argv.slice(2);

// ---- 平台地址（希冀平台在各个学校域名不同，这里不写死）----
// 优先级：--origin= 参数 > ORIGIN 环境变量 > config.json > 从已保存的 Cookie 域名推断
function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}
function originFromCookie() {
  const arr = readJSON(COOKIE_FILE);
  const d = Array.isArray(arr) && arr[0] && arr[0].domain;
  return d ? 'https://' + String(d).replace(/^\./, '') : '';
}
const ORIGIN = String(
  (ARGV.map(a => a.match(/^--origin=(.+)$/)).find(Boolean) || [])[1] ||
  process.env.ORIGIN ||
  (readJSON(CONFIG_FILE) || {}).origin ||
  originFromCookie() ||
  ''
).replace(/\/+$/, '');

if (!ORIGIN) {
  console.error('未配置希冀平台地址（各学校域名不同），任选一种方式设置：\n');
  console.error('  1) 写进 config.json（推荐，只需一次）：');
  console.error('       echo \'{"origin":"https://你学校的希冀平台域名"}\' > config.json');
  console.error('  2) 临时环境变量：');
  console.error('       ORIGIN=https://你学校的希冀平台域名 node scrape.mjs 8717');
  console.error('  3) 单次运行参数：');
  console.error('       node scrape.mjs --origin=https://你学校的希冀平台域名 8717\n');
  process.exit(1);
}

let ASSIGNS = ARGV
  .map(a => { const m = String(a).match(/assignID=(\d+)/); return m ? m[1] : a; })
  .filter(a => /^\d+$/.test(a));
if (!ASSIGNS.length) ASSIGNS.push(process.env.ASSIGN || '8690');

const TYPE_NAMES = {
  briefAnswerList: '简答题',
  programList: '编程题',
  programList_ce: '编程题',
  programFillGapList: '程序片段编程题',
  optionList: '选择题',
  clozeList: '完形填空',
  singleOptionList: '单选题',
  multiOptionList: '多选题',
  multipleOptionList: '多选题',
  judgeList: '判断题',
  blankSpaceList: '填空题',
  fillBlankList: '填空题',
  programSQLList: 'SQL编程题',
  programSQLList_ce: 'SQL编程题',
  programJavaList: 'Java编程题',
  programCList: 'C编程题',
  programCppList: 'C++编程题',
  programPythonList: 'Python编程题',
  imgUploadList: '图片上传题',
  imgUploadListD1: '图片上传题',
  shortAnswerList: '简答题'
};
const typeName = jsp => TYPE_NAMES[jsp] || jsp || '未分类';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ============ 页面内执行（真浏览器：innerText/iframe/img 都正常）============
function frameExtract() {
  const NBSP = / /g;
  const clean = s => (s == null ? '' : String(s))
    .replace(NBSP, ' ').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();

  // 富文本 -> 纯文本（保留换行，img 变成可点链接）
  function readText(node) {
    if (!node) return '';
    const c = node.cloneNode(true);
    // 题干里不该出现的控件/脚本，先剔掉（提交按钮、保存提示等）
    c.querySelectorAll('script,style,button,.btn,.cgsavetip,select,textarea').forEach(e => e.remove());
    // 文本输入框是"空位"，用下划线标出来；其余控件（隐藏域/单选/复选）直接删
    c.querySelectorAll('input').forEach(e => {
      const t = (e.getAttribute('type') || 'text').toLowerCase();
      if (t === 'text' || t === 'search') e.replaceWith(c.ownerDocument.createTextNode('______'));
      else e.remove();
    });
    c.querySelectorAll('br').forEach(b => b.replaceWith('\n'));
    c.querySelectorAll('img').forEach(im => {
      const alt = (im.getAttribute('alt') || '').trim();
      const src = im.getAttribute('src') || im.src || '';
      const t = alt ? alt : (src.split('/').pop() || '图');
      let abs = src;
      try { abs = new URL(src, location.href).href; } catch (e) {}
      c.ownerDocument; im.replaceWith(c.ownerDocument.createTextNode('\n![图片: ' + t + '](' + abs + ')\n'));
    });
    c.querySelectorAll('p,div,li,tr,h1,h2,h3,h4,h5,h6,pre,ol,ul,blockquote,section').forEach(e => {
      e.appendChild(c.ownerDocument.createTextNode('\n'));
    });
    return clean(c.textContent);
  }

  // 代码模板：#cgsoucecode 里每个 <code> 是一行，行间夹着填空 textarea
  function readCode(node) {
    if (!node) return '';
    const lines = [...node.querySelectorAll('code')].map(c =>
      (c.textContent || '').replace(/ /g, ' ').replace(/[ \t]+$/gm, ''));
    if (lines.length) return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    const c = node.cloneNode(true);
    c.querySelectorAll('br').forEach(b => b.replaceWith('\n'));
    c.querySelectorAll('div,p,pre,li').forEach(e => e.appendChild(c.ownerDocument.createTextNode('\n')));
    return clean(c.textContent);
  }

  // ---- 标题 ----
  let title = '';
  for (const sel of ['h4.problemTitle', '#cgcode_description-content h4', '#cgcode_app h4',
    'ol.breadcrumb .breadcrumb-item.active']) {
    const e = document.querySelector(sel);
    if (e) { const t = clean(e.innerText || e.textContent); if (t) { title = t; break; } }
  }
  if (!title) {
    const pc = document.querySelector('.cgProblemContentClass');
    if (pc && pc.previousElementSibling)
      title = clean(pc.previousElementSibling.innerText || pc.previousElementSibling.textContent);
  }
  title = title.replace(/^\s*\d+\s*[.、:：)）]\s*/, '').trim();

  // ---- 题干 ----
  let stem = '';
  const stemEl = document.querySelector('.cgProblemContentClass')
              || document.querySelector('[id^="tts"]');
  if (stemEl) {
    stem = readText(stemEl);
  } else {
    const box = document.querySelector('#cgcode_description-content');
    if (box) {
      const c = box.cloneNode(true);
      c.querySelectorAll('h4').forEach(h => h.remove());
      stem = clean(c.textContent);
    } else {
      // 完形填空等题型：题干（代码+空位）在 #cgcontainerID 里的 answerForm 里
      const f = document.querySelector('#cgcontainerID form[id^="answerForm"]')
             || document.querySelector('#cgcontainerID form');
      if (f) stem = readText(f);
    }
  }

  // ---- 代码模板 ----
  let code = '';
  const codeEl = document.querySelector('#cgsoucecode');
  if (codeEl) code = readCode(codeEl);
  // ---- 选项（单选/多选/判断）----
  const labelOf = r =>
    (r.id && document.querySelector('label[for="' + r.id + '"]')) ||
    (r.closest && r.closest('.form-check') ? r.closest('.form-check').querySelector('.form-check-label') : null) ||
    r.closest && r.closest('label') ||
    r.parentElement;
  let options = [], saved = '';
  const radios = [...document.querySelectorAll('input[type=radio][name^="answer"]')];
  const cbs    = [...document.querySelectorAll('input[type=checkbox][name^="answer"]')];
  const mk = r => {
    const lab = labelOf(r);
    let t = clean(lab ? (lab.innerText || lab.textContent) : '');
    if (t && !new RegExp('^' + String(r.value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*[.、:：)）]').test(t))
      t = r.value + '. ' + t;
    return t || String(r.value);
  };
  if (radios.length) {
    options = radios.map(mk);
    const ck = radios.find(r => r.checked);
    saved = ck ? String(ck.value) : '';
  } else if (cbs.length) {
    options = cbs.map(mk);
    saved = cbs.filter(r => r.checked).map(r => String(r.value)).join(',');
  }
  // 有些选择题（optionList）选项直接写在题干里（A. xxx / B. xxx），从文本里拆出来
  if (!options.length && stem) {
    const lines = stem.split('\n');
    const re = /^\s*([A-H])\s*[.、:：)）]\s*(\S.*)$/;
    const first = lines.findIndex(l => /^\s*A\s*[.、:：)）]/.test(l));
    if (first > -1) {
      const parsed = lines.slice(first).map(l => { const m = l.match(re); return m ? m[1] + '. ' + m[2].trim() : ''; })
        .filter(Boolean);
      if (parsed.length >= 2) { options = parsed; stem = lines.slice(0, first).join('\n').trim(); }
    }
  }

  // ---- 已填答案（填空 / 简答 / 富文本）----
  const blanks = [...document.querySelectorAll(
    'textarea[name^="answerInput"],input[name^="answerInput"],textarea[id^="answerInput"],input[id^="answerInput"]')]
    .filter(i => i.id !== 'tinyContent')
    .map(i => String(i.value || '').trim()).filter(v => v !== '');
  const richEl = document.querySelector('textarea#tinyContent')
              || document.querySelector('#cgcode_description-content textarea');
  const rich = richEl ? clean(richEl.value || '') : '';
  const plain = [...document.querySelectorAll('input[name^="answer"][type=text],input[id^="answer"][type=text]')]
    .map(i => String(i.value || '').trim()).filter(v => v !== '');

  const hasQuestion = !!document.querySelector(
    '.cgProblemContentClass,[id^="tts"],#cgcode_description-content,#cgcontainerID,#cgsoucecode,' +
    'input[name^="answer"],textarea[name^="answer"],textarea#tinyContent,' +
    'input[id^="answerInput"],textarea[id^="answerInput"],textarea[name^="answerInput"]');

  return { title, stem, code, options, saved, blanks, rich, plain, hasQuestion, url: location.href };
}

// ============ 浏览器 ============
// 默认无头：后台静默跑，不弹窗口。
// HEADLESS=0 时才可见（首次登录用），并且优先连已开着的调试实例。
async function getBrowser(forceHeadful = false) {
  const wantHeadless = !forceHeadful && HEADLESS;
  if (!wantHeadless) {
    try {
      const b = await puppeteer.connect({ browserURL: CDP, defaultViewport: null });
      console.log('[browser] 已连接调试实例，复用登录态');
      return { browser: b, own: false };
    } catch { /* 继续自己启动 */ }
  }
  const exe = fs.existsSync(EDGE) ? EDGE : CHROME;
  console.log('[browser] 启动 ' + (wantHeadless ? '无头' : '有头') + ' 实例 (profile=' + PROFILE + ')');
  const b = await puppeteer.launch({
    executablePath: exe,
    headless: wantHeadless ? 'new' : false,
    userDataDir: PROFILE,
    defaultViewport: null,
    args: ['--no-first-run', '--no-default-browser-check', '--disable-blink-features=AutomationControlled']
  });
  return { browser: b, own: true };
}

async function goto(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForNetworkIdle({ idleTime: 700, timeout: 12000 }).catch(() => {});
  await sleep(200);
}

// 遍历所有 frame，按"信息量最大"合并
async function extractPage(page) {
  const hits = [];
  for (const f of page.frames()) {
    if (f.url() === 'about:blank') continue;
    try {
      const r = await f.evaluate(frameExtract);
      if (r && r.hasQuestion) hits.push(r);
    } catch (e) { /* 跨域 frame */ }
  }
  if (!hits.length) return { stem: '', code: '', options: [], saved: '', blanks: [], rich: '', plain: [], title: '' };
  const pick = (key) => {
    const v = hits.map(h => h[key]).find(x => x && String(x).trim());
    return v || '';
  };
  const opts = hits.find(h => h.options.length);
  const ans  = hits.find(h => h.saved) || hits.find(h => h.blanks.length) || hits.find(h => h.rich) || hits.find(h => h.plain.length);
  return {
    title: pick('title'),
    stem: hits.map(h => h.stem).sort((a, b) => b.length - a.length)[0] || '',
    code: pick('code'),
    options: opts ? opts.options : [],
    saved:  ans ? ans.saved  : '',
    blanks: ans ? ans.blanks : [],
    rich:   ans ? ans.rich   : '',
    plain:  ans ? ans.plain  : []
  };
}

// ============ 登录态持久化 ============
// JSESSIONID 是会话 Cookie，浏览器一关就没了。所以登录一次后把 Cookie 落盘，
// 之后每次无头启动再灌回去，就不用反复登录。

async function loadCookies(page) {
  if (!fs.existsSync(COOKIE_FILE)) return false;
  try {
    const arr = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8'));
    if (Array.isArray(arr) && arr.length) {
      await page.setCookie(...arr);
      return true;
    }
  } catch (e) { /* 坏文件就当没有 */ }
  return false;
}
async function saveCookies(page) {
  try {
    const arr = await page.cookies();
    if (arr.length) fs.writeFileSync(COOKIE_FILE, JSON.stringify(arr, null, 1), 'utf8');
    // 顺手记下平台地址，下次不用再配
    const cfg = readJSON(CONFIG_FILE) || {};
    if (cfg.origin !== ORIGIN) fs.writeFileSync(CONFIG_FILE, JSON.stringify({ ...cfg, origin: ORIGIN }, null, 2), 'utf8');
  } catch (e) { /* 忽略 */ }
}

const isLoggedIn = page => page.evaluate(() =>
  document.body.innerText.includes('退出登录') ||
  document.querySelectorAll('a[href*="assignID="]').length > 0);

// ---- 登录模式：唯一需要开窗口的地方 ----
// 注意：不能拿用户正在登录的那个标签页去轮询，否则会打断 SSO 跳转。
// 所以另开一个标签页访问 main.jsp 来判断登录状态。
async function login() {
  const { browser } = await getBrowser(true);   // 登录必须可见
  const page = await browser.newPage();
  await goto(page, ORIGIN + '/');

  const probe = async () => {
    const t = await browser.newPage();
    try {
      await goto(t, ORIGIN + '/main.jsp');
      return await t.evaluate(() =>
        document.body.innerText.includes('退出登录') ||
        document.body.innerText.includes('切换课程') ||
        document.querySelectorAll('a[href*="assignID="]').length > 0);
    } catch { return false; } finally { await t.close().catch(() => {}); }
  };

  if (await probe()) {
    console.log('已经登录过了。');
  } else {
    console.log('请在弹出的窗口里点「统一认证」完成登录（最多等 5 分钟）…');
    let ok = false;
    for (let i = 0; i < 100; i++) {
      await sleep(3000);
      if (await probe()) { ok = true; console.log('检测到登录成功'); break; }
      if (i % 5 === 4) console.log('  …等待登录中 (' + ((i + 1) * 3) + 's)');
    }
    if (!ok) { await browser.close().catch(() => {}); throw new Error('登录超时'); }
  }
  // 重新站到本平台页面，保证 cookies() 抓的是本站的 session
  await goto(page, ORIGIN + '/main.jsp').catch(() => {});
  await saveCookies(page);
  await page.close().catch(() => {});
  await browser.close().catch(() => {});
  console.log('登录态已保存到 ' + path.basename(COOKIE_FILE) + '，以后无头直接跑就行。');
}

// ============ 主流程 ============
if (process.argv.includes('--login')) {
  await login();
  process.exit(0);
}

const courseArgIdx = process.argv.indexOf('--course');
let FORCE_COURSE = courseArgIdx > -1 ? process.argv[courseArgIdx + 1] : null;
const PROBE_ONLY = process.env.PROBE_ONLY === '1';   // 跳过索引页，强制走直连探测
const ALL_MODE = process.argv.includes('--all') || process.env.ALL === '1';   // 批量导出所有课程的作业
const OUT_ROOT = process.env.OUT_ROOT || '题库';
const sanitize = s => String(s || '').replace(/[\\/:*?"<>|]/g, '_').trim();

const { browser, own } = await getBrowser();

// 这个平台要求先在会话里"选课"，否则作业页会跳到 courselist.jsp?courseID=0。
// 登录校验和取课程列表都用 main.jsp。
async function ensureLogin(page) {
  await loadCookies(page);
  await goto(page, ORIGIN + '/main.jsp');
  const ok = await page.evaluate(() =>
    document.body.innerText.includes('切换课程') || document.body.innerText.includes('退出登录'));
  if (ok) return;
  if (HEADLESS) throw new Error('未登录或登录已过期。先跑一次：node scrape.mjs --login');
  console.log('[!] 需要登录，请在浏览器窗口里登录…');
  for (let i = 0; i < 150; i++) {
    await sleep(2000);
    await goto(page, ORIGIN + '/main.jsp').catch(() => {});
    if (await page.evaluate(() => document.body.innerText.includes('切换课程')).catch(() => false)) break;
  }
  await saveCookies(page);
}

// 取所有可选课程 [{id, name}]
// main.jsp 里的课程在 <span class="dropdown-item-course" value="174">Java及Web开发</span>
const listCourses = (page) => page.evaluate(() => {
  const map = new Map();
  document.querySelectorAll('.dropdown-item-course[value]').forEach(el => {
    const id = el.getAttribute('value');
    const name = (el.textContent || '').trim();
    if (id && name && !map.has(id)) map.set(id, name);
  });
  if (!map.size) {
    document.querySelectorAll('a[href*="courselist.jsp?courseID="]').forEach(a => {
      const m = a.getAttribute('href').match(/courseID=(\d+)/);
      if (m && !map.has(m[1])) map.set(m[1], (a.textContent || '').trim());
    });
  }
  return [...map.entries()].map(([id, name]) => ({ id, name }));
});

let currentCourse = null;
async function selectCourse(page, cid) {
  if (currentCourse === cid) return;
  await goto(page, ORIGIN + '/courselist.jsp?courseID=' + cid);
  currentCourse = cid;
}

const collectLinks = async (page, assignId) => page.evaluate((assign) => {
  const ID = ['proNum', 'proID', 'problemID', 'pid'];
  const out = [], seen = new Set();
  document.querySelectorAll('a[href]').forEach(a => {
    let u; try { u = new URL(a.getAttribute('href'), location.href); } catch (e) { return; }
    if (u.searchParams.get('assignID') !== assign) return;
    const num = ID.map(k => u.searchParams.get(k)).find(v => v != null);
    if (num == null) return;
    const jsp = (u.pathname.match(/\/([^\/]+)\.jsp$/) || [])[1] || '';
    if (!/list/i.test(jsp)) return;
    const key = jsp + '#' + num;
    if (seen.has(key)) return; seen.add(key);
    out.push({ href: u.href, title: (a.textContent || '').trim(), jsp, num: +num });
  });
  return out;
}, String(assignId));

// 兜底：索引页拿不到链接时（作业已截止/被隐藏），直接按「题型页 + proNum」探测。
// 实测题目页可以脱离索引页单独访问，所以仍可能抓到。
const QUIZ_JSPS = ['briefAnswerList', 'programList', 'programFillGapList', 'optionList', 'clozeList',
  'singleOptionList', 'multiOptionList', 'multipleOptionList', 'judgeList', 'blankSpaceList',
  'programSQLList', 'programJavaList', 'programCList', 'programCppList', 'programPythonList'];

const pageHasQuestion = (page) => page.evaluate(() =>
  !!document.querySelector('.cgProblemContentClass,[id^="tts"],#cgcode_description-content,' +
    '#cgsoucecode,#cgcontainerID form[id^="answerForm"]'));

async function discoverByProbe(page, assignId) {
  const out = [], seen = new Set();
  let budget = 600;                 // 总探测次数上限，兜底用，别把时间耗光
  for (const jsp of QUIZ_JSPS) {
    for (let n = 1; n <= 100 && budget > 0; n++) {
      budget--;
      const url = ORIGIN + '/assignment/' + jsp + '.jsp?proNum=' + n + '&assignID=' + assignId;
      try { await goto(page, url); } catch { break; }
      if (!(await pageHasQuestion(page).catch(() => false))) break;
      const finalUrl = page.url();
      const key = finalUrl.replace(/proNum=\d+/, 'proNum=#');
      if (seen.has(key)) continue;
      seen.add(key);
      const fjsp = (finalUrl.match(/\/([^\/]+)\.jsp/) || [])[1] || jsp;
      out.push({ href: finalUrl, title: '', jsp: fjsp, num: n });
    }
  }
  return out;
}

// ---- --all：枚举所有课程里的所有作业，批量导出（趁作业还开着先存下来）----
const assignCourse = new Map();   // assignId -> {id, name}
if (ALL_MODE) {
  const page = await browser.newPage();
  await ensureLogin(page);
  const courses = await listCourses(page);
  console.log('课程数: ' + courses.length);
  const ids = [];
  for (const c of courses) {
    await selectCourse(page, c.id);
    await goto(page, ORIGIN + '/assignment/index.jsp');
    const list = await page.evaluate((cid) => {
      const out = [], seen = new Set();
      document.querySelectorAll('a[href]').forEach(a => {
        const m = (a.getAttribute('href') || '').match(/index\.jsp\?courseID=(\d+)&assignID=(\d+)/);
        if (!m || m[1] !== cid) return;
        if (seen.has(m[2])) return; seen.add(m[2]);
        out.push(m[2]);
      });
      return out;
    }, c.id);
    console.log('[' + c.id + '] ' + (c.name || '') + ' 作业数 ' + list.length);
    list.forEach(id => { if (!assignCourse.has(id)) { assignCourse.set(id, c); ids.push(id); } });
  }
  await saveCookies(page);
  await page.close();
  ASSIGNS = ids;
  console.log('共 ' + ids.length + ' 份作业待处理\n');
}

const allOut = [];
for (const assignId of ASSIGNS) {
  const forced = assignCourse.get(assignId);
  if (forced) FORCE_COURSE = forced.id;
  console.log('\n===== 作业 ' + assignId + ' =====');
  const page = await browser.newPage();
  await ensureLogin(page);

  // 找作业属于哪门课：逐门选课，再看该作业有没有题目
  let courseOpts = FORCE_COURSE
    ? [{ id: FORCE_COURSE, name: (forced && forced.name) || '' }]
    : await listCourses(page);
  if (!courseOpts.length) { console.log('[!] 取不到课程列表'); await page.close(); continue; }
  console.log('可选课程: ' + courseOpts.map(c => c.id + '=' + c.name).join(', '));

  let links = [], hit = null;
  if (!PROBE_ONLY) {
    for (const c of courseOpts) {
      await selectCourse(page, c.id);
      await goto(page, ORIGIN + '/assignment/index.jsp?assignID=' + assignId);
      links = await collectLinks(page, assignId);
      if (links.length) { hit = c; break; }
    }
  }
  // 索引页没给链接（作业可能已截止/被隐藏）→ 逐课程直连题目页探测
  if (!links.length && !ALL_MODE) {
    console.log('[i] 索引页没给题目链接，改用直连题目页探测…');
    for (const c of courseOpts) {
      await selectCourse(page, c.id);
      links = await discoverByProbe(page, assignId);
      if (links.length) { hit = { id: c.id, name: c.name + '(直连)' }; break; }
    }
  }
  await saveCookies(page);          // 刷新会话，避免下次又要登录
  await page.close();
  if (!links.length) {
    console.log(ALL_MODE ? '[空] 无可抓题目（已截止/未发布/无题），跳过' : '[!] 索引页和直连都没找到这个作业的题目');
    continue;
  }
  console.log('课程 ' + (hit ? hit.id + ' ' + hit.name : '?') + '，发现 ' + links.length + ' 道题');

  // 批量模式：按课程分目录保存，已存在则跳过（可断点续跑）
  let outDir = '.';
  if (ALL_MODE) {
    const c = hit || { id: 'unknown', name: '' };
    outDir = path.join(OUT_ROOT, sanitize(c.id + '_' + String(c.name || '').replace(/\(直连\)$/, '')));
    fs.mkdirSync(outDir, { recursive: true });
    if (fs.existsSync(path.join(outDir, '题目_' + assignId + '.md'))) {
      console.log('  已存在，跳过');
      continue;
    }
  }

  const items = [];
  for (let i = 0; i < links.length; i++) {
    const l = links[i];
    const type = typeName(l.jsp);
    const p2 = await browser.newPage();
    let it;
    try {
      await goto(p2, l.href);
      const r = await extractPage(p2);
      it = {
        title: r.title || l.title || ('第' + l.num + '题'),
        type, num: l.num, stem: r.stem, code: r.code,
        options: r.options, saved: r.saved, blanks: r.blanks, rich: r.rich, plain: r.plain
      };
    } catch (e) {
      it = { title: l.title, type, num: l.num, stem: '', code: '', options: [], saved: '', blanks: [], rich: '', plain: [], error: String(e.message || e) };
    }
    await p2.close().catch(() => {});
    const ok = it.stem || it.code || it.options.length;
    items.push(it);
    console.log('  [' + (i + 1) + '/' + links.length + '] ' + (ok ? 'OK ' : '!! ') + type + ' - ' + it.title.slice(0, 26) +
      ' (题干' + it.stem.length + ' 代码' + it.code.length + ' 选项' + it.options.length + ')');
    await sleep(150);
  }

  const groups = new Map();
  items.forEach(it => { const t = it.type || '未分类'; if (!groups.has(t)) groups.set(t, []); groups.get(t).push(it); });
  [...groups.values()].forEach(l => l.forEach((it, i) => { it.n = i + 1; }));

  const head = ['# 题目导出', '', '- 作业 ID: ' + assignId,
    '- 课程: ' + (hit ? hit.id + ' ' + hit.name : '?'),
    '- 题目数: ' + items.length,
    '- 来源: 希冀平台（index.jsp?assignID=' + assignId + '）', ''].join('\n');
  const md = head + [...groups.entries()].map(([type, list]) =>
    '## ' + type + '\n\n' + list.map(it => {
      const b = ['### ' + it.n + '. ' + it.title, ''];
      b.push(it.stem || '_（题干抓取失败）_', '');
      if (it.options.length) { b.push('**选项**', ''); it.options.forEach(o => b.push('- ' + o)); b.push(''); }
      if (it.code) { b.push('**代码模板**', '', '```java', it.code, '```', ''); }
      const extra = [];
      if (it.saved) extra.push('已选: ' + it.saved);
      if (it.blanks.length) extra.push('填空: ' + it.blanks.join(' | '));
      if (it.plain.length) extra.push('输入: ' + it.plain.join(' | '));
      if (it.rich) extra.push('富文本答案:\n\n> ' + it.rich.replace(/\n/g, '\n> '));
      if (extra.length) { b.push('**已填答案**', ''); extra.forEach(x => b.push('- ' + x)); b.push(''); }
      if (it.error) { b.push('> 异常: ' + it.error, ''); }
      return b.join('\n');
    }).join('')
  ).join('\n---\n\n') + '\n';

  const esc = s => '"' + String(s == null ? '' : s).replace(/"/g, '""').replace(/\r?\n/g, '↵') + '"';
  let csv = '\ufeff' + [['题型', '题号', '标题', '题干', '选项', '代码模板', '已填答案', '异常']
    .map(esc).join(',')].concat(items.map(it => [it.type, it.n, it.title, it.stem,
      it.options.join(' | '), it.code, [it.saved, it.blanks.join('|'), it.plain.join('|'), it.rich].filter(Boolean).join(' / '), it.error || '']
      .map(esc).join(','))).join('\r\n');

  const mdF = path.join(outDir, '题目_' + assignId + '.md');
  const csvF = path.join(outDir, '题目_' + assignId + '.csv');

  // 图片下载到本地：题库自包含，离线也能看，也不用带学校域名
  let savedImg = 0;
  if (process.env.SAVE_IMAGES !== '0') {
    const urls = [...new Set([...md.matchAll(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g)].map(m => m[1]))];
    if (urls.length) {
      const imgDir = path.join(outDir, '图片');
      fs.mkdirSync(imgDir, { recursive: true });
      const ip = await browser.newPage();
      try {
        for (const u of urls) {
          try {
            const res = await ip.request.get(u);
            if (!res.ok()) continue;
            const buf = await res.buffer();
            if (!buf || buf.length < 64) continue;
            const ct = String(res.headers()['content-type'] || '').split(';')[0].toLowerCase();
            const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/bmp': '.bmp' }[ct] || '.png';
            const name = assignId + '_' + (++savedImg) + ext;
            fs.writeFileSync(path.join(imgDir, name), buf);
            const rel = '图片/' + name;
            md = md.split(u).join(rel);
            csv = csv.split(u).join(rel);
          } catch (e) { /* 拿不到就保留原链接 */ }
        }
      } finally { await ip.close().catch(() => {}); }
    }
  }

  fs.writeFileSync(mdF, md, 'utf8');
  fs.writeFileSync(csvF, csv, 'utf8');
  const bad = items.filter(it => !(it.stem || it.code || it.options.length));
  console.log('  -> ' + mdF + ' / ' + csvF +
    (savedImg ? '  📷 图片 ' + savedImg + ' 张已本地化' : '') +
    (bad.length ? '  ⚠ ' + bad.length + ' 题失败: ' + bad.map(x => x.title).join(',') : '  全部成功'));
  allOut.push({ assignId, items });
}

if (own) await browser.close().catch(() => {});
process.exit(0);
