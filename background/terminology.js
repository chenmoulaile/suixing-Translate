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
    }
  };

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
    return 'Use these terminology translations consistently (source => target): ' + pairs.join('; ');
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
