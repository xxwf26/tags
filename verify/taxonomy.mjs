// 5 维画风标签白名单（画风打标的唯一词表）
// AI 只能从这里选；评测也按这份对齐。可自由增删。
export const TAXONOMY = {
  genre: {
    name: '风格流派',
    tags: ['日系', '厚涂', '赛璐璐', '国风古风', '欧美', '像素', '扁平', '水彩', '暗黑', '二次元', '写实', '国潮'],
  },
  subject: {
    name: '题材',
    tags: ['人物立绘', '场景', '动物', 'Q版', '机甲', '美食', '风景', '建筑', '静物', '大头'],
  },
  technique: {
    name: '技法',
    tags: ['线稿', '平涂', '厚涂', '伪厚涂', '噪点', '描线', '肌理'],
  },
  usage: {
    name: '用途',
    tags: ['头像', '立绘', '表情包', '漫画', '插画', '商稿', '海报', '同人'],
  },
  tone: {
    name: '色调/情绪',
    tags: ['高饱和', '低饱和', '冷色', '暖色', '治愈', '性冷淡', '通透', '浓郁'],
  },
};

// 别名归一：AI/平台给的近义词 → 白名单标准词
export const ALIASES = {
  '国风': '国风古风', '古风': '国风古风', '中国风': '国风古风',
  '厚涂风': '厚涂', '日系插画': '日系', '日漫': '日系',
  'q版': 'Q版', 'Q版人物': 'Q版',
  '半厚涂': '伪厚涂',
  '治愈系': '治愈', '莫兰迪': '低饱和', '高饱和度': '高饱和',
};

export function dimensions() {
  return Object.keys(TAXONOMY);
}

// 把任意标签词归一到白名单；命中返回标准词，未命中返回 null
export function normalize(word) {
  if (!word) return null;
  const w = String(word).trim();
  if (ALIASES[w]) return ALIASES[w];
  const lw = w.toLowerCase();
  for (const [k, v] of Object.entries(ALIASES)) if (k.toLowerCase() === lw) return v;
  for (const dim of Object.values(TAXONOMY)) {
    for (const t of dim.tags) {
      if (t === w || t.toLowerCase() === lw) return t;
    }
  }
  return null;
}

// 给定标准词，返回它属于哪个维度
export function dimensionOf(tag) {
  for (const [code, dim] of Object.entries(TAXONOMY)) {
    if (dim.tags.includes(tag)) return code;
  }
  return null;
}

// 生成塞进 prompt 的词表描述
export function promptTaxonomy() {
  return Object.entries(TAXONOMY)
    .map(([code, d]) => `- ${d.name}(${code})：${d.tags.join('、')}`)
    .join('\n');
}
