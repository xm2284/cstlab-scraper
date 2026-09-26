// 仅供 popup 页面使用：把抓取结果格式化为 Markdown / CSV
// 抓取逻辑在 popup.js 的 scrapeInPage 里，通过 executeScript 注入

function groupByType(items) {
  const g = new Map();
  (items || []).forEach(it => {
    const t = it.type || '未分类';
    if (!g.has(t)) g.set(t, []);
    g.get(t).push(it);
  });
  return g;
}

// 结果 → Markdown
function cgToMarkdown(data) {
  if (!data || data.error) return '抓取失败\n' + ((data && data.error) || '未知错误');

  const head = [
    '题目导出',
    '---',
    '作业 ID: ' + data.assignID,
    '课程 ID: ' + (data.courseID || ''),
    '题目数: ' + data.total,
    '来源: ' + data.url,
    ''
  ].join('\n');

  const groups = groupByType(data.items);
  const body = [...groups.entries()].map(([type, list]) => {
    const sec = ['# ' + type, ''];
    list.forEach(it => {
      sec.push('## ' + it.n + '. ' + it.title + (it.qtype ? '（' + it.qtype + '）' : ''));
      sec.push('');
      sec.push(it.text || '_（题干抓取失败）_');
      sec.push('');
      if (it.code) {
        sec.push('**代码模板**');
        sec.push('');
        sec.push('```');
        sec.push(it.code);
        sec.push('```');
        sec.push('');
      }
      if (it.options && it.options.length) {
        sec.push('**选项**');
        it.options.forEach(o => sec.push('- ' + o));
        sec.push('');
      }
      if (it.saved) sec.push('> 已填答案: ' + it.saved, '');
      if (it.error) sec.push('> 异常: ' + it.error, '');
      sec.push('');
    });
    return sec.join('\n');
  }).join('\n---\n\n');

  return head + body;
}

// 结果 → CSV（带 BOM，Excel 打开中文不乱码）
function cgToCsv(data) {
  if (!data || data.error) return 'error\n' + ((data && data.error) || '');
  const esc = s => '"' + String(s == null ? '' : s).replace(/"/g, '""').replace(/\r?\n/g, ' ') + '"';
  const rows = [['题型', '题号', '小题型', '标题', '题干', '代码模板', '选项', '已填答案', '异常'].map(esc).join(',')];
  data.items.forEach(it => {
    rows.push([
      it.type || '', it.n, it.qtype || '', it.title, it.text, it.code || '',
      (it.options || []).join(' | '), it.saved || '', it.error || it.debug || ''
    ].map(esc).join(','));
  });
  return '\ufeff' + rows.join('\r\n');
}
