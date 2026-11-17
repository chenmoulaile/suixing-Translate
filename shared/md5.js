// shared/md5.js —— 纯 JS MD5 实现（RFC 1321，公有领域算法）
// 用途：有道 webfanyi 两步签名（sign）与彩云 browser_id（WebCrypto 不提供 MD5，故自带实现）。
// 实现说明：T 常量按 RFC 1321 公式 T[i] = floor(2^32 * |sin(i)|) 在加载期生成，
// 避免手抄 64 个十六进制常量出错；输入先按 UTF-8 编码为字节再运算。
(function () {
  'use strict';
  var TA = globalThis.TA = globalThis.TA || {};

  // RFC 1321 公式生成 T 表（T[1]..T[64]）
  var T = [0];
  for (var ti = 1; ti <= 64; ti++) {
    T[ti] = Math.floor(Math.abs(Math.sin(ti)) * 4294967296);
  }

  function safeAdd(x, y) {
    // 32 位环绕加法：低 16 位相和 + 高 16 位相和 + 低 16 位进位
    var lsw = (x & 0xFFFF) + (y & 0xFFFF);
    var msw = (x >> 16) + (y >> 16) + (lsw >> 16);
    return (msw << 16) | (lsw & 0xFFFF);
  }
  function bitRol(num, cnt) {
    return (num << cnt) | (num >>> (32 - cnt));
  }
  function cmn(q, a, b, x, s, t) {
    return safeAdd(bitRol(safeAdd(safeAdd(a, q), safeAdd(x, t)), s), b);
  }
  function ff(a, b, c, d, x, s, t) { return cmn((b & c) | (~b & d), a, b, x, s, t); }
  function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & ~d), a, b, x, s, t); }
  function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
  function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | ~d), a, b, x, s, t); }

  // state 初始值：0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476（以有符号 32 位表示）
  function md5cycle(state, k) {
    var a = state[0], b = state[1], c = state[2], d = state[3];

    // 第一轮：k[0..15]，s = 7,12,17,22
    a = ff(a, b, c, d, k[0], 7, T[1]); d = ff(d, a, b, c, k[1], 12, T[2]);
    c = ff(c, d, a, b, k[2], 17, T[3]); b = ff(b, c, d, a, k[3], 22, T[4]);
    a = ff(a, b, c, d, k[4], 7, T[5]); d = ff(d, a, b, c, k[5], 12, T[6]);
    c = ff(c, d, a, b, k[6], 17, T[7]); b = ff(b, c, d, a, k[7], 22, T[8]);
    a = ff(a, b, c, d, k[8], 7, T[9]); d = ff(d, a, b, c, k[9], 12, T[10]);
    c = ff(c, d, a, b, k[10], 17, T[11]); b = ff(b, c, d, a, k[11], 22, T[12]);
    a = ff(a, b, c, d, k[12], 7, T[13]); d = ff(d, a, b, c, k[13], 12, T[14]);
    c = ff(c, d, a, b, k[14], 17, T[15]); b = ff(b, c, d, a, k[15], 22, T[16]);

    // 第二轮：k = 1,6,11,0,5,10,15,4,9,14,3,8,13,2,7,12，s = 5,9,14,20
    a = gg(a, b, c, d, k[1], 5, T[17]); d = gg(d, a, b, c, k[6], 9, T[18]);
    c = gg(c, d, a, b, k[11], 14, T[19]); b = gg(b, c, d, a, k[0], 20, T[20]);
    a = gg(a, b, c, d, k[5], 5, T[21]); d = gg(d, a, b, c, k[10], 9, T[22]);
    c = gg(c, d, a, b, k[15], 14, T[23]); b = gg(b, c, d, a, k[4], 20, T[24]);
    a = gg(a, b, c, d, k[9], 5, T[25]); d = gg(d, a, b, c, k[14], 9, T[26]);
    c = gg(c, d, a, b, k[3], 14, T[27]); b = gg(b, c, d, a, k[8], 20, T[28]);
    a = gg(a, b, c, d, k[13], 5, T[29]); d = gg(d, a, b, c, k[2], 9, T[30]);
    c = gg(c, d, a, b, k[7], 14, T[31]); b = gg(b, c, d, a, k[12], 20, T[32]);

    // 第三轮：k = 5,8,11,14,1,4,7,10,13,0,3,6,9,12,15,2，s = 4,11,16,23
    a = hh(a, b, c, d, k[5], 4, T[33]); d = hh(d, a, b, c, k[8], 11, T[34]);
    c = hh(c, d, a, b, k[11], 16, T[35]); b = hh(b, c, d, a, k[14], 23, T[36]);
    a = hh(a, b, c, d, k[1], 4, T[37]); d = hh(d, a, b, c, k[4], 11, T[38]);
    c = hh(c, d, a, b, k[7], 16, T[39]); b = hh(b, c, d, a, k[10], 23, T[40]);
    a = hh(a, b, c, d, k[13], 4, T[41]); d = hh(d, a, b, c, k[0], 11, T[42]);
    c = hh(c, d, a, b, k[3], 16, T[43]); b = hh(b, c, d, a, k[6], 23, T[44]);
    a = hh(a, b, c, d, k[9], 4, T[45]); d = hh(d, a, b, c, k[12], 11, T[46]);
    c = hh(c, d, a, b, k[15], 16, T[47]); b = hh(b, c, d, a, k[2], 23, T[48]);

    // 第四轮：k = 0,7,14,5,12,3,10,1,8,15,6,13,4,11,2,9，s = 6,10,15,21
    a = ii(a, b, c, d, k[0], 6, T[49]); d = ii(d, a, b, c, k[7], 10, T[50]);
    c = ii(c, d, a, b, k[14], 15, T[51]); b = ii(b, c, d, a, k[5], 21, T[52]);
    a = ii(a, b, c, d, k[12], 6, T[53]); d = ii(d, a, b, c, k[3], 10, T[54]);
    c = ii(c, d, a, b, k[10], 15, T[55]); b = ii(b, c, d, a, k[1], 21, T[56]);
    a = ii(a, b, c, d, k[8], 6, T[57]); d = ii(d, a, b, c, k[15], 10, T[58]);
    c = ii(c, d, a, b, k[6], 15, T[59]); b = ii(b, c, d, a, k[13], 21, T[60]);
    a = ii(a, b, c, d, k[4], 6, T[61]); d = ii(d, a, b, c, k[11], 10, T[62]);
    c = ii(c, d, a, b, k[2], 15, T[63]); b = ii(b, c, d, a, k[9], 21, T[64]);

    state[0] = safeAdd(a, state[0]);
    state[1] = safeAdd(b, state[1]);
    state[2] = safeAdd(c, state[2]);
    state[3] = safeAdd(d, state[3]);
  }

  // 从字节流 offset 处取 16 个 word（小端 4 字节合一）
  function blkAt(bytes, offset) {
    var w = new Array(16);
    for (var i = 0; i < 16; i++) {
      var j = offset + i * 4;
      w[i] = bytes[j] + (bytes[j + 1] << 8) + (bytes[j + 2] << 16) + (bytes[j + 3] << 24);
    }
    return w;
  }

  function md5Bytes(bytes) {
    var n = bytes.length;
    var state = [1732584193, -271733879, -1732584194, 271733878];
    var i = 0;
    for (; i + 64 <= n; i += 64) md5cycle(state, blkAt(bytes, i));
    // 尾部填充：剩余字节 + 0x80 + 0 + 64 位小端长度
    var tail = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    var j = 0;
    for (; i < n; i++, j++) tail[j >> 2] |= bytes[i] << ((j % 4) << 3);
    tail[j >> 2] |= 0x80 << ((j % 4) << 3);
    if (j > 55) {
      // 剩余空间不足 8 字节长度：本块先压入，再开新块写长度
      md5cycle(state, tail);
      for (var z = 0; z < 16; z++) tail[z] = 0;
    }
    // 位数 = n*8，写小端 64 位（本实现输入远小于 2^29 字节，高位恒 0，仍按通用式书写）
    tail[14] = (n * 8) | 0;
    tail[15] = (Math.floor(n / 536870912)) | 0; // n*8 的高 32 位 = floor(n / 2^29)
    md5cycle(state, tail);
    return state;
  }

  // state 元素按小端逐字节输出十六进制
  function rhex(n) {
    var s = '';
    for (var j = 0; j < 4; j++) {
      var b = (n >>> (j * 8)) & 0xFF;
      s += (b < 16 ? '0' : '') + b.toString(16);
    }
    return s;
  }

  // TA.md5(str) → 小写 hex；输入按 UTF-8 编码为字节后运算
  TA.md5 = function (str) {
    var bytes = new TextEncoder().encode(String(str));
    var state = md5Bytes(bytes);
    return rhex(state[0]) + rhex(state[1]) + rhex(state[2]) + rhex(state[3]);
  };
})();
