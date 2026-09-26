const $ = id => document.getElementById(id);
let last = null;

const setStatus = (t, cls) => { const e = $('status'); e.textContent = t; e.className = cls || ''; };

// 进度回传（注入代码在隔离世界，可直接调 chrome API）
chrome.runtime.onMessage.addListener(m => {
  if (m && m.t === 'prog') setStatus('抓取中… ' + m.done + '/' + m.total + ' ' + (m.label || ''));
});

/* =========================================================
   注入页面上下文执行 —— 必须完全自包含，不可引用外部变量
   ========================================================= */
async function scrapeInPage(opts) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const clean = s => (s == null ? '' : String(s))
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const send = p => { try { chrome.runtime.sendMessage(Object.assign({ t: 'prog' }, p)); } catch (e) {} };

  // 富文本 -> 纯文本：保留换行、图片变链接；空位（文本框）用下划线标出
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
      const name = alt ? alt : (src.split('/').pop() || '图');
      let abs = src;
      try { abs = new URL(src, location.href).href; } catch (e) {}
      im.replaceWith(c.ownerDocument.createTextNode('\n![图片: ' + name + '](' + abs + ')\n'));
    });
    c.querySelectorAll('p,div,li,tr,h1,h2,h3,h4,h5,h6,pre,ol,ul,blockquote,section').forEach(e =>
      e.appendChild(c.ownerDocument.createTextNode('\n')));
    return clean(c.textContent);
  }

  // 代码模板：#cgsoucecode 里每个 <code> 是一行
  function readCode(node) {
    if (!node) return '';
    const lines = [...node.querySelectorAll('code')].map(c =>
      (c.textContent || '').replace(/\u00a0/g, ' ').replace(/[ \t]+$/gm, ''));
    if (lines.length) return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    const c = node.cloneNode(true);
    c.querySelectorAll('br').forEach(b => b.replaceWith('\n'));
    c.querySelectorAll('div,p,pre,li').forEach(e => e.appendChild(c.ownerDocument.createTextNode('\n')));
    return clean(c.textContent);
  }

  const cur = new URL(location.href);
  const ORIGIN = cur.origin;
  const assignID = cur.searchParams.get('assignID') || '';
  if (!assignID) return { error: 'URL 缺少 assignID 参数（请先在平台上打开某次作业）', items: [] };

  let courseID = cur.searchParams.get('courseID') || '';
  const ID_KEYS = ['proNum', 'proID', 'problemID', 'pid'];

  const timeout = () => (typeof AbortSignal !== 'undefined' && AbortSignal.timeout)
    ? AbortSignal.timeout(15000) : undefined;

  async function getDocFromURL(href) {
    const r = await fetch(href, { credentials: 'include', signal: timeout() });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return new DOMParser().parseFromString(await r.text(), 'text/html');
  }

  // JSP 文件名 → 题型名
  const TYPE_NAMES = {
    briefAnswerList: '简答题',
    shortAnswerList: '简答题',
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
    imgUploadListD1: '图片上传题'
  };
  const typeName = jsp => TYPE_NAMES[jsp] || jsp || '未分类';

  // ---- 标题 ----
  function pickTitle(d) {
    let title = '';
    for (const sel of ['h4.problemTitle', '#cgcode_description-content h4', '#cgcode_app h4',
      'ol.breadcrumb .breadcrumb-item.active']) {
      const e = d.querySelector(sel);
      if (e) { const t = clean(e.textContent); if (t) { title = t; break; } }
    }
    if (!title) {
      const pc = d.querySelector('.cgProblemContentClass');
      if (pc && pc.previousElementSibling) title = clean(pc.previousElementSibling.textContent);
    }
    return title.replace(/^\s*\d+\s*[.、:：)）]\s*/, '').trim();
  }

  // ---- 题干 ----
  const STEMS = [
    { k: 'problem', sel: '.cgProblemContentClass' },
    { k: 'text', sel: '[id^="tts"]' },
    { k: 'code', sel: '#cgcode_description-content' }
  ];
  const STEM_ORDER = {
    auto: ['problem', 'text', 'code'],
    code: ['code', 'problem', 'text'],
    text: ['text', 'problem', 'code']
  };
  function pickStem(d) {
    const order = STEM_ORDER[opts && opts.mode] || STEM_ORDER.auto;
    for (const k of order) {
      const s = STEMS.find(x => x.k === k);
      let best = '';
      d.querySelectorAll(s.sel).forEach(el => {
        const t = readText(el);
        if (t.length > best.length) best = t;
      });
      if (best) return { text: best, via: k };
    }
    // 完形填空等题型：题干（含空位）在 #cgcontainerID 的 answerForm 里
    const f = d.querySelector('#cgcontainerID form[id^="answerForm"]') || d.querySelector('#cgcontainerID form');
    if (f) return { text: readText(f), via: 'form' };
    return { text: '', via: 'unknown' };
  }

  // ---- 选项 / 已填答案 ----
  function pickAnswer(d) {
    const labelOf = r =>
      (r.id && d.querySelector('label[for="' + r.id + '"]')) ||
      (r.closest && r.closest('.form-check') ? r.closest('.form-check').querySelector('.form-check-label') : null) ||
      (r.closest && r.closest('label')) || r.parentElement;
    const mk = r => {
      const lab = labelOf(r);
      let t = clean(lab ? lab.textContent : '');
      if (t && !new RegExp('^' + String(r.value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*[.、:：)）]').test(t))
        t = r.value + '. ' + t;
      return t || String(r.value);
    };
    const radios = [...d.querySelectorAll('input[type=radio][name^="answer"]')];
    const cbs = [...d.querySelectorAll('input[type=checkbox][name^="answer"]')];
    if (radios.length) {
      const ck = radios.find(r => r.checked || r.defaultChecked);
      return { options: radios.map(mk), saved: ck ? String(ck.value) : '', qtype: '单选' };
    }
    if (cbs.length) {
      const saved = cbs.filter(r => r.checked || r.defaultChecked).map(r => String(r.value));
      return { options: cbs.map(mk), saved: saved.join(','), qtype: '多选' };
    }
    const blanks = [...d.querySelectorAll(
      'input[name^="answerInput"],textarea[name^="answerInput"],input[id^="answerInput"],textarea[id^="answerInput"],' +
      'input[name^="answer"][type=text]')]
      .filter(i => i.id !== 'tinyContent')
      .map(i => String(i.value || '').trim()).filter(v => v !== '');
    const rich = d.querySelector('#tinyContent');
    const richV = rich ? clean(rich.value || '') : '';
    const saved = blanks.length ? blanks.join(' / ') : richV;
    return { options: [], saved, qtype: blanks.length ? '填空' : (richV ? '简答' : '') };
  }

  // 结构判断这一页到底有没有题（严格：排除只有空壳 cgcontainerID 的页面）
  function hasQuestion(d) {
    return !!d.querySelector(
      '.cgProblemContentClass,[id^="tts"],#cgcode_description-content,#cgsoucecode,' +
      '#cgcontainerID form[id^="answerForm"],' +
      'input[name^="answerInput"],textarea[name^="answerInput"]'
    );
  }

  function firstLineTitle(stem) {
    const l = (stem || '').split('\n').map(x => x.trim()).find(Boolean) || '';
    return l.replace(/^\s*\d+\s*[.、:：)）]\s*/, '').slice(0, 40);
  }

  function buildItem(seq, title, type, d) {
    const st = pickStem(d);
    const an = pickAnswer(d);
    let stem = st.text, options = an.options;

    // 有些选择题（optionList）选项直接写在题干里（A. xxx / B. xxx），从文本里拆出来
    if (!options.length && stem) {
      const lines = stem.split('\n');
      const re = /^\s*([A-H])\s*[.、:：)）]\s*(\S.*)$/;
      const first = lines.findIndex(l => /^\s*A\s*[.、:：)）]/.test(l));
      if (first > -1) {
        const parsed = lines.slice(first)
          .map(l => { const m = l.match(re); return m ? m[1] + '. ' + m[2].trim() : ''; })
          .filter(Boolean);
        if (parsed.length >= 2) { options = parsed; stem = lines.slice(0, first).join('\n').trim(); }
      }
    }

    const codeEl = d.querySelector('#cgsoucecode');
    const code = codeEl ? readCode(codeEl) : '';
    const isProg = /编程|程序/.test(type || '');
    const item = {
      n: seq,
      title: title || firstLineTitle(stem) || ('第' + seq + '题'),
      type,
      text: stem,
      code,
      options,
      saved: an.saved,
      qtype: isProg ? '编程' : an.qtype,
      via: st.via
    };
    if (!stem) {
      item.error = '题干为空';
      const box = d.getElementById('cgcontainerID') || d.body;
      item.debug = box ? box.innerHTML.slice(0, 900) : '';
    }
    return item;
  }

  // ---- 从某个文档里收集本次作业的全部题目链接（按 题型#题号 去重）----
  function collectLinks(d) {
    const out = [], seen = new Set();
    d.querySelectorAll('a[href]').forEach(a => {
      let u; try { u = new URL(a.getAttribute('href'), location.href); } catch (e) { return; }
      if (u.searchParams.get('assignID') !== assignID) return;   // 排掉左侧往期作业
      const num = ID_KEYS.map(k => u.searchParams.get(k)).find(v => v != null);
      if (num == null) return;
      const jsp = (u.pathname.match(/\/([^\/]+)\.jsp$/) || [])[1] || '';
      if (!/list/i.test(jsp)) return;   // 只要题目列表页，排除 judgeDetailsRedirect / selfAnswer 等
      const key = jsp + '#' + num;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ href: u.href, title: (a.textContent || '').trim(), jsp, num: +num, type: typeName(jsp) });
    });
    return out;
  }

  // ---- 抓取：3 路并发 ----
  async function run(list, fetchDoc) {
    const buf = new Array(list.length);
    const queue = list.map((l, i) => ({ l, i }));
    let done = 0;
    await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
      while (queue.length) {
        const { l, i } = queue.shift();
        try {
          buf[i] = buildItem(i + 1, l.title, l.type, await fetchDoc(l));
        } catch (e) {
          buf[i] = { n: i + 1, title: l.title, type: l.type, text: '', code: '', options: [], saved: '', qtype: '未知', error: String(e.message || e) };
        }
        send({ done: ++done, total: list.length, label: (l.title || '').slice(0, 20) });
        await sleep(120);
      }
    }));
    return buf;
  }

  // ---- 兜底：索引页没有链接（作业已截止/被隐藏）时，逐题型页直接探测 ----
  const QUIZ_JSPS = ['briefAnswerList', 'programList', 'programFillGapList', 'optionList', 'clozeList',
    'singleOptionList', 'multiOptionList', 'multipleOptionList', 'judgeList', 'blankSpaceList',
    'programSQLList', 'programJavaList', 'programCList', 'programCppList', 'programPythonList'];
  async function discoverByProbe() {
    const out = [], seen = new Set();
    let budget = 120;                 // 总探测次数上限，兜底用，别把时间耗光
    for (const jsp of QUIZ_JSPS) {
      for (let n = 1; n <= 40 && budget > 0; n++) {
        budget--;
        const u = ORIGIN + '/assignment/' + jsp + '.jsp?proNum=' + n + '&assignID=' + assignID;
        let d;
        try { d = await getDocFromURL(u); } catch (e) { break; }
        if (!hasQuestion(d)) break;
        const key = jsp + '#' + n;
        if (seen.has(key)) break;
        seen.add(key);
        out.push({ href: u, title: pickTitle(d), jsp, num: n, type: typeName(jsp) });
        send({ done: out.length, total: '…', label: typeName(jsp) + ' 第' + n + '题' });
      }
      if (budget <= 0) break;
    }
    return out;
  }

  // ---- 主流程 ----
  let links = [];
  let probed = false;

  // 1) 优先请求索引页，这样哪怕当前停在某个题型页也能拿全整份作业
  try {
    const idx = await getDocFromURL(ORIGIN + '/assignment/index.jsp?assignID=' + assignID);
    const l = collectLinks(idx);
    if (l.length) {
      links = l;
      if (!courseID) {
        const m = (idx.documentElement.innerHTML || '').match(/courseID=(\d+)/);
        if (m) courseID = m[1];
      }
    }
  } catch (e) { /* 索引页拿不到就走下面 */ }

  // 2) 索引页没链接：退回当前页面已渲染的链接
  if (!links.length) links = collectLinks(document);

  // 3) 都没有：逐题型页直连探测（已截止作业往往只能到这里）
  if (!links.length) { probed = true; links = await discoverByProbe(); }

  let items = [];
  if (links.length) items = await run(links, l => getDocFromURL(l.href));

  // 按题型内重新编号
  const perType = {};
  items.forEach(it => {
    const t = it.type || '未分类';
    perType[t] = (perType[t] || 0) + 1;
    it.n = perType[t];
  });

  return {
    type: '通用',
    assignID,
    courseID,
    total: items.length,
    probed,
    items,
    url: location.href
  };
}

/* ===================== popup 交互 ===================== */

$('scan').addEventListener('click', async () => {
  if ($('scan').disabled) return;              // 运行锁，防止连点叠加
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return setStatus('找不到当前标签页', 'warn');

  $('scan').disabled = true;
  $('scan').textContent = '抓取中…';
  setStatus('抓取中…');

  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: scrapeInPage,
      args: [{ mode: $('mode').value }]
    });
    const data = res && res[0] && res[0].result;
    if (!data || data.error) {
      last = null;
      $('out').value = '';
      return setStatus((data && data.error) || '注入失败：页面无返回', 'warn');
    }

    last = data;
    $('out').value = cgToMarkdown(data);
    const bad = data.items.filter(i => i.error).length;
    if (!data.total) {
      setStatus(data.probed
        ? '没抓到题目：平台对已截止的作业会在服务端清空题目（手动打开也是空的）。请在作业还开放时用 node scrape.mjs --all 提前归档'
        : '没抓到题目：页面里没有题目链接', 'warn');
    } else {
      setStatus(bad ? ('完成 ' + data.total + ' 题（' + bad + ' 题异常）') : ('完成 ' + data.total + ' 题'),
                bad ? 'warn' : 'ok');
    }
  } catch (e) {
    last = null;
    setStatus('出错：' + e.message, 'warn');
  } finally {
    $('scan').disabled = false;
    $('scan').textContent = '抓取题目';
  }
});

$('copy').addEventListener('click', async () => {
  const t = $('out').value;
  if (!t) return;
  try {
    await navigator.clipboard.writeText(t);
    setStatus('已复制', 'ok');
  } catch {
    $('out').select();
    document.execCommand('copy');
    setStatus('已复制', 'ok');
  }
});

function download(name, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$('md').addEventListener('click', () => {
  if (!last) return setStatus('先抓取', 'warn');
  download('题目_' + (last.assignID || 'x') + '.md', cgToMarkdown(last), 'text/markdown;charset=utf-8');
});

$('csv').addEventListener('click', () => {
  if (!last) return setStatus('先抓取', 'warn');
  download('题目_' + (last.assignID || 'x') + '.csv', cgToCsv(last), 'text/csv;charset=utf-8');
});
