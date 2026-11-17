// content/rules.js —— 内置站点规则 + 用户规则合并 + URL 通配匹配
// 内置表 v2（协议 injectionRules 定稿 + v0.2 fullRestore 第 6 条）：
//   twitter/x.com —— 只译推文正文，排除用户名/时间（照官方 FAQ）
//   github.com    —— 排除代码行
//   news.ycombinator.com —— 只译标题/评论正文
//   codeforces.com —— 题面根 .ttypography；排除样例区 pre 与题目头部限制行
//                     （时限/内存/输入输出格式，公式保护另见 content/formula.js）
// 规则新字段 theme（v0.2）：非空字符串时按站点固定译文主题，
// 由 main.js collectOpts 读 resolve() 结果传入 opts.effectiveTheme（injector 消费）。
// 用户规则 settings.userRules：builtin → user 顺序生效；同名字段整体覆盖；
// additional* 追加；'selectors.add' / 'selectors.remove'（及 excludeSelectors 同名后缀）做增量合并。
(function () {
  'use strict';
  var TA = globalThis.TA;
  if (!TA || TA.__rulesLoaded) return;
  TA.__rulesLoaded = true;

  var BUILTIN_RULES = [
    {
      pattern: 'twitter.com',
      selectors: ['[data-testid="tweetText"]'],
      excludeSelectors: ['header', 'time', '[data-testid="User-Name"]']
    },
    {
      pattern: 'x.com',
      selectors: ['[data-testid="tweetText"]'],
      excludeSelectors: ['header', 'time', '[data-testid="User-Name"]']
    },
    {
      pattern: 'github.com',
      excludeSelectors: ['.js-file-line', '.blob-code']
    },
    {
      pattern: 'news.ycombinator.com',
      selectors: ['.titleline', '.commtext', '.toptext']
    },
    // v0.2：Codeforces 题面规则（与公式占位符保护联动，见 content/formula.js）：
    //   .ttypography 为题面提取根（页面自身 diff 亦用该类）；样例区 div.sample-test
    //   内的 pre 数据与题目头部四行限制信息（时限/内存/输入/输出）不翻译。
    //   theme: '' 表示不按站点固定主题（沿用用户设置）。
    {
      pattern: 'codeforces.com',
      selectors: ['.ttypography'],
      excludeSelectors: [
        'div.sample-test',
        '.header .time-limit', '.header .memory-limit',
        '.header .input-file', '.header .output-file'
      ],
      theme: ''
    }
  ];

  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // URL 模式匹配（协议 injectionRules 定稿）：
  //   纯域名（无 * 且无 ://）→ 只比 hostname（精确相等）；
  //   含 * → 通配符转正则：带 :// 或含 / 的模式匹配完整 href（另匹配 origin+pathname，
  //          容忍查询串差异）；纯域名形（如 *.example.com）只对 hostname 做通配
  //          （不命中根域名，协议注明需另写根域条目）；
  //   完整 URL（含 :// 且无 *）→ 全等比较（忽略 hash）。
  function matchPattern(pattern, url) {
    if (!pattern) return false;
    var p = String(pattern).trim();
    if (!p) return false;
    var u;
    try { u = new URL(url); } catch (e) { return false; }
    var hasStar = p.indexOf('*') !== -1;
    var isUrlLike = p.indexOf('://') !== -1 || p.indexOf('/') !== -1;
    if (!hasStar && !isUrlLike) {
      // 纯域名：只比 hostname
      return u.hostname.toLowerCase() === p.toLowerCase().replace(/^\./, '');
    }
    if (!hasStar) {
      // 完整 URL：全等（忽略 hash）
      return url === p || url.split('#')[0] === p;
    }
    var re;
    try {
      re = new RegExp('^' + p.split('*').map(escapeRegExp).join('.*') + '$', 'i');
    } catch (e) { return false; }
    if (isUrlLike) {
      return re.test(url) || re.test(u.origin + u.pathname);
    }
    // 纯域名通配（*.example.com 等）：只对 hostname
    return re.test(u.hostname.toLowerCase());
  }

  function mergeList(list, add) {
    if (!Array.isArray(add)) return;
    for (var i = 0; i < add.length; i++) {
      var s = add[i];
      if (typeof s === 'string' && s && list.indexOf(s) === -1) list.push(s);
    }
  }

  function applyDelta(out, key, add, remove) {
    if (Array.isArray(add)) mergeList(out[key], add);
    if (Array.isArray(remove)) {
      out[key] = out[key].filter(function (s) { return remove.indexOf(s) === -1; });
    }
  }

  // 把一条规则合并进 out（不修改规则对象本身）
  // v0.2 新增 theme 字段合并：非空字符串时覆盖 out.theme（按站点固定译文主题）；
  // 空串/缺省不动（沿用用户设置）。
  function applyRuleInto(out, r) {
    if (!r || typeof r !== 'object') return;
    if (Array.isArray(r.selectors)) out.selectors = r.selectors.slice();
    if (Array.isArray(r.excludeSelectors)) out.excludeSelectors = r.excludeSelectors.slice();
    if (typeof r.theme === 'string' && r.theme) out.theme = r.theme;
    mergeList(out.selectors, r.additionalSelectors);
    mergeList(out.excludeSelectors, r.additionalExcludeSelectors);
    applyDelta(out, 'selectors', r['selectors.add'], r['selectors.remove']);
    applyDelta(out, 'excludeSelectors', r['excludeSelectors.add'], r['excludeSelectors.remove']);
  }

  function userRulePattern(r) {
    // pattern 为主字段；match 是 options 页示例写法（options.html 用户规则 JSON 示例），同样接受
    return r && (r.pattern || r.match || r.url || r.matches || r.host);
  }

  TA.rules = {
    matchUrlPattern: matchPattern,

    // 解析当前 URL 生效的站点规则：
    // { selectors:[], excludeSelectors:[], theme?:string }
    // theme 仅当站点规则显式给出非空值时存在（main.js collectOpts 读取后作为
    // opts.effectiveTheme 传给 injector，覆盖 settings.targetStyle.theme）
    resolve: function (url, settings) {
      var out = { selectors: [], excludeSelectors: [] };
      var matched = [];
      for (var i = 0; i < BUILTIN_RULES.length; i++) {
        if (matchPattern(BUILTIN_RULES[i].pattern, url)) matched.push(BUILTIN_RULES[i]);
      }
      var userRules = (settings && Array.isArray(settings.userRules)) ? settings.userRules : [];
      for (var j = 0; j < userRules.length; j++) {
        if (userRules[j] && typeof userRules[j] === 'object' && matchPattern(userRulePattern(userRules[j]), url)) {
          matched.push(userRules[j]);
        }
      }
      for (var k = 0; k < matched.length; k++) applyRuleInto(out, matched[k]);
      return out;
    },

    // URL 黑白名单（settings.urlPattern，官方 translationUrlPattern 语义）
    isBlocked: function (url, settings) {
      var up = (settings && settings.urlPattern) || {};
      var excluded = Array.isArray(up.excludedUrls) ? up.excludedUrls : [];
      for (var i = 0; i < excluded.length; i++) {
        if (matchPattern(excluded[i], url)) return { blocked: true, reason: 'excluded' };
      }
      var included = Array.isArray(up.includedUrls) ? up.includedUrls : [];
      if (included.length) {
        var hit = false;
        for (var j = 0; j < included.length; j++) {
          if (matchPattern(included[j], url)) { hit = true; break; }
        }
        if (!hit) return { blocked: true, reason: 'notIncluded' };
      }
      return { blocked: false, reason: null };
    }
  };
})();
