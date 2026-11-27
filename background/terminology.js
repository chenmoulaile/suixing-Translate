// background/terminology.js —— 术语一致性：内置双语预设词库 + CSV 解析 + prompt 拼装
// 供其它模块读取 settings.ai.{enableTerms,termsPreset,customTerms} 生成术语段落，
// 再注入各 AI 适配器的 cfg.termsText。保持纯同步、无副作用。
//   PRESETS          内置领域词库（英文→中文），含经典歧义消解对（margin=保证金、culture=培养 等）
//   parseCSV(text)   解析 "source,target" 行（亦兼容中文逗号/制表符），跳过空行与 # 注释行
//   buildTermsSection(settings)  合并预设 + 自定义词，返回术语提示串；无词返回 ''
//   buildSystemPrompt(base, langName, settings)  基础 prompt + '\n\n' + 术语段
//   getPresetNames() 预设领域名列表
(function () {
  'use strict';
  var TA = globalThis.TA = globalThis.TA || {};

  // 内置领域词库（英文→中文）；含经典歧义消解对
  var PRESETS = {
    // 法律：margin 取"保证金"而非"页边距"；consideration 取"对价"
    legal: {
      margin: '保证金', consideration: '对价', brief: '案情摘要', appeal: '上诉',
      liability: '法律责任', contract: '合同', plaintiff: '原告', defendant: '被告',
      verdict: '裁决', jurisdiction: '管辖权'
    },
    // 医疗：culture 取"培养"而非"文化"；administration 取"给药"
    medical: {
      culture: '培养', administration: '给药', prescription: '处方', diagnosis: '诊断',
      surgery: '外科手术', symptom: '症状', therapy: '治疗', vaccine: '疫苗',
      anemia: '贫血', incision: '切口'
    },
    // 电商
    ecommerce: {
      cart: '购物车', checkout: '结账', coupon: '优惠券', refund: '退款',
      inventory: '库存', shipment: '发货', discount: '折扣', order: '订单',
      listing: '商品列表', installment: '分期付款'
    },
    // 教育：grade 取"年级"
    education: {
      course: '课程', grade: '年级', semester: '学期', tuition: '学费',
      scholarship: '奖学金', enrollment: '入学', lecture: '讲座', assignment: '作业',
      campus: '校园', graduation: '毕业'
    },
    // 游戏
    gaming: {
      buff: '增益效果', crit: '暴击', mana: '法力值', respawn: '重生',
      loot: '战利品', quest: '任务', guild: '公会', inventory: '背包',
      skill: '技能', level: '等级'
    },
    // 小说
    novel: {
      chapter: '章节', protagonist: '主角', plot: '情节', character: '人物',
      narrator: '叙述者', dialogue: '对话', setting: '场景', climax: '高潮',
      metaphor: '隐喻', prose: '散文'
    },
    // 金融：margin 取"保证金"；liability 取"负债"
    finance: {
      margin: '保证金', interest: '利息', dividend: '股息', principal: '本金',
      hedge: '对冲', asset: '资产', liability: '负债', equity: '股权',
      inflation: '通货膨胀', portfolio: '投资组合'
    },
    // 技术
    tech: {
      cache: '缓存', thread: '线程', buffer: '缓冲区', kernel: '内核',
      latency: '延迟', bandwidth: '带宽', compiler: '编译器', protocol: '协议',
      deploy: '部署', algorithm: '算法'
    },
    // 算法竞赛 / OI：英文与日文竞赛术语并列，面向中文输出。歧义项按竞赛语境消解：
    // DP=动态规划（非"分区"），mod=取模（非"模块"），table=表，weight=权值，state=状态。
    oi: {
      // —— 动态规划 ——
      'dynamic programming': '动态规划', DP: '动态规划', 'state transition': '状态转移',
      transition: '转移', state: '状态', 'recurrence relation': '递推式',
      memoization: '记忆化搜索', knapsack: '背包', 'bitmask DP': '状压 DP',
      'interval DP': '区间 DP', 'tree DP': '树形 DP', 'digit DP': '数位 DP',
      'DP table': 'DP 表',
      // —— 多项式 / 变换 ——
      convolution: '卷积', convolve: '卷积', 'number theoretic transform': '数论变换',
      NTT: '数论变换', 'fast Fourier transform': '快速傅里叶变换', FFT: '快速傅里叶变换',
      'generating function': '生成函数',
      // —— 数论 / 模运算 ——
      'modular arithmetic': '模运算', modulo: '取模', mod: '取模',
      'modular inverse': '模逆元', 'inverse element': '逆元', inverse: '逆元',
      'modulo operation': '取模运算', 'prime factorization': '质因数分解',
      'sieve of Eratosthenes': '埃氏筛', 'Eulers totient': '欧拉函数',
      'greatest common divisor': '最大公约数', GCD: '最大公约数',
      'least common multiple': '最小公倍数', LCM: '最小公倍数',
      'extended Euclidean algorithm': '扩展欧几里得算法', extgcd: '扩展欧几里得',
      'Chinese remainder theorem': '中国剩余定理', CRT: '中国剩余定理',
      'Fermats little theorem': '费马小定理', 'primitive root': '原根',
      // —— 代数结构 ——
      monoid: '幺半群', semigroup: '半群', identity: '单位元', associative: '结合律',
      // —— 数据结构 ——
      'segment tree': '线段树', 'lazy propagation': '懒标记',
      'persistent segment tree': '可持久化线段树', 'Fenwick tree': '树状数组',
      'Binary Indexed Tree': '树状数组', BIT: '树状数组', 'sparse table': '稀疏表',
      'disjoint set union': '并查集', DSU: '并查集', 'union-find': '并查集',
      'priority queue': '优先队列', 'monotonic stack': '单调栈',
      'monotonic queue': '单调队列', 'sliding window': '滑动窗口',
      'two pointers': '双指针', 'prefix sum': '前缀和', 'imos method': '差分数组',
      'coordinate compression': '离散化', 'square root decomposition': '分块',
      trie: '字典树', 'suffix array': '后缀数组', 'suffix automaton': '后缀自动机',
      'rolling hash': '滚动哈希', 'Cartesian tree': '笛卡尔树',
      'half-open interval': '半开区间', 'half-open': '左闭右开',
      tree: '树', edge: '边', vertex: '顶点', node: '节点', weight: '权值',
      subtree: '子树', heap: '堆', table: '表', 'lookup table': '查找表',
      // —— 图论 / 搜索 ——
      'binary search': '二分查找', 'binary lifting': '倍增', doubling: '倍增',
      'lowest common ancestor': '最近公共祖先', LCA: '最近公共祖先',
      'heavy-light decomposition': '树链剖分', HLD: '树链剖分',
      'centroid decomposition': '点分治', 'breadth-first search': '广度优先搜索',
      BFS: '广度优先搜索', 'depth-first search': '深度优先搜索', DFS: '深度优先搜索',
      'shortest path': '最短路', 'minimum spanning tree': '最小生成树', MST: '最小生成树',
      'topological sort': '拓扑排序', 'strongly connected component': '强连通分量',
      SCC: '强连通分量', 'connected component': '连通分量', 'maximum flow': '最大流',
      'min-cost flow': '最小费用流', 'bipartite matching': '二分图匹配', cycle: '环',
      'matrix exponentiation': '矩阵快速幂', 'fast exponentiation': '快速幂',
      'binary exponentiation': '快速幂',
      // —— 组合数学 / 概率 ——
      'expected value': '期望值', expectation: '期望', 'random variable': '随机变量',
      variance: '方差', probability: '概率', combination: '组合数',
      'binomial coefficient': '二项式系数', permutation: '排列', factorial: '阶乘',
      'inclusion-exclusion': '容斥原理', 'Mobius inversion': '莫比乌斯反演',
      'Catalan number': '卡特兰数',
      // —— 复杂度 / 算法范式 ——
      'time complexity': '时间复杂度', 'space complexity': '空间复杂度',
      amortized: '摊还', greedy: '贪心', 'brute force': '暴力枚举',
      backtracking: '回溯', 'divide and conquer': '分治', 'offline queries': '离线询问',
      median: '中位数', bitmask: '位掩码',
      // —— 日文竞赛术语（AtCoder 原文）——
      '動的計画法': '动态规划', '線分木': '线段树', '累積和': '前缀和',
      'ビット木': '树状数组', 'Union-Find': '并查集', '最短経路': '最短路',
      '最小全域木': '最小生成树', '強連結成分': '强连通分量',
      '連結成分': '连通分量', '二分探索': '二分查找', '期待値': '期望值',
      '確率': '概率', '畳み込み': '卷积', '逆元': '逆元', '組合せ': '组合数',
      '階乗': '阶乘', '素因数分解': '质因数分解', '中国の剰余定理': '中国剩余定理',
      '計算量': '复杂度', '全探索': '暴力枚举', '場合分け': '分类讨论',
      '区間': '区间', '半開区間': '半开区间', '競技プログラミング': '算法竞赛',
      'アルゴリズム': '算法', 'データ構造': '数据结构'
    }
  };

  // 算法竞赛语境的额外翻译约束，仅当 termsPreset === 'oi' 时追加到术语段。
  // 与 AtCoder Better 的翻译规则对齐：只输出译文、保留排版、代码/变量/公式/占位符不动。
  var CONTEST_RULES =
    'Competitive-programming rules: output ONLY the translation with no explanations or notes; ' +
    'maintain all original formatting, line breaks and numbering; ' +
    'keep code snippets, variable names, function names and identifiers untranslated; ' +
    'keep LaTeX equations, formulas and mathematical symbols unchanged, otherwise keep brackets [], HTML tags and their content unchanged; ' +
    'preserve every 8-digit numeric placeholder (e.g. 【12345678】, [12345678], {12345678}) unchanged and exactly once - sentence-internal placeholders may move with target word order while paragraph-leading placeholders keep their paragraph order; ' +
    'ensure natural target-language expression.';

  // 解析 CSV：每行 "source,target"（兼容中英文逗号与制表符），跳过空行 / # 注释行；
  // 取前两段并 trim，source 或 target 为空则跳过。
  function parseCSV(text) {
    var out = {};
    if (typeof text !== 'string' || !text) return out;
    var lines = text.split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line || line.charAt(0) === '#') continue;
      var parts = line.split(/,|，|\t/);
      var src = (parts[0] || '').trim();
      var tgt = (parts[1] || '').trim();
      if (!src || !tgt) continue;
      out[src] = tgt;
    }
    return out;
  }

  // 合并 PRESETS[termsPreset] 与自定义词（自定义覆盖预设），拼成术语提示串；无词返回 ''
  function buildTermsSection(settings) {
    settings = settings || {};
    var ai = settings.ai || {};
    if (!ai.enableTerms) return '';
    var merged = {};
    var preset = (typeof ai.termsPreset === 'string' && ai.termsPreset) ? PRESETS[ai.termsPreset] : null;
    if (preset) {
      Object.keys(preset).forEach(function (k) { merged[k] = preset[k]; });
    }
    var custom = parseCSV(ai.customTerms);
    Object.keys(custom).forEach(function (k) { merged[k] = custom[k]; });
    var keys = Object.keys(merged);
    if (!keys.length) return '';
    var pairs = keys.map(function (k) { return k + '=>' + merged[k]; });
    var section = 'Use these terminology translations consistently (source => target): ' + pairs.join('; ');
    if (ai.termsPreset === 'oi') section += '\n' + CONTEST_RULES;
    return section;
  }

  TA.terminology = {
    PRESETS: PRESETS,
    parseCSV: parseCSV,
    buildTermsSection: buildTermsSection,
    // 基础 prompt + 术语段；langName 保留入参语义（术语段当前不按语言区分）
    buildSystemPrompt: function (base, langName, settings) {
      var terms = buildTermsSection(settings);
      return (base || '') + (terms ? '\n\n' + terms : '');
    },
    getPresetNames: function () { return Object.keys(PRESETS); }
  };
})();
