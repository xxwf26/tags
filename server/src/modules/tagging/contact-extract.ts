// 从小红书画师主页简介(desc)里抽取联系方式 + 约稿档期状态。
// 策略：正则(微信/QQ/邮箱) + 关键词(档期)优先；抽不到且简介含约稿意味时再上 AI 兜底，省 token。
import { callGeminiText, extractJson, isAiConfigured } from './ai.js';

export type Contact = { wechat?: string; qq?: string; email?: string };
export type Commission = 'open' | 'full' | 'commercial_only' | 'unknown';
export type BioExtract = { contact: Contact; commission: Commission; scheduleNote: string | null };

// ── 正则：联系方式 ──
// 微信号规则：6~20 位，字母开头，可含字母数字下划线减号。前缀词后允许冒号/空格/换行分隔。
const WECHAT_RE = /(?:微信号?|weixin|wechat|wx|vx|v信|加\s*v|扣\s*v|私\s*信\s*v|v\s*[:：])[\s:：➕+\-]*([a-zA-Z][a-zA-Z0-9_-]{4,19})/i;
const QQ_RE = /(?:qq|扣扣|企鹅)[\s号:：\-]*([1-9]\d{4,11})/i;
const EMAIL_RE = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/;

export function extractContact(bio: string): Contact {
  const c: Contact = {};
  const wx = bio.match(WECHAT_RE);
  if (wx) c.wechat = wx[1];
  const qq = bio.match(QQ_RE);
  if (qq) c.qq = qq[1];
  const em = bio.match(EMAIL_RE);
  if (em) c.email = em[1];
  return c;
}

// ── 关键词：约稿档期状态 ──
const FULL_KW = ['约稿满', '档期满', '暂不接稿', '暂停约稿', '暂不约稿', '不接稿', '档期已满', '排满', '暂停接单'];
const COMMERCIAL_KW = ['仅商稿', '只接商稿', '仅商业', '只接商业', '商业约稿', '仅接商'];
const OPEN_KW = ['约稿', '接稿', '接单', '可约', '档期', '开约', '有档期', '约起'];

export function inferCommission(bio: string): Commission {
  if (FULL_KW.some(k => bio.includes(k))) return 'full';
  if (COMMERCIAL_KW.some(k => bio.includes(k))) return 'commercial_only';
  if (OPEN_KW.some(k => bio.includes(k))) return 'open';
  return 'unknown';
}

// 截取含「档期/约稿」关键词的那句作为备注（供 engageNote）
export function extractScheduleNote(bio: string): string | null {
  const sentences = bio.split(/[\n。！!；;]/).map(s => s.trim()).filter(Boolean);
  const hit = sentences.find(s => /档期|约稿|接稿|接单|排期|商稿/.test(s));
  return hit ? hit.slice(0, 120) : null;
}

// AI 兜底触发条件：简介非空、正则没抽到任何联系方式，且含约稿意味的模糊词
// （画师常把微信写成"vx➕"、"滴我"、"私"等正则难覆盖的花式表述）。
const AMBIGUOUS_KW = ['约', '稿', '联系', '滴我', 'dd', '私', '合作', '档期', '接单', '接头', '➕', 'v➕', '➕v', '威', '薇', '嶶'];
function shouldFallbackAi(bio: string, c: Contact): boolean {
  if (!isAiConfigured()) return false;
  if (c.wechat || c.qq || c.email) return false;
  return AMBIGUOUS_KW.some(k => bio.toLowerCase().includes(k.toLowerCase()));
}

const AI_PROMPT = `你从画师的社交主页简介里抽取约稿相关信息。只输出 JSON，字段：
{"wechat":微信号或null,"qq":QQ号或null,"email":邮箱或null,"commission":"open"|"full"|"commercial_only"|"unknown","scheduleNote":一句话概括档期/约稿情况或null}
规则：微信可能写成"vx/v/➕v/滴我/私信"等，尽力还原真实号；没有就填 null。commission：可约=open，约稿满/暂停=full，仅商业=commercial_only，不确定=unknown。不要编造。`;

async function aiExtract(bio: string): Promise<Partial<BioExtract> & { contact?: Contact }> {
  try {
    const out = extractJson(await callGeminiText(AI_PROMPT, bio));
    if (!out) return {};
    const contact: Contact = {};
    if (out.wechat) contact.wechat = String(out.wechat).trim();
    if (out.qq) contact.qq = String(out.qq).trim();
    if (out.email) contact.email = String(out.email).trim();
    const commission: Commission = ['open', 'full', 'commercial_only'].includes(out.commission) ? out.commission : 'unknown';
    return { contact, commission, scheduleNote: out.scheduleNote ? String(out.scheduleNote).slice(0, 120) : null };
  } catch (e: any) {
    console.error(`[contact-extract] AI 兜底失败: ${e.message}`);
    return {};
  }
}

// 主入口：先正则+关键词，命中即返回；不足再 AI 兜底并合并。
export async function extractFromBio(bio: string | null | undefined): Promise<BioExtract> {
  const text = (bio || '').trim();
  if (!text) return { contact: {}, commission: 'unknown', scheduleNote: null };

  const contact = extractContact(text);
  const commission = inferCommission(text);
  const scheduleNote = extractScheduleNote(text);

  if (shouldFallbackAi(text, contact)) {
    const ai = await aiExtract(text);
    if (ai.contact) Object.assign(contact, ai.contact);       // AI 补充正则漏掉的联系方式
    return {
      contact,
      commission: commission !== 'unknown' ? commission : (ai.commission ?? 'unknown'),
      scheduleNote: scheduleNote ?? ai.scheduleNote ?? null,
    };
  }
  return { contact, commission, scheduleNote };
}
