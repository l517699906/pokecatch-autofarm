// ==UserScript==
// @name         Poke'Catch 挂机助手 · AutoFarm
// @namespace    https://pokecatch-online.netlify.app/
// @version      3.6.0
// @description  自动 ×3 加速、自动关闭捕获图鉴卡与确认弹窗、自动进化/保存、实时产出面板、闪光与活动提醒、停滞自愈、存档备份、离开战报、手机推送
// @author       YG
// @match        https://pokecatch-online.netlify.app/*
// @match        https://pokecatch-online.pages.dev/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      api.day.app
// @connect      ntfy.sh
// @connect      api.telegram.org
// @connect      *
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  /* ====================== 基础常量 ====================== */

  const VERSION = '3.6.0';   // ⚠ 修改时请同步顶部的 @version
  // 加了 @grant 之后油猴会把脚本放进沙箱，window 不再是页面的 window；需要碰页面对象时用它
  const PAGE_WIN = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  // 改写可见性必须作用在页面自己的 document 上，否则游戏看不到
  const PAGE_DOC = PAGE_WIN.document || document;
  const SAVE_KEY = 'gachamon-save-v1';
  const CFG_KEY = 'pcauto.cfg.v1';
  const SHINY_KEY = 'pcauto.shinies.v1';
  const TICK_MS = 350;
  const BAK_INDEX = 'pcauto.bak.index';
  const BAK_PREFIX = 'pcauto.bak.';
  const RESTORE_KEY = 'pcauto.restore.pending';
  const PUSH_SECRET_KEY = 'pcauto.push.secret';
  const TALLY_KEY = 'pcauto.tally.v1';

  /* ---- 油猴存储：页面脚本读不到，用来放备份和推送密钥 ---- */

  const HAS_GM = typeof GM_getValue === 'function' && typeof GM_setValue === 'function';
  function gmGet(key, fb) { try { return HAS_GM ? GM_getValue(key, fb) : fb; } catch { return fb; } }
  function gmSet(key, v) { try { if (!HAS_GM) return false; GM_setValue(key, v); return true; } catch { return false; } }
  function gmDel(key) { try { if (HAS_GM && typeof GM_deleteValue === 'function') GM_deleteValue(key); } catch { /* 忽略 */ } }

  /*
   * 上一次页面里发起的恢复：只读出标记，启动后在日志里报告结果。
   * 写档本身在旧页面卸载时完成（见 restoreRaw），不再依赖 document-start 抢在游戏读档之前。
   */
  const restoredFrom = (() => {
    const p = gmGet(RESTORE_KEY, null);
    if (!p) return null;
    gmDel(RESTORE_KEY);
    return { label: p.label || '?', sum: p.sum || null };
  })();

  const DEFAULTS = {
    enabled: true,
    speed: 4,             // 1 / 2 / 4（界面显示 ×1 ×2 ×3）
    autoDex: true,        // 关闭捕获图鉴卡
    autoModal: true,      // 自动确认普通提示弹窗
    autoGift: true,       // 自动处理礼物/单选
    autoEvo: true,        // 自动进化
    evoEverySec: 30,
    autoSave: true,
    saveEveryMin: 5,
    notify: true,
    sound: true,
    wakeLock: true,
    stallSec: 120,
    stallReload: false,
    phaseNotify: true,       // 昼夜切换提醒
    nightGuard: true,        // 夜间零捕获告警
    keepAlive: false,        // 后台保活（实验）
    powerGuard: true,        // 战力与胜率告警
    teamAdvisor: true,       // 配队建议（区域变化/评分落后时提示）
    showGrades: true,        // 队伍/PC 评分角标
    casinoAuto: false,       // 游戏城自动（消耗金钱）
    casinoFloor: 50000,      // 金钱低于此值时停手
    grindMode: true,         // 道馆/四天王死磕（失败后继续）
    autoSwitch: false,       // 残血自动换人（默认关，可能和你抢操作）
    switchAtHp: 30,          // 上场宝可梦血量低于该百分比时换人
    autoBerry: true,         // 自动吃树果
    berryLeadMin: 25,        // 剩余不足多少分钟时补一颗
    berryFamilies: { shiny: true, dex: true, rare: true, capture: true, xp: true, money: true },
    berryReserve: 1,         // 每种至少留几颗不吃
    useRareCandy: false,     // 一键喂糖是否包含神奇糖果（默认保护不吃）
    hud: true,
    hudCollapsed: false,
    hudX: null,
    hudY: null,
    logToConsole: false,
    // 存档备份（存在油猴自己的存储里，不占页面 localStorage 的 5MB）
    backup: true,
    backupEveryMin: 30,
    backupKeep: 8,           // 自动备份保留份数；手动备份和「恢复前」备份另外最多留 5 份
    // 离开战报
    awayReport: true,
    awayMin: 15,             // 离开超过多少分钟，回来时弹战报
    // 手机推送（地址和密钥存在油猴存储里，不进 cfg，页面读不到）
    push: false,
    pushType: 'ntfy',        // bark / ntfy / telegram
    pushOnlyAway: true,      // 只在您不在电脑前时推送（标签页在后台，或 5 分钟没操作）
    pushEvents: { shiny: true, event: true, stall: true, manual: true, badge: false, death: false },
  };

  const SAFE_EXACT = [
    '继续', '确定', '确定！', '好', '好的', '明白了', '太棒了', '收下', '领取', '关闭', '跳过', '知道了', '是', '嗯',
    '在这里玩', '在这里继续', 'Jouer ici', 'Continuer ici', 'Play here', 'Play here instead', 'Jugar aquí', 'Hier spielen',
    'Continuer', 'Continue', 'Confirmer', 'Valider', 'Fermer', 'Passer', 'Oui', 'Compris', 'Super !', 'Génial !',
    'OK', 'Okay', 'Continuar', 'Weiter', '계속', '続ける', 'はい',
  ];
  const DENY = /取消|返回|放弃|放生|出售|购买|删除|重置|Annuler|Retour|Relâcher|Vendre|Acheter|Supprimer|Cancel|Back/i;
  // 出现这些词的弹窗一律不自动点击（不可逆操作 / 玩家自己打开的详情卡）
  const DANGER = /放生|Relâcher|出售|Vendre|删除|Supprimer|重置|Reset|Recommencer|重新开始|放弃|Abandonner|改名|Renommer|换装|重置存档/i;

  /* ====================== 昼夜 / 场景常量（对齐游戏 DAYTIME 规则） ====================== */

  // 来源：t.DAYTIME.PHASES —— 早晨 8:00 起、白天 10:00 起、夜晚 20:00 起（浏览器本地时区）
  const PHASES = [
    { key: 'morning', icon: '🌅', name: '早晨', from: 8 },
    { key: 'day', icon: '☀️', name: '白天', from: 10 },
    { key: 'night', icon: '🌙', name: '夜晚', from: 20 },
  ];
  // 室内场景：昼夜权重完全不生效（游戏用 Math.max 取最大权重）
  const INDOOR_RE = /cave|tunnel|tower|mansion|silph|power-plant|well|ruins-of-alph-interior|ice-path|whirl|mortar|falls|dragons-den|seafoam|mt-moon|victory-road|underground|dojo|rocket-hq|house|lab|department|game-corner|pokemon-center/i;

  function phaseIndex(h = new Date().getHours()) {
    return h >= 20 || h < 8 ? 2 : h >= 10 ? 1 : 0;
  }
  function phaseInfo() {
    const d = new Date();
    const idx = phaseIndex(d.getHours());
    const next = new Date(d);
    if (idx === 2) {
      next.setHours(8, 0, 0, 0);
      if (next <= d) next.setDate(next.getDate() + 1);
    } else if (idx === 0) {
      next.setHours(10, 0, 0, 0);
    } else {
      next.setHours(20, 0, 0, 0);
    }
    const mins = Math.max(0, Math.round((next - d) / 60000));
    return { idx, ...PHASES[idx], until: next, mins, left: `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, '0')}m` };
  }
  function nodeIndoor(node) {
    if (!node) return false;
    if (node.type === 'heal' || node.bg === 'pokecenter') return true;
    if (typeof node.indoor === 'boolean') return node.indoor;
    if (node.type === 'gift') return true;
    if (/^(cave|gym|pokecenter)/.test(node.bg || '')) return true;
    return INDOOR_RE.test(node.bg || '');
  }

  /* ====================== 消耗品：树果增益表（对齐游戏 BUFF_BERRIES） ====================== */

  // 一棵树果 = 该 family 的限时增益，BUFF_MIN=60 分钟，最多叠 BUFF_STACK=4 层（240 分钟）
  const BERRY_BUFFS = {
    'starf-berry':        { family: 'shiny',   mult: 2,    rank: 3, label: '闪光' },
    'enigma-berry':       { family: 'dex',     mult: 3,    rank: 3, label: '图鉴' },
    'nanab-berry':        { family: 'rare',    mult: 2,    rank: 3, label: '稀有' },
    'golden-razz-berry':  { family: 'capture', mult: 1.5,  rank: 2, label: '捕获' },
    'razz-berry':         { family: 'capture', mult: 1.25, rank: 1, label: '捕获' },
    'pinap-berry':        { family: 'xp',      mult: 1.25, rank: 1, label: '经验' },
    'lansat-berry':       { family: 'money',   mult: 1.25, rank: 1, label: '金钱' },
  };
  const BUFF_MIN_MS = 60 * 60 * 1000;
  const BUFF_STACK = 4;

  /* ====================== 数据：种族值表（来自游戏 POKEDEX，493 条） ====================== */

  const BASE_RAW = '1:45-49-49-65-65-45|2:60-62-63-80-80-60|3:80-82-83-100-100-80|4:39-52-43-60-50-65|5:58-64-58-80-65-80|6:78-84-78-109-85-100|7:44-48-65-50-64-43|8:59-63-80-65-80-58|9:79-83-100-85-105-78|10:45-30-35-20-20-45|11:50-20-55-25-25-30|12:60-45-50-90-80-70|13:40-35-30-20-20-50|14:45-25-50-25-25-35|15:65-90-40-45-80-75|16:40-45-40-35-35-56|17:63-60-55-50-50-71|18:83-80-75-70-70-101|19:30-56-35-25-35-72|20:55-81-60-50-70-97|21:40-60-30-31-31-70|22:65-90-65-61-61-100|23:35-60-44-40-54-55|24:60-95-69-65-79-80|25:35-55-40-50-50-90|26:60-90-55-90-80-110|27:50-75-85-20-30-40|28:75-100-110-45-55-65|29:55-47-52-40-40-41|30:70-62-67-55-55-56|31:90-92-87-75-85-76|32:46-57-40-40-40-50|33:61-72-57-55-55-65|34:81-102-77-85-75-85|35:70-45-48-60-65-35|36:95-70-73-95-90-60|37:38-41-40-50-65-65|38:73-76-75-81-100-100|39:115-45-20-45-25-20|40:140-70-45-85-50-45|41:40-45-35-30-40-55|42:75-80-70-65-75-90|43:45-50-55-75-65-30|44:60-65-70-85-75-40|45:75-80-85-110-90-50|46:35-70-55-45-55-25|47:60-95-80-60-80-30|48:60-55-50-40-55-45|49:70-65-60-90-75-90|50:10-55-25-35-45-95|51:35-100-50-50-70-120|52:40-45-35-40-40-90|53:65-70-60-65-65-115|54:50-52-48-65-50-55|55:80-82-78-95-80-85|56:40-80-35-35-45-70|57:65-105-60-60-70-95|58:55-70-45-70-50-60|59:90-110-80-100-80-95|60:40-50-40-40-40-90|61:65-65-65-50-50-90|62:90-95-95-70-90-70|63:25-20-15-105-55-90|64:40-35-30-120-70-105|65:55-50-45-135-95-120|66:70-80-50-35-35-35|67:80-100-70-50-60-45|68:90-130-80-65-85-55|69:50-75-35-70-30-40|70:65-90-50-85-45-55|71:80-105-65-100-70-70|72:40-40-35-50-100-70|73:80-70-65-80-120-100|74:40-80-100-30-30-20|75:55-95-115-45-45-35|76:80-120-130-55-65-45|77:50-85-55-65-65-90|78:65-100-70-80-80-105|79:90-65-65-40-40-15|80:95-75-110-100-80-30|81:25-35-70-95-55-45|82:50-60-95-120-70-70|83:52-90-55-58-62-60|84:35-85-45-35-35-75|85:60-110-70-60-60-110|86:65-45-55-45-70-45|87:90-70-80-70-95-70|88:80-80-50-40-50-25|89:105-105-75-65-100-50|90:30-65-100-45-25-40|91:50-95-180-85-45-70|92:30-35-30-100-35-80|93:45-50-45-115-55-95|94:60-65-60-130-75-110|95:35-45-160-30-45-70|96:60-48-45-43-90-42|97:85-73-70-73-115-67|98:30-105-90-25-25-50|99:55-130-115-50-50-75|100:40-30-50-55-55-100|101:60-50-70-80-80-150|102:60-40-80-60-45-40|103:95-95-85-125-75-55|104:50-50-95-40-50-35|105:60-80-110-50-80-45|106:50-120-53-35-110-87|107:50-105-79-35-110-76|108:90-55-75-60-75-30|109:40-65-95-60-45-35|110:65-90-120-85-70-60|111:80-85-95-30-30-25|112:105-130-120-45-45-40|113:250-5-5-35-105-50|114:65-55-115-100-40-60|115:105-95-80-40-80-90|116:30-40-70-70-25-60|117:55-65-95-95-45-85|118:45-67-60-35-50-63|119:80-92-65-65-80-68|120:30-45-55-70-55-85|121:60-75-85-100-85-115|122:40-45-65-100-120-90|123:70-110-80-55-80-105|124:65-50-35-115-95-95|125:65-83-57-95-85-105|126:65-95-57-100-85-93|127:65-125-100-55-70-85|128:75-100-95-40-70-110|129:20-10-55-15-20-80|130:95-125-79-60-100-81|131:130-85-80-85-95-60|132:48-48-48-48-48-48|133:55-55-50-45-65-55|134:130-65-60-110-95-65|135:65-65-60-110-95-130|136:65-130-60-95-110-65|137:65-60-70-85-75-40|138:35-40-100-90-55-35|139:70-60-125-115-70-55|140:30-80-90-55-45-55|141:60-115-105-65-70-80|142:80-105-65-60-75-130|143:160-110-65-65-110-30|144:90-85-100-95-125-85|145:90-90-85-125-90-100|146:90-100-90-125-85-90|147:41-64-45-50-50-50|148:61-84-65-70-70-70|149:91-134-95-100-100-80|150:106-110-90-154-90-130|151:100-100-100-100-100-100|152:45-49-65-49-65-45|153:60-62-80-63-80-60|154:80-82-100-83-100-80|155:39-52-43-60-50-65|156:58-64-58-80-65-80|157:78-84-78-109-85-100|158:50-65-64-44-48-43|159:65-80-80-59-63-58|160:85-105-100-79-83-78|161:35-46-34-35-45-20|162:85-76-64-45-55-90|163:60-30-30-36-56-50|164:100-50-50-86-96-70|165:40-20-30-40-80-55|166:55-35-50-55-110-85|167:40-60-40-40-40-30|168:70-90-70-60-70-40|169:85-90-80-70-80-130|170:75-38-38-56-56-67|171:125-58-58-76-76-67|172:20-40-15-35-35-60|173:50-25-28-45-55-15|174:90-30-15-40-20-15|175:35-20-65-40-65-20|176:55-40-85-80-105-40|177:40-50-45-70-45-70|178:65-75-70-95-70-95|179:55-40-40-65-45-35|180:70-55-55-80-60-45|181:90-75-85-115-90-55|182:75-80-95-90-100-50|183:70-20-50-20-50-40|184:100-50-80-60-80-50|185:70-100-115-30-65-30|186:90-75-75-90-100-70|187:35-35-40-35-55-50|188:55-45-50-45-65-80|189:75-55-70-55-95-110|190:55-70-55-40-55-85|191:30-30-30-30-30-30|192:75-75-55-105-85-30|193:65-65-45-75-45-95|194:55-45-45-25-25-15|195:95-85-85-65-65-35|196:65-65-60-130-95-110|197:95-65-110-60-130-65|198:60-85-42-85-42-91|199:95-75-80-100-110-30|200:60-60-60-85-85-85|201:48-72-48-72-48-48|202:190-33-58-33-58-33|203:70-80-65-90-65-85|204:50-65-90-35-35-15|205:75-90-140-60-60-40|206:100-70-70-65-65-45|207:65-75-105-35-65-85|208:75-85-200-55-65-30|209:60-80-50-40-40-30|210:90-120-75-60-60-45|211:65-95-85-55-55-85|212:70-130-100-55-80-65|213:20-10-230-10-230-5|214:80-125-75-40-95-85|215:55-95-55-35-75-115|216:60-80-50-50-50-40|217:90-130-75-75-75-55|218:40-40-40-70-40-20|219:60-50-120-90-80-30|220:50-50-40-30-30-50|221:100-100-80-60-60-50|222:65-55-95-65-95-35|223:35-65-35-65-35-65|224:75-105-75-105-75-45|225:45-55-45-65-45-75|226:85-40-70-80-140-70|227:65-80-140-40-70-70|228:45-60-30-80-50-65|229:75-90-50-110-80-95|230:75-95-95-95-95-85|231:90-60-60-40-40-40|232:90-120-120-60-60-50|233:85-80-90-105-95-60|234:73-95-62-85-65-85|235:55-20-35-20-45-75|236:35-35-35-35-35-35|237:50-95-95-35-110-70|238:45-30-15-85-65-65|239:45-63-37-65-55-95|240:45-75-37-70-55-83|241:95-80-105-40-70-100|242:255-10-10-75-135-55|243:90-85-75-115-100-115|244:115-115-85-90-75-100|245:100-75-115-90-115-85|246:50-64-50-45-50-41|247:70-84-70-65-70-51|248:100-134-110-95-100-61|249:106-90-130-90-154-110|250:106-130-90-110-154-90|251:100-100-100-100-100-100|252:40-45-35-65-55-70|253:50-65-45-85-65-95|254:70-85-65-105-85-120|255:45-60-40-70-50-45|256:60-85-60-85-60-55|257:80-120-70-110-70-80|258:50-70-50-50-50-40|259:70-85-70-60-70-50|260:100-110-90-85-90-60|261:35-55-35-30-30-35|262:70-90-70-60-60-70|263:38-30-41-30-41-60|264:78-70-61-50-61-100|265:45-45-35-20-30-20|266:50-35-55-25-25-15|267:60-70-50-100-50-65|268:50-35-55-25-25-15|269:60-50-70-50-90-65|270:40-30-30-40-50-30|271:60-50-50-60-70-50|272:80-70-70-90-100-70|273:40-40-50-30-30-30|274:70-70-40-60-40-60|275:90-100-60-90-60-80|276:40-55-30-30-30-85|277:60-85-60-75-50-125|278:40-30-30-55-30-85|279:60-50-100-95-70-65|280:28-25-25-45-35-40|281:38-35-35-65-55-50|282:68-65-65-125-115-80|283:40-30-32-50-52-65|284:70-60-62-100-82-80|285:60-40-60-40-60-35|286:60-130-80-60-60-70|287:60-60-60-35-35-30|288:80-80-80-55-55-90|289:150-160-100-95-65-100|290:31-45-90-30-30-40|291:61-90-45-50-50-160|292:1-90-45-30-30-40|293:64-51-23-51-23-28|294:84-71-43-71-43-48|295:104-91-63-91-73-68|296:72-60-30-20-30-25|297:144-120-60-40-60-50|298:50-20-40-20-40-20|299:30-45-135-45-90-30|300:50-45-45-35-35-50|301:70-65-65-55-55-90|302:50-75-75-65-65-50|303:50-85-85-55-55-50|304:50-70-100-40-40-30|305:60-90-140-50-50-40|306:70-110-180-60-60-50|307:30-40-55-40-55-60|308:60-60-75-60-75-80|309:40-45-40-65-40-65|310:70-75-60-105-60-105|311:60-50-40-85-75-95|312:60-40-50-75-85-95|313:65-73-75-47-85-85|314:65-47-75-73-85-85|315:50-60-45-100-80-65|316:70-43-53-43-53-40|317:100-73-83-73-83-55|318:45-90-20-65-20-65|319:70-120-40-95-40-95|320:130-70-35-70-35-60|321:170-90-45-90-45-60|322:60-60-40-65-45-35|323:70-100-70-105-75-40|324:70-85-140-85-70-20|325:60-25-35-70-80-60|326:80-45-65-90-110-80|327:60-60-60-60-60-60|328:45-100-45-45-45-10|329:50-70-50-50-50-70|330:80-100-80-80-80-100|331:50-85-40-85-40-35|332:70-115-60-115-60-55|333:45-40-60-40-75-50|334:75-70-90-70-105-80|335:73-115-60-60-60-90|336:73-100-60-100-60-65|337:90-55-65-95-85-70|338:90-95-85-55-65-70|339:50-48-43-46-41-60|340:110-78-73-76-71-60|341:43-80-65-50-35-35|342:63-120-85-90-55-55|343:40-40-55-40-70-55|344:60-70-105-70-120-75|345:66-41-77-61-87-23|346:86-81-97-81-107-43|347:45-95-50-40-50-75|348:75-125-100-70-80-45|349:20-15-20-10-55-80|350:95-60-79-100-125-81|351:70-70-70-70-70-70|352:60-90-70-60-120-40|353:44-75-35-63-33-45|354:64-115-65-83-63-65|355:20-40-90-30-90-25|356:40-70-130-60-130-25|357:99-68-83-72-87-51|358:75-50-80-95-90-65|359:65-130-60-75-60-75|360:95-23-48-23-48-23|361:50-50-50-50-50-50|362:80-80-80-80-80-80|363:70-40-50-55-50-25|364:90-60-70-75-70-45|365:110-80-90-95-90-65|366:35-64-85-74-55-32|367:55-104-105-94-75-52|368:55-84-105-114-75-52|369:100-90-130-45-65-55|370:43-30-55-40-65-97|371:45-75-60-40-30-50|372:65-95-100-60-50-50|373:95-135-80-110-80-100|374:40-55-80-35-60-30|375:60-75-100-55-80-50|376:80-135-130-95-90-70|377:80-100-200-50-100-50|378:80-50-100-100-200-50|379:80-75-150-75-150-50|380:80-80-90-110-130-110|381:80-90-80-130-110-110|382:100-100-90-150-140-90|383:100-150-140-100-90-90|384:105-150-90-150-90-95|385:100-100-100-100-100-100|386:50-150-50-150-50-150|387:55-68-64-45-55-31|388:75-89-85-55-65-36|389:95-109-105-75-85-56|390:44-58-44-58-44-61|391:64-78-52-78-52-81|392:76-104-71-104-71-108|393:53-51-53-61-56-40|394:64-66-68-81-76-50|395:84-86-88-111-101-60|396:40-55-30-30-30-60|397:55-75-50-40-40-80|398:85-120-70-50-60-100|399:59-45-40-35-40-31|400:79-85-60-55-60-71|401:37-25-41-25-41-25|402:77-85-51-55-51-65|403:45-65-34-40-34-45|404:60-85-49-60-49-60|405:80-120-79-95-79-70|406:40-30-35-50-70-55|407:60-70-65-125-105-90|408:67-125-40-30-30-58|409:97-165-60-65-50-58|410:30-42-118-42-88-30|411:60-52-168-47-138-30|412:40-29-45-29-45-36|413:60-59-85-79-105-36|414:70-94-50-94-50-66|415:30-30-42-30-42-70|416:70-80-102-80-102-40|417:60-45-70-45-90-95|418:55-65-35-60-30-85|419:85-105-55-85-50-115|420:45-35-45-62-53-35|421:70-60-70-87-78-85|422:76-48-48-57-62-34|423:111-83-68-92-82-39|424:75-100-66-60-66-115|425:90-50-34-60-44-70|426:150-80-44-90-54-80|427:55-66-44-44-56-85|428:65-76-84-54-96-105|429:60-60-60-105-105-105|430:100-125-52-105-52-71|431:49-55-42-42-37-85|432:71-82-64-64-59-112|433:45-30-50-65-50-45|434:63-63-47-41-41-74|435:103-93-67-71-61-84|436:57-24-86-24-86-23|437:67-89-116-79-116-33|438:50-80-95-10-45-10|439:20-25-45-70-90-60|440:100-5-5-15-65-30|441:76-65-45-92-42-91|442:50-92-108-92-108-35|443:58-70-45-40-45-42|444:68-90-65-50-55-82|445:108-130-95-80-85-102|446:135-85-40-40-85-5|447:40-70-40-35-40-60|448:70-110-70-115-70-90|449:68-72-78-38-42-32|450:108-112-118-68-72-47|451:40-50-90-30-55-65|452:70-90-110-60-75-95|453:48-61-40-61-40-50|454:83-106-65-86-65-85|455:74-100-72-90-72-46|456:49-49-56-49-61-66|457:69-69-76-69-86-91|458:45-20-50-60-120-50|459:60-62-50-62-60-40|460:90-92-75-92-85-60|461:70-120-65-45-85-125|462:70-70-115-130-90-60|463:110-85-95-80-95-50|464:115-140-130-55-55-40|465:100-100-125-110-50-50|466:75-123-67-95-85-95|467:75-95-67-125-95-83|468:85-50-95-120-115-80|469:86-76-86-116-56-95|470:65-110-130-60-65-95|471:65-60-110-130-95-65|472:75-95-125-45-75-95|473:110-130-80-70-60-80|474:85-80-70-135-75-90|475:68-125-65-65-115-80|476:60-55-145-75-150-40|477:45-100-135-65-135-45|478:70-80-70-80-70-110|479:50-50-77-95-77-91|480:75-75-130-75-130-95|481:80-105-105-105-105-80|482:75-125-70-125-70-115|483:100-120-120-150-100-90|484:90-120-100-150-120-100|485:91-90-106-130-106-77|486:110-160-110-80-110-100|487:150-100-120-100-120-90|488:120-70-110-75-120-85|489:80-80-80-80-80-80|490:100-100-100-100-100-100|491:70-90-90-135-90-125|492:100-100-100-100-100-100|493:120-120-120-120-120-120';
  const BASE = (() => {
    const out = {};
    for (const chunk of BASE_RAW.split('|')) {
      const sep = chunk.indexOf(':');
      if (sep < 0) continue;
      out[+chunk.slice(0, sep)] = chunk.slice(sep + 1).split('-').map(Number);
    }
    return out;
  })();

  // 评级：按种族值总和分档（等级相同时可直接比较强弱）
  const GRADE_TIERS = [
    { min: 600, key: 'S', color: '#f6c344', bg: 'rgba(246,195,68,.92)' },
    { min: 480, key: 'A', color: '#c084fc', bg: 'rgba(192,132,252,.92)' },
    { min: 400, key: 'B', color: '#60a5fa', bg: 'rgba(96,165,250,.92)' },
    { min: 330, key: 'C', color: '#94a3b8', bg: 'rgba(148,163,184,.92)' },
    { min: 0,   key: 'D', color: '#6b7280', bg: 'rgba(107,114,128,.85)' },
  ];

  function monStats(id, level) {
    const v = BASE[id];
    if (!v) return null;
    const [hp, atk, def, spa, spd, spe] = v;
    const baseTotal = hp + atk + def + spa + spd + spe;
    const tier = GRADE_TIERS.find((t) => baseTotal >= t.min) || GRADE_TIERS[GRADE_TIERS.length - 1];
    // 复现游戏公式（无个体值/性格加成）：floor((floor(2*base*lv/100)+5))
    const other = (b) => Math.floor(Math.floor((2 * b * level) / 100) + 5);
    const hpVal = Math.floor((2 * hp * level) / 100) + level + 10;
    const realTotal = hpVal + other(atk) + other(def) + other(spa) + other(spd) + other(spe);
    return { baseTotal, realTotal, tier, parts: { hp, atk, def, spa, spd, spe } };
  }

  /* ====================== 模块：队伍 / PC 评分角标 ====================== */

  let gradeStyleDone = false;
  function ensureGradeStyle() {
    if (gradeStyleDone) return;
    gradeStyleDone = true;
    const st = document.createElement('style');
    st.id = 'pcauto-grade-style';
    st.textContent = `
      .pcauto-grade{position:absolute;top:2px;right:2px;z-index:6;display:flex;align-items:center;gap:2px;
        padding:0 4px;height:14px;border-radius:5px;font:700 10px/14px system-ui,sans-serif;
        color:#12141c;pointer-events:none;letter-spacing:.2px;box-shadow:0 1px 3px rgba(0,0,0,.35)}
      .pcauto-grade b{font-size:10px}
      .pcauto-grade i{font-style:normal;font-weight:600;opacity:.85;font-size:9px}
      .pc-cell,.slot{position:relative}
    `;
    (document.head || document.documentElement).appendChild(st);
  }

  function buildMonMap() {
    const map = new Map();
    const save = S.save;
    if (!save) return map;
    for (const m of (save.mons || [])) {
      if (m && m.uid) map.set(String(m.uid), m);
    }
    for (const p of ((save.pension && save.pension.mons) || [])) {
      if (p && p.mon && p.mon.uid) map.set(String(p.mon.uid), p.mon);
    }
    return map;
  }

  /** 存档引用未变时复用上次的 Map，避免每 4 秒遍历整个宝可梦库 */
  function monMapCached() {
    if (S.monMapCache && S.monMapCache.src === S.save) return S.monMapCache.map;
    const map = buildMonMap();
    S.monMapCache = { src: S.save, map };
    return map;
  }

  function paintBadges(root = document) {
    if (!S.cfg.showGrades) return;
    const nodes = [...root.querySelectorAll('.pc-cell[data-uid], .slot[data-uid]')];
    if (!nodes.length) return;
    const monMap = monMapCached();
    for (const node of nodes) {
      const uid = node.dataset.uid;
      const mon = monMap.get(String(uid));
      if (!mon) continue;
      const info = monStats(mon.id, mon.level || 1);
      if (!info) continue;
      let badge = node.querySelector(':scope > .pcauto-grade');
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'pcauto-grade';
        node.appendChild(badge);
      }
      const key = `${info.tier.key}|${info.baseTotal}|${mon.level}`;
      if (badge.dataset.k === key) continue;
      badge.dataset.k = key;
      badge.style.background = info.tier.bg;
      badge.style.color = '#12141c';
      badge.innerHTML = `<b>${info.tier.key}</b><i>${info.baseTotal}</i>`;
      badge.title = `种族值合计 ${info.baseTotal}（HP${info.parts.hp}/攻${info.parts.atk}/防${info.parts.def}/特攻${info.parts.spa}/特防${info.parts.spd}/速${info.parts.spe}）\n`
          + `Lv.${mon.level} 估算总属性 ${info.realTotal}${mon.shiny ? '\n✨ 闪光' : ''}`;
    }
  }

  function startGradeWatcher() {
    ensureGradeStyle();
    paintBadges();
    let timer = 0;
    const obs = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => { try { paintBadges(); } catch { /* 忽略 */ } }, 250);
    });
    for (const sel of ['#pc-grid', '#team-slots', '#pen-grid', '#screen-team', '#screen-pension']) {
      const el = document.querySelector(sel);
      if (el) obs.observe(el, { childList: true, subtree: true });
    }
    setInterval(() => { try { paintBadges(); } catch { /* 忽略 */ } }, 4000);
  }


  /* ====================== 数据表：队伍分析（自动生成，勿手改） ====================== */
  const TA_CHART_RAW = [
    '222222222222102212211233222223121232231212223222321222223112220322221222213212213121321212211231223322223212',
    '322223212111302331222232211222112203232312232021322232222132322223122212222222332212222012212232112132212311',
    '232223121323222212022222222232232122222222222222223210222222122232232121211123222222322213212222312222223312',
  ].join('');
  const TA_DEX_RAW = [
    '47,47,47,1,1,19,2,2,2,b,b,b9,b7,b7,b7,09,09,09,0,0,09,09,7,7,3,3,8,8,7,7,78,7,7,78,h,h,1,1,0h,0h,79,79,47,47',
    ',47,b4,b4,b7,b7,8,8,0,0,2,2,6,6,1,1,2,2,26,a,a,a,6,6,6,47,47,47,27,27,c8,c8,c8,1,1,2a,2a,3g,3g,09,09,09,2,25',
    ',7,7,2,25,d7,d7,d7,c8,a,a,2,2,3,3,4a,4a,8,8,6,6,0,7,7,8c,8c,0,4,0,2,2,2,2,2,2a,ah,b9,5a,3,1,b,0,2,29,25,0,0,',
    '2,3,1,0,c2,c2,c2,c2,c9,0,59,39,19,e,e,e9,a,a,4,4,4,1,1,1,2,2,2,0,0,09,09,b9,b9,b7,b7,79,23,23,3,h,0h,h,h9,a9',
    ',a9,3,3,3,4,2h,2h,c,2,49,49,49,0,4,4,b9,28,28,a,f,f9,2a,d,a,a,0a,b,bg,0,89,g8,h,h,27,bg,bc,b6,f5,0,0,1,1c,58',
    ',58,2c,2,2,59,29,g9,f1,f1,2e,8,8,0,0,0,6,6,5a,3,1,0,0,3,1,2,c8,c8,cf,a9,19,a4,4,4,4,1,16,16,2,28,28,f,f,0,0,',
    'b,b,b9,b,b7,24,24,24,4,4f,4f,09,09,29,29,ah,ah,ah,b2,b9,4,46,0,0,0,b8,b9,bd,0,0,0,6,6,0h,c,0,0,fd,gh,gc,gc,g',
    'c,6a,6a,3,3,3,3,b,b,47,7,7,2f,2f,2,2,18,18,1,a,a,0,8,8e,8e,4,4f,09,e9,0,7,ca,ca,28,28,2,2f,8a,8a,c4,c4,cb,cb',
    ',2,2,0,0,d,d,d,d,49,a,f,a,5,5,52,52,52,2,2,2,2c,2,e,e,e9,ga,ga,ga,c,5,g,ea,ea,2,8,e9,ga,a,4,4,48,1,16,16,2,2',
    ',2g,09,09,09,0,02,b,b,3,3,3,47,47,c,c,cg,cg,b,b4,b9,b9,b9,3,2,2,4,4,2,28,0,d9,d9,0,0,d,f9,0,0,a,7f,7f,ga,ga,',
    'c,ah,0,09,df,e8,e8,e8,0,6,6g,8,8,7b,7f,76,76,4,2,2,29,45,45,f5,3g,0,8c,4,3,1,h9,b9,4,5,89,58,0,a6,cg,d,5d,3d',
    ',a,a,a,ge,2e,1g,0,de,a,2,2,f,4,0',
  ].join('');
  const TA_MOVES_RAW = [
    'absorb:420s|acid:740s|acid-armor:70t|acid-spray:740s|acrobatics:955p|acupressure:00t|aerial-ace:960p',
    '|aeroblast:9100s|after-you:00t|agility:a0t|air-cutter:960s|air-slash:975s|ally-switch:a0t|amnesia:a0',
    't|ancient-power:c60s|aqua-jet:240p|aqua-ring:20t|aqua-tail:290p|arm-thrust:646p|aromatherapy:40t|aro',
    'matic-mist:h0t|assurance:f60p|astonish:d30p|attack-order:b90p|attract:00t|aura-sphere:680s|aurora-be',
    'am:565s|aurora-veil:50t|autotomize:g0t|axe-kick:6120p|baby-doll-eyes:h0t|baton-pass:00t|beat-up:f30p',
    '|belch:7120s|belly-drum:00t|bind:015p|bite:f60p|blaze-kick:185p|blizzard:5110s|block:00t|body-press:',
    '680p|body-slam:085p|bone-rush:878p|bonemerang:8100p|boomburst:0140s|bounce:985p|brave-bird:9120p|bri',
    'ck-break:675p|brine:265s|bubble-beam:265s|bug-bite:b60p|bug-buzz:b90s|bulk-up:60t|bulldoze:860p|bull',
    'et-punch:g40p|bullet-seed:478p|calm-mind:a0t|charge:30t|charge-beam:350s|charm:h0t|chatter:965s|clea',
    'r-smog:750s|close-combat:6120p|coil:70t|comeuppance:f1p|confide:00t|confuse-ray:d0t|confusion:a50s|c',
    'onversion:00t|conversion-2:00t|copycat:00t|cosmic-power:a0t|cotton-guard:40t|cotton-spore:40t|counte',
    'r:60p|covet:060p|crabhammer:2100p|cross-chop:6100p|cross-poison:770p|crunch:f80p|crush-claw:075p|cru',
    'sh-grip:0100p|curse:d0t|cut:050p|dark-pulse:f80s|dark-void:f0t|dazzling-gleam:h80s|defend-order:b0t|',
    'defense-curl:00t|defog:90t|destiny-bond:d0t|detect:60t|dig:880p|disable:00t|disarming-voice:h40s|dis',
    'charge:380s|dive:280p|doom-desire:g140s|double-edge:0120p|double-hit:070p|double-kick:660p|double-te',
    'am:00t|dragon-ascent:9120p|dragon-breath:e60s|dragon-claw:e80p|dragon-dance:e0t|dragon-pulse:e85s|dr',
    'agon-rush:e100p|dragon-tail:e60p|drain-punch:675p|draining-kiss:h50s|dream-eater:a100s|drill-peck:98',
    '0p|drill-run:880p|dual-chop:e80p|dynamic-punch:6100p|earth-power:890s|earthquake:8100p|echoed-voice:',
    '040s|eerie-impulse:30t|electric-terrain:30t|electro-ball:360s|ember:140s|encore:00t|endeavor:00p|end',
    'ure:00t|energy-ball:490s|entrainment:00t|eruption:1150s|explosion:0250p|extrasensory:a80s|extreme-sp',
    'eed:080p|facade:070p|fairy-wind:h40s|fake-out:040p|fake-tears:f0t|false-swipe:040p|feather-dance:90t',
    '|feint:030p|fell-stinger:b50p|final-gambit:60s|fire-blast:1110s|fire-fang:165p|fire-punch:175p|fire-',
    'spin:135s|fissure:80p|flail:040p|flame-charge:150p|flame-wheel:160p|flamethrower:190s|flare-blitz:11',
    '20p|flash-cannon:g80s|flatter:f0t|fling:f40p|fly:990p|focus-energy:00t|focus-punch:6150p|follow-me:0',
    '0t|force-palm:660p|foul-play:f95p|freeze-dry:570s|frost-breath:560s|fury-attack:046p|fury-cutter:b40',
    'p|fury-swipes:056p|future-sight:a120s|gastro-acid:70t|giga-drain:475s|giga-impact:0150p|glare:00t|gr',
    'ass-knot:460s|grassy-terrain:40t|gravity:a0t|growl:00t|growth:00t|guard-split:a0t|guard-swap:a0t|gui',
    'llotine:00p|gunk-shot:7120p|gust:940s|gyro-ball:g60p|hail:50t|hammer-arm:6100p|harden:00t|haze:50t|h',
    'ead-smash:c150p|headbutt:070p|headlong-rush:8120p|heal-bell:00t|heal-pulse:a0t|healing-wish:a0t|hear',
    't-swap:a0t|heat-wave:195s|heavy-slam:g80p|helping-hand:00t|hex:d65s|hidden-power:060s|high-horsepowe',
    'r:895p|high-jump-kick:6130p|hone-claws:f0t|horn-attack:065p|horn-drill:00p|howl:00t|hurricane:9110s|',
    'hydro-pump:2110s|hyper-beam:0150s|hyper-drill:0100p|hyper-voice:090s|hypnosis:a0t|ice-beam:590s|ice-',
    'fang:565p|ice-punch:575p|ice-shard:540p|icicle-spear:578p|icy-wind:555s|imprison:a0t|incinerate:160s',
    '|inferno:1100s|infestation:b20s|ingrain:40t|iron-defense:g0t|iron-head:g80p|iron-tail:g100p|judgment',
    ':0100s|knock-off:f65p|laser-focus:00t|last-resort:0140p|lava-plume:180s|leaf-blade:490p|leaf-storm:4',
    '130s|leaf-tornado:465s|leafage:440p|leech-life:b80p|leech-seed:40t|leer:00t|lick:d30p|life-dew:20t|l',
    'ight-screen:a0t|liquidation:285p|lock-on:00t|lovely-kiss:00t|low-kick:660p|low-sweep:665p|lunar-bles',
    'sing:a0t|lunar-dance:a0t|lunge:b80p|luster-purge:a95s|mach-punch:640p|magic-room:a0t|magical-leaf:46',
    '0s|magma-storm:1100s|magnet-rise:30t|magnetic-flux:30t|mean-look:00t|mega-drain:440s|mega-kick:0120p',
    '|mega-punch:080p|megahorn:b120p|memento:f0t|metal-burst:g0p|metal-claw:g50p|metal-sound:g0t|meteor-m',
    'ash:g90p|metronome:00t|milk-drink:00t|mimic:00t|mind-reader:00t|minimize:00t|mirror-coat:a0s|mist:50',
    't|mist-ball:a95s|moonblast:h95s|moonlight:h0t|morning-sun:00t|mud-shot:855s|mud-slap:820s|muddy-wate',
    'r:290s|mystical-power:a70s|nasty-plot:f0t|night-shade:d60s|night-slash:f70p|nuzzle:320p|octazooka:26',
    '5s|origin-pulse:2110s|outrage:e120p|overheat:1130s|pain-split:00t|parting-shot:f0t|pay-day:040p|payb',
    'ack:f50p|peck:935p|perish-song:00t|petal-blizzard:490p|petal-dance:4120s|phantom-force:d90p|pin-miss',
    'ile:b78p|play-nice:00t|play-rough:h90p|pluck:960p|poison-fang:750p|poison-gas:70t|poison-jab:780p|po',
    'ison-powder:70t|poison-sting:715p|poison-tail:750p|pound:040p|powder-snow:540s|power-gem:c80s|power-',
    'split:a0t|power-swap:a0t|power-trick:a0t|power-trip:f20p|power-whip:4120p|precipice-blades:8120p|pre',
    'sent:040p|protect:00t|psybeam:a65s|psych-up:00t|psychic:a90s|psycho-boost:a140s|psycho-cut:a70p|psyc',
    'ho-shift:a0t|psyshock:a80s|psystrike:a100s|quash:f0t|quick-attack:040p|quick-guard:60t|quiver-dance:',
    'b0t|rage-fist:d50p|rage-powder:b0t|raging-bull:090p|raging-fury:1120p|rain-dance:20t|rapid-spin:050p',
    '|razor-leaf:455p|razor-shell:275p|recover:00t|recycle:00t|reflect:a0t|reflect-type:00t|rest:a0t|reta',
    'liate:070p|revenge:660p|reversal:640p|roar:00t|roar-of-time:e150s|rock-blast:c78p|rock-polish:c0t|ro',
    'ck-slide:c75p|rock-smash:640p|rock-throw:c50p|rock-tomb:c60p|rock-wrecker:c150p|role-play:a0t|rollou',
    't:c30p|roost:90t|round:060s|sacred-fire:1100p|safeguard:00t|sand-attack:80t|sand-tomb:835p|sandstorm',
    ':c0t|scary-face:00t|scratch:040p|screech:00t|seed-bomb:480p|seed-flare:4120s|seismic-toss:660p|self-',
    'destruct:0200p|shadow-ball:d80s|shadow-claw:d70p|shadow-force:d120p|shadow-punch:d60p|shadow-sneak:d',
    '40p|sheer-cold:50s|shell-smash:00t|shock-wave:360s|simple-beam:00t|sing:00t|sketch:00t|skill-swap:a0',
    't|sky-attack:9140p|slack-off:00t|slam:080p|slash:070p|sleep-powder:40t|sleep-talk:00t|sludge:765s|sl',
    'udge-bomb:790s|sludge-wave:795s|smack-down:c50p|smart-strike:g70p|smog:730s|smokescreen:00t|snarl:f5',
    '5s|snore:050s|snowscape:50t|soak:20t|soft-boiled:00t|solar-beam:4120s|spacial-rend:e100s|spark:365p|',
    'spikes:80t|spiky-shield:40t|spit-up:00s|spite:d0t|splash:00t|spore:40t|stealth-rock:c0t|steel-wing:g',
    '70p|sticky-web:b0t|stockpile:00t|stomp:065p|stomping-tantrum:875p|stone-edge:c100p|stored-power:a20s',
    '|storm-throw:660p|strength:080p|string-shot:b0t|struggle:050p|struggle-bug:b50s|stun-spore:40t|submi',
    'ssion:680p|substitute:00t|sucker-punch:f70p|sunny-day:10t|super-fang:060p|superpower:6120p|supersoni',
    'c:00t|surf:290s|swagger:00t|swallow:00t|sweet-kiss:h0t|sweet-scent:00t|swift:060s|switcheroo:f0t|swo',
    'rds-dance:00t|synthesis:40t|tackle:040p|tail-glow:b0t|tail-whip:00t|tailwind:90t|take-down:090p|take',
    '-heart:a0t|taunt:f0t|tearful-look:00t|teeter-dance:00t|teleport:a0t|thief:f60p|thrash:0120p|throat-c',
    'hop:f80p|thunder:3110s|thunder-fang:365p|thunder-punch:375p|thunder-shock:340s|thunder-wave:30t|thun',
    'derbolt:390s|tickle:00t|torment:f0t|toxic:70t|toxic-spikes:70t|toxic-thread:70t|transform:00t|tri-at',
    'tack:080s|trick:a0t|trick-room:a0t|triple-kick:660p|twin-beam:a80s|twister:e40s|u-turn:b70p|uproar:0',
    '90s|vacuum-wave:640s|venoshock:765s|vice-grip:055p|vine-whip:445p|vital-throw:670p|volt-switch:370s|',
    'water-gun:240s|water-pulse:260s|water-spout:2150s|waterfall:280p|wave-crash:2120p|weather-ball:050s|',
    'whirlpool:235s|whirlwind:00t|wide-guard:c0t|wild-charge:390p|will-o-wisp:10t|wing-attack:960p|wish:0',
    '0t|withdraw:20t|wonder-room:a0t|wood-hammer:4120p|work-up:00t|worry-seed:40t|wrap:015p|x-scissor:b80',
    'p|yawn:00t|zap-cannon:3120s|zen-headbutt:a80p',
  ].join('');
  const TA_LEARN_RAW = [
    '1.c6|3.d6|c.9a|i.a5|l.ca|x.8o|10.b3^c.9a|k.a5|p.ca|19.8o|1e.b3^0.84|c.9a|k.a5|p.ca|1f.8o|1m.b3^1.a3|',
    '4.3e|c.2v|h.3y|k.ao|o.45|w.40|10.61|14.46^c.2v|j.3y|o.ao|u.45|1c.61|1i.46^0.b|c.2v|j.3y|o.ao|u.45|1a',
    '.40|1i.61|1q.46^1.c6|3.d9|9.99|c.10|f.da|o.h|x.5o|10.dd^9.99|c.10|f.da|u.h|19.5o|1e.dd^0.47|9.99|c.1',
    '0|f.da|u.h|1d.5o|1k.dd^1.c6|9.1e^^0.4z|8.1v|g.8s|o.b|w.1f^1.8f|9.1e^^0.4i|b.4j|n.d4|q.l|w.87|z.8d|18',
    '.3v^1.c6|9.4z|d.91|l.d0|x.dk|19.6|1d.b|1h.5n^d.91|m.d0|11.dk|1g.6|1l.b|1q.5n^m.d0|12.dk|1k.6|1q.b^1.',
    'c6|4.91|a.10|g.ca|j.l|m.27|p.bs|s.bu|v.2q^a.10|g.ca|j.l|o.27|t.bs|y.bu|13.2q^1.82|8.l|b.4i|f.6|i.dk|',
    'm.ca|10.34^8.l|b.4i|f.6|i.dk|n.ca|15.34^1.dr|4.8f|9.10|k.1|s.3|x.as|1d.4y^0.27|k.1|w.3|13.as|1r.4y^c',
    '.3d|g.3u|k.b5|s.66|w.2n|10.co|18.cj^0.cl|5.co^1.a3|3.8f|9.9u|c.4j|f.99|i.1h|l.c2|o.4k|u.ao|x.2k|10.5',
    '0|19.39^9.9u|c.4j|f.99|i.1h|l.c2|q.4k|v.a0|10.ao|15.2k|1a.50|1p.39^1.8f|5.a3|f.4k|p.2s|u.10|1e.27|1j',
    '.38^f.4k|t.2s|10.10|1s.27|1z.38^0.bv^1.8f|5.82|f.4i|p.2s|u.5k|1e.8d|1j.38^f.4i|t.2s|10.5k|1s.8d|1z.3',
    '8^0.75^4.bj|w.7a|18.7j^^1.3e|8.91|g.60|s.3m|w.45|14.40|1c.61|1g.3x^^4.3a|8.23|g.9w|o.15|w.50|10.5r|1',
    '8.2q^5.89^1.0|5.m|f.8b|p.a|u.10|14.d4|1e.b|1j.6g^f.8b|r.a|y.10|1c.d4|1q.b|1x.6g^1.0|4.1|c.72|k.4n|s.',
    '7j|14.85^c.72|k.4n|w.7j|1e.85^0.84^1.a3|b.0|h.4j|r.ao|12.4n|1i.ds^h.4j|t.ao|18.4n|1u.ds^1.c6|b.1v|h.',
    '8s|p.1f|z.6g|11.dv|15.8b|1b.8u^0.b|b.1v|h.8s|p.1f|11.6g|15.dv|1b.8b|1j.8u^1.a3|8.m|c.7n|g.1h|k.bs|o.',
    'ao|w.2k|10.38|14.39^0.a0|c.7n|g.1h|k.bs|o.ao|10.2k|16.38|1c.39^4.3u|8.a3|c.80|g.10|o.l|t.4k|10.ao|18',
    '.89^0.8j|c.80|g.10|o.l|v.4k|16.ao|1i.89^1.a3|3.d9|6.1v|9.4k|c.da|i.dv|o.h^9.4k|c.da|i.dv|o.h|14.5o^1',
    '.23|1.a3|5.4k|8.6p|c.a7|m.25|q.l|t.ch|x.1q|14.bh|18.7w^5.4k|8.6p|f.a7|m.25|q.l|u.ch|z.94|13.1q|1c.bh',
    '|1h.7w^1.3e|8.10|c.44|o.3y|s.9h|w.27|10.ca|14.45|1c.89|1g.9j|1k.46^0.3n|5.45^1.d9|6.8h|c.7m|i.1d|u.1',
    '5|10.38|16.5o|1i.2q^i.1d|w.15|14.38|1c.5o|1u.2q^0.37^^0.1v|5.8s|k.8w|u.8y|z.8u|19.4l^5.8s|k.8w|u.8y|',
    'z.8u|19.4l^1.6p|8.9i|c.6q|g.68|o.d7|t.bl|w.36|14.a7|18.37|1c.25|1g.2q^c.6q|g.68|o.d7|v.bl|10.36|1c.a',
    '7|1i.37|1o.25|1u.2q^c.6q|g.68|o.d7|v.bl|10.36|1c.a7|1i.37|1o.25|1u.2q^1.d6|b.dr|n.1|r.68|13.9a|15.8d',
    '|1b.an|1g.8o^o.1|t.68|18.9a|1b.8d|1i.an|1m.8o^0.6d|18.6c^1.8f|1.d9|4.1|8.dr|g.da|o.1d|s.5f|10.8d|14.',
    'bx|18.at|1c.5o^g.da|o.1d|s.5f|14.8d|1a.bx|1g.at|1m.5o^1.c6|a.9u|c.1h|g.9q|i.au|u.9m|y.39|14.2q|16.bi',
    '^a.9u|c.1h|g.9q|i.au|y.9m|14.39|1e.2q|1i.bi^g.9q|i.au|m.1h|y.9m|14.39|1e.2q|1i.bi^1.c6|a.3e|f.43|p.4',
    '4|u.bg|z.40|15.ca|19.61|1e.3x|1j.46^0.av|f.43|p.44|u.bg|z.40|17.ca|1d.61|1k.3x|1r.46^1.c6|6.d9|c.1v|',
    'i.da|l.56|o.dv|u.bx|10.8u^c.1v|i.da|l.56|o.dv|u.bx|10.8u^1.c6|1.cm|c.3d|g.50|k.b5|w.47|10.2n|1g.du^0',
    '.cv|c.3d|g.50|k.b5|y.47|14.2n|1s.du^1.82|a.4j|f.2b|k.6|p.a|u.68|z.3s|14.ao|1e.b|1j.6c|1t.1a^1.82|5.9',
    '1|9.4i|e.8a|j.2r|r.d2|10.34|17.ch^0.cv|c.4i|f.8a|j.2r|q.d2|12.34|1e.ch^1.56|b.5y|h.5w|r.q|v.f|x.1c|1',
    '1.ca|15.2o|17.h|1b.5t^h.5w|r.q|v.f|x.1c|13.ca|19.2o|1d.h|1j.5t^1.8h|7.7n|f.ar|i.7m|t.as|w.at|14.4y^f',
    '.ar|i.7m|t.as|w.at|14.4y^1.c6|1.d9|8.5w|g.df|o.q|w.9b|14.5t|1c.5o^0.5x|5.9b^1.6j|c.81|o.5f|s.7r|w.bs',
    '|10.2c|14.a9^0.ac|c.81|o.5f|u.7r|10.bs|16.2c|1c.a9^c.81|o.5f|u.7r|10.bs|16.2c|1c.a9^1.z|1.9q|1.c6|4.',
    'au|c.2v|k.9o|s.a0|10.an|18.2k|1c.66|1g.bi|1k.2q^1.8h|9.1v|d.56|l.8s|t.dv|11.8u|19.8y|1d.4l^d.56|l.8s',
    '|w.dv|16.8u|1f.8y|1k.4l^1.d9|8.78|c.7m|k.1d|o.bg|t.42|w.9b|10.an|18.24^c.7m|k.1d|o.bg|v.42|10.9b|16.',
    'an|1i.24^1.c6|4.cm|9.b5|b.9u|g.1m|k.c2|m.3d|11.2n|1a.50^9.b5|b.9u|g.1m|k.c2|m.3d|15.2n|1i.50^1.0|f.7',
    '2|k.1v|u.1j|z.4n|14.3m|19.d2|1j.b3^0.bg^1.7n|8.3s|c.56|g.9h|k.49|o.bh|t.16|14.17|18.ch|1c.2q^c.56|g.',
    '9h|k.49|o.bh|v.16|1c.17|1i.ch|1o.2q^0.1b|4.2s|8.6p|g.bs|o.11|s.3u|w.73|10.1q|14.9j|18.5i|1e.t^0.31|4',
    '.6v|8.d3|g.1i|o.3z|o.5v|o.cl|w.74|10.1q^1.6j|6.9u|i.dr|u.bg|10.68|1c.an|1i.8o^1.c6|4.aw|c.1p|g.l|k.a',
    'r|w.as^0.2r|c.1p|g.l|k.ar|w.as^1.c6|5.au|a.1h|f.5k|p.bg|u.9m|z.35|14.ca|19.39|1e.bi|1j.75^0.52|f.5k|',
    'p.bg|u.9m|z.35|14.ca|1b.39|1i.bi|1p.75^1.23|1.2m|1.8h|8.3a|k.49|o.ca|14.2q^1.0|1.z|c.72|g.d6|o.e|s.6',
    '8|w.4n|14.an|1c.8o^1.8h|c.10|g.bg|o.56|s.bs|w.2r|10.27|18.9j|1c.7w^1.d9|a.d0|k.2v|p.1d|z.da|14.2y|19',
    '.5o^k.2v|p.1d|11.da|18.2y|1f.5o^1.82|a.da|f.5k|u.42|z.dc|19.75^f.5k|u.42|11.dc|1f.75^1.c6|4.d9|c.99|',
    'k.c2|o.8s|s.1c|10.8j|14.8u|18.bx|1k.5o^^1.8h|c.1v|s.8s|14.bs|18.2e|1c.8u^1.91|4.4j|8.3s|c.dk|k.2r|o.',
    'ao|10.b|14.ds^c.1v|g.23|s.5v|y.8u|1m.12^c.c2|g.ag|s.cl|y.2n|14.6p|1a.co|1m.cj|1s.4o^c.1p|g.44|s.3z|y',
    '.6b|14.6p|1a.45|1m.3x|1s.5p^1.d5|8.z|c.a7|g.1e|k.bk|o.2r|s.d7|w.ds|10.bl|18.bq|1g.bv^1.c6|a.81|f.l|k',
    '.5k|u.dv|z.96|1e.ch|1j.2q|1o.4o^f.c6|p.42^0.10|4.df|8.5u|c.1c|l.dc|o.27|w.h|14.5o|18.5n|1c.ch|1g.5p^',
    '1.d9|k.5w|u.da|z.1c|14.15|19.5t|1j.5o^^1.23|1.c6|a.91|k.c2|p.10|14.ca|1e.2q^0.d9|a.91|p.da|u.q|14.7o',
    '|1e.5o^0.cm|a.91|p.2s|u.ck|z.87|14.2n|1e.cj^0.3e|a.91|k.aw|p.10|u.3y|z.40|14.6b|1e.46^1.c6|f.cm|k.8s',
    '|14.2n|19.cv|1e.2q|1o.du^1.z|5.9u|f.d9|p.7m|u.e|z.1c|19.9m|1e.bx|1o.5o^0.27|f.d9|p.7m|u.e|z.1c|1d.9m',
    '|1k.bx|1y.5o^1.0|5.a3|f.f|p.7m|u.e|z.1c|19.6g|1e.6m|1o.bi^0.ao|f.f|p.7m|u.e|z.1c|1d.6g|1k.6m|1y.bi^1',
    '.e|1.10|a.dk|k.9o|u.27|z.65|14.ca|19.bi|1j.5p|1o.4o^1.23|1.42|1.49|1.6j|1.c6|g.10|o.27|s.15|w.5d|14.',
    '5h|18.52|1k.4o^1.4z|5.8i|f.5w|p.e|z.4g|19.5t|1j.5n|1t.12^1.82|5.cm|f.8a|p.e|z.34|19.2n|1j.cj|1y.du^1',
    '.4z|5.3e|f.dk|p.e|u.60|z.b|19.5c|1j.5n|1t.7x|1y.al^1.dr|5.d0|f.30|p.an|v.h|z.2z|1j.7w|1o.5p^f.30|p.a',
    'n|x.h|13.2z|1v.7w|22.5p^0.5n|f.30|p.an|x.h|13.2z|15.7w|28.5p^1.1v|1.c2|8.e|g.8w|14.p|1c.8u|20.8z|2g.',
    '4l^1.8h|u.e|2i.p|2s.8u^1.c6|6.9a|k.6x|y.15|16.4n|19.b3^m.6x|14.15|1e.4n|1i.b3^0.85|m.6x|1a.15|1o.4n|',
    '1t.b3^1.c6|a.3e|d.91|j.44|s.43|v.c2|11.6b|14.45|1a.61|1d.9u|1j.2q|1m.7x|1s.3k^a.3e|d.91|k.44|v.c2|z.',
    '43|16.6b|1a.45|1h.61|1l.9u|1s.2q|1w.7x|23.3k^d.91|k.44|v.c2|z.43|17.6b|1c.45|1k.61|1p.9u|22.7x^1.a3|',
    '6.d9|9.10|j.5u|m.42|r.27|u.ao|11.ch|15.h|19.bv|1e.5o^d.10|l.5u|o.42|u.27|y.ao|16.ch|1b.h|1e.bv|1j.5o',
    '^d.10|l.5u|o.42|w.27|11.ao|1f.ch|1n.h|1t.bv|1y.5o^1.a3|7.91|d.4k|p.an|v.bs|16.2q|1b.5r^d.4k|s.an|10.',
    'bs|1e.2q|1k.5r^1.82|3.c6|6.3a|9.1v|i.b|l.3m|o.ca|r.d2|x.7j^9.1v|i.b|n.3m|s.ca|x.d2|17.7j^1.c6|8.c2|f',
    '.6v|m.bo|x.1f|10.b|14.2q^f.6v|o.bo|12.1f|16.b|1b.2q^1.8f|5.0|8.62|f.7r|j.ad|m.4k|q.bs|x.87|10.8u|14.',
    '8d|18.26^8.62|f.7r|j.ad|n.4k|s.bs|z.87|15.8u|1a.8d|1e.26^0.26|f.8b|r.a|y.10|1c.d4|1q.b|1x.6g^1.d9|4.',
    '3d|c.1d|k.b5|s.2n|10.42|14.ca|18.5o^c.1d|k.b5|u.2n|16.42|1c.ca|1i.5o^^^^^0.3p|g.e|w.2q^1.82|5.bj|k.7',
    'r|z.8u|19.4l^0.b|k.7r|15.8u|1j.4l^1.c6|8.cm|i.ca|m.3d|t.8j|w.2n|13.2e|1a.cj^6.cm|k.ca|p.3d|y.8j|12.2',
    'n|1b.2e|1k.cj^0.cl|k.ca|p.3d|z.8j|14.2n|1f.2e|1q.cj^0.84^1.9u|1.c6|1.d9|6.1d|c.an|f.19|j.h|l.89|u.5o',
    '|x.2q|10.bv^6.1d|c.an|f.19|l.h|p.89|14.5o|19.2q|1e.bv^0.an|1.42|1.52|1.9q|1.bi|1.do|k.9r|s.bs|w.9o|1',
    '0.6p|18.2q|1c.55^0.19^1.c6|6.0|8.3p|c.1j|m.72|o.4|t.d1|w.4n|z.19^8.c6|a.3p|f.1j|o.72|s.4|y.d1|11.4n|',
    '15.19^8.c6|a.3p|f.1j|o.72|u.4|13.d1|17.4n|1d.19^1.a3|8.m|i.4k|m.c2|w.2r|10.49^1.c6|7.0|a.72|g.9a|m.4',
    'n|v.b3|y.2q|13.a5^7.0|a.72|g.9a|m.4n|p.1j|s.85|v.b3|y.2q|17.6d|1e.84^1.c6|6.91|e.a|r.d2|u.1e|x.e|17.',
    'dk|1d.d1|1i.b|1l.1f^1.d9|8.7m|g.an|o.h|s.7o|14.39^g.an|s.h|y.7o|1g.39^0.1v|a.91|k.c2|p.8s|14.8u|1e.4',
    'l^0.ay|a.91|p.l|14.2c^1.m|1.82|5.4z|f.dk|l.7r|p.l|14.4f|1e.bs^c.1v|i.da|l.56|u.bx|10.8u^1.1v|a.m|n.5',
    'f|s.8s|11.81|15.a9|1e.8j^1.5g^^1.m|1.c6|5.1v|a.l|e.bg|j.8s|s.2r|w.cz|11.27|1e.8u^1.c6|9.1e|c.ca|h.99',
    '|k.9u|v.81|16.50|19.2q^0.5d|c.ca|h.99|k.9u|w.81|1a.50|1e.2q^1.42|4.7n|8.9u|k.e|o.35|w.5q|14.2z|1c.2q',
    '^1.8f|a.68|d.91|g.4j|j.8g|m.4|r.ao|u.d1|14.ds|19.24^4.au|c.2v|k.9o|s.a0|10.an|18.2k|1c.66|1g.bi|1k.2',
    'q^1.3y|1.5u|1.c6|1.ck|7.10|d.6j|j.56|11.89|17.81|1d.27^7.10|d.6j|j.56|17.89|1f.81|1n.27^1.8f|1.c6|8.',
    'd9|c.3v|o.1c|s.8d|w.87|1c.h^0.1i|c.78|k.2r|o.ao|10.65|14.ds^1.dr|5.9u|a.bo|f.9q|u.1e|14.9o|1o.bi^1.i',
    '|1.c6|5.4i|f.6|k.5k|u.1b|z.87|14.ci|19.ch|1j.75|1o.1q^1.a3|c.91|i.78|o.5y|u.4k|16.w|1o.ao^1.23|1.49|',
    '1.6j|1.a3|8.4k|d.81|m.ao|t.89|15.ch^8.4k|d.81|m.ao|t.89|1c.5h|1k.ch|1s.52^1.aw|6.3e|8.9q|k.1p|m.e|r.',
    '60|t.9o|y.6b|15.15|1c.45|1e.38^k.1p|m.e|r.60|t.9o|y.6b|17.15|1i.45^1.7n|1.c6|5.8i|a.42|f.5w|u.5y|14.',
    'ca|19.39|1e.12^0.5u|f.5w|u.5y|18.ca|1f.39|1m.12|1t.ch^1.c6|5.d9|k.e|p.1d|u.42|14.8j|19.38^1.d9|4.da|',
    'c.8s|g.q|k.1d|s.1j|w.5t|10.5o|18.5p^0.7u|c.8s|g.q|k.1d|u.1j|10.5t|16.5o|1i.5p^1.8q|p.34^1.1j|1.8s|1.',
    'c6|1.d9|1.dk|c.da|o.1d|s.56|w.b|14.19|18.ca|1c.5o^1.82|8.4i|c.78|k.dk|o.ao|s.bd|w.81|10.34|1g.1a^1.3',
    'e|8.aw|g.10|k.60|p.w|s.3y|11.1s|14.4f|18.45|1d.27|1k.61^g.10|k.60|q.w|u.3y|15.1s|19.4f|1e.45|1k.27|1',
    'q.61^k.2v|p.1d|11.da|18.2y|1f.5o|20.dd^1.c6|6.42|a.9u|f.1h|o.an|s.ca|16.2q^0.4i|6.99|a.9u|f.l|j.68|o',
    '.an|u.bh|17.39|1e.4o^f.cm|k.8s|14.2n|19.cv|1j.du|1o.5p^1.c6|7.m|d.bg|l.ca|11.dv|1j.2q^^^0.cy|4.91|8.',
    '50|g.99|o.bs|w.2k|10.1q^^^^1.c6|5.9u|f.bg|p.56|u.dv|14.15|19.89|1j.5h^8.3a|k.49|o.ca|14.2q^1.3n|1.91',
    '|1.cm|6.b5|c.10|u.ck|16.27|1c.3m|1i.2n|20.cj|26.du^1.3e|1.bg|6.44|c.10|u.3y|16.27|1c.3m|1i.6b|20.3x|',
    '26.3k^1.4z|1.d9|6.da|c.10|u.5u|16.27|1c.3m|1i.bx|20.5o|26.12^1.c6|3.9q|6.81|9.10|f.9o|i.bh|o.au|r.27',
    '|v.39|x.bi|10.ch|16.5p^9.10|f.9o|i.bh|o.au|r.27|x.39|11.bi|16.ch|1g.5p^9.10|f.9o|i.bh|o.au|r.27|x.39',
    '|11.bi|16.ch|1g.5p|1n.4o^1.e|1.4z|1.de|10.3m|1i.7|20.5o|29.4l|2i.al^1.e|1.4z|1.de|10.3m|1i.9x|20.3x|',
    '29.4l|2i.al|2r.7x^1.1v|a.6x|u.e|1y.4l|2i.6d^1.8h|3.6f|6.91|9.72|i.l|l.4n|o.an|u.3i|13.6d^9.72|k.l|p.',
    '4n|u.an|14.6c|1j.6d^0.6c|5.72|k.l|p.4n|u.an|1k.6d^1.a3|3.3e|6.91|9.43|i.6|l.ao|o.19|u.45|10.9j|13.46',
    '^0.2s|9.43|k.6|p.ao|u.19|14.11|1e.9j|1j.46^0.11|9.43|k.6|p.ao|u.19|1d.9j|1k.46|1r.1a^1.c6|3.d9|6.9p|',
    '9.9q|i.da|l.9o|o.ca|u.bx|13.5o^0.7m|9.9q|k.da|p.9o|u.ca|14.7o|1j.5o^9.9q|k.da|p.9o|u.ca|16.7o|1r.5o^',
    '1.c6|a.10|m.l|v.27|10.ca|14.bs|18.89^0.ay|o.l|1c.ca|1g.bs|1k.89^1.c6|9.23|c.56|i.87|o.ca|r.49|u.42|1',
    '0.2q^0.ao|9.23|c.56|i.4k|s.ca|x.49|12.42|1c.2q^1.c6|5.8f|f.1e^^0.4z|c.0|k.a|m.72|p.6g|w.4n|z.1f^^0.4',
    'z|c.1v|k.d4|m.8s|p.6g|z.1f^1.m|3.0|6.d9|c.72|g.42|k.1d|s.4n|12.dv|17.3i^c.72|i.4k|o.1d|10.4n|1e.dv|1',
    'l.3i|1s.5o^^1.c6|3.0|6.m|c.9u|f.72|i.81|l.56|u.bs^0.9a|c.9u|i.72|o.81|17.3m|1e.bs|1l.6c^0.6c^1.82|9.',
    '91|d.dk|l.6|x.b|15.1a|19.9j^d.dk|l.6|1l.9j^1.d9|5.91|f.dk|k.da|u.b|19.5n^f.dk|k.da|y.49|1j.5n|1q.5o^',
    '1.2m|6.1v|c.32|i.8s|u.8u|13.4l^c.32|i.8s|12.8u|1h.4l^0.2e|c.32|i.8s|16.8u|1d.7j|1r.4l^1.d9|6.91|h.1d',
    '^h.4z|m.a|w.b|12.4n|18.1f^1.0|1.c6|c.72|f.56|q.4n|10.a5^0.6v|c.72|f.56|j.3u|s.4e|13.1b|18.a5|1e.37^1',
    '.a3|e.56|m.23|p.ci|x.42|12.89^e.4k|n.ao|r.ci|17.9j^n.23|r.ci|13.42|19.49|1g.73|1r.52^1.a3|a.3s|f.7n|',
    'l.0|p.78|u.4k|14.2k^0.4j|n.0|t.1e|10.4k|1e.ao|1s.ds^n.0|t.ad|10.4k|1e.a9|1s.86^1.m|1.8h|5.3a|l.bg|z.',
    'd2|19.5r^0.10|n.bg|17.d2|1l.5r^0.27|n.bg|19.d2|1r.5r|20.18|29.5p^1.c6|7.i|d.4e|j.68|v.a7|14.1q|17.9j',
    '|1a.5d^d.4e|j.68|y.a7|1a.1q|1e.9j|1i.5d|1o.57^^1.c6|a.9q|j.b5|m.9o|p.8j|s.9m|v.2n|11.38|14.bi|17.du^',
    '4.c6|d.2m|g.4k|m.81|v.3o|y.23|14.2q|1a.89^^1.a3|3.m|9.ad|l.7r|o.4k|r.68|x.aa|13.8j|16.dv|19.a9|1c.4f',
    '^1.m|4.3p|c.10|k.bs|s.27|10.65|1c.89^1.c6|4.78|8.9r|g.56|o.9o|s.65|10.ca|18.66|1g.5d|1k.2q^g.56|o.9o',
    '|s.65|14.ca|1g.66|1s.5d|1y.2q^g.56|o.9o|s.65|14.ca|1k.66|20.5d|28.2q^1.1v|f.3u|h.4e|k.8s|p.dv|s.5i|1',
    '3.9j^f.3u|h.4e|k.8s|p.dv|s.5i|1h.t^1.c6|c.91|g.ag|k.10|o.ck|w.2n|14.di|18.cj^c.91|g.ag|k.10|o.ck|10.',
    '2n|1c.di|1i.cj^1.91|7.b5|g.c2|j.3d|v.2n|17.cj^1.91|7.b5|g.c2|j.3d|v.2n|17.cj^1.c6|c.91|f.bo|t.dv|10.',
    '1f|14.89|17.2q|1b.62^1.c6|c.91|f.bo|x.dv|14.1f|17.89|1b.62^0.8f|1.0|5.72|f.6x|u.4n|19.84|1o.85^1.8h|',
    'a.ar|h.3|x.as|1d.4y^0.15|h.3|11.as^1.f|4.8b|g.10|k.5u|w.27|14.6m|18.ca^0.ao|g.10|k.5u|y.27|1a.6m|1g.',
    'ca^6.m|c.d9|i.da|l.5d|o.1c|r.df|u.2o|x.19|10.15|19.5o|1c.db^i.da|l.5d|o.1c|r.df|u.2o|x.19|10.15|1d.5',
    'o|1i.db^1.c6|5.3e|c.1h|f.60|m.6b|q.38|v.ca|14.39|17.45|1b.2q^0.9o|c.1h|f.60|m.6b|q.38|v.ca|1a.39^1.3',
    'e|1.aw|8.99|g.1p|k.44|s.6b|w.15|14.45|1c.5c|1k.61|1s.3k^7.1v|e.8s|t.8j|12.8y|14.81|18.8u|1e.19^q.dv|',
    't.8j|16.8y|1a.81|1g.8u|1o.19^1.c6|e.8s|n.15|s.bs|11.d2|1a.2q|1e.42|1j.ch^1.m|8.10|c.7n|g.a0|k.1h|o.2',
    'k|s.27|10.38|14.39|18.bv^0.2v|c.7n|g.a0|k.30|s.1f|12.38|18.39|1e.d2|1k.2z|1q.18^0.2w|c.7n|g.a0|k.30|',
    's.1f|12.38|18.39|1g.d2|1o.2z|1w.18^1.8f|4.0|g.1j|j.8n|q.81|y.bs|12.87|16.3i^g.1j|j.8n|q.81|z.bs|12.8',
    '7|18.3i^1.82|4.2m|c.4i|g.9w|k.2v|10.ca|14.7j^0.2y|c.4i|g.9w|k.2v|12.ca|18.7j|1k.al^1.a3|5.91|8.4j|c.',
    '78|j.ao|m.8n|q.28|t.3s|14.ds|1e.1q^1.dr|4.10|6.6j|9.8g|b.3u|l.8b|o.d4|v.8d|13.27|1a.as^1.1v|1.7j|1.9',
    'q|1.c6|f.9o|k.8y|u.8u|z.bi|14.4l^1.1v|1.46|1.9q|1.c6|f.9o|k.dv|u.8u|z.bi|14.b3^1.7n|1.d9|c.da|o.h|v.',
    '7o|10.39|16.4l^0.ch|c.da|o.h|x.7o|14.39|1c.4l^1.d9|c.1d|g.68|k.2r|s.7s|w.9b|14.27|18.24^0.c2|c.1d|g.',
    '68|k.2r|s.7s|y.9b|1a.27|1g.24^1.7n|3.99|6.1v|9.9r|f.8s|i.e|r.3m|u.38^0.5p|9.9r|f.8s|i.e|r.3m|u.38^1.',
    'm|1.dr|4.1|g.e|k.72|o.1c|10.4n|18.3i^g.e|k.72|o.1c|10.4n|1c.3i^1.4j|4.d9|8.au|c.78|g.e|k.1e|o.1c|s.a',
    'o|w.28|10.9m|18.ds^c.78|g.e|k.1e|o.1c|s.ao|w.28|10.9m|1c.ds^f.c6|p.42^0.da|4.2m|8.d0|o.30|w.h|14.bx|',
    '1g.5o^1.c6|a.3e|a.8i|a.d9|f.56|p.de|z.12|z.3x|z.5o|19.5n^1.m|1.6j|1.a3|1.cg|4.z|7.ad|a.3u|d.4k|i.8s|',
    'l.e|p.ao|x.aa|1a.bs|1e.4f^1.m|7.7r|j.ad|m.5f|u.a9|12.bs|1c.86^0.68|j.ad|m.5f|u.a9|14.bs|1h.86^1.m|8.',
    'ad|g.7r|k.81|w.5f|14.a9|18.4l^0.ac|g.7r|k.81|w.5f|16.a9|1c.4l^1.4z|1.6d|1.9a|a.bg|g.6x|10.b|15.15|1a',
    '.7w|1k.b3^1.m|1.1v|1.dr|g.bj|j.ca|m.3m|w.d2|16.2q^1.91|a.68|p.ao|u.7s|14.bs|1e.4l^^1.m|1.56|1.8i|f.5',
    'w|p.5y|u.4h|z.10|14.5u|1e.de|1j.27|1o.12^0.4g|f.5w|p.5y|u.4h|z.10|14.5u|1i.de|1p.27|1w.12^1.9u|8.d9|',
    'c.8i|o.1c|s.q|10.15|14.bx|18.12^c.8i|o.1c|s.q|14.15|1a.bx|1g.12^c.8i|o.1c|s.q|14.15|1c.bx|1k.12^1.d9',
    '|1.df^e.da|g.5u|j.1c|n.bs|q.2o|y.27|13.h|1e.5o^b.32|e.da|q.2o|y.8u|13.h|1e.5o^1.c6|5.d9|a.e|k.2o|p.c',
    'a|u.h|14.42|19.5o|1e.2q|1j.55^1.c6|4.d9|h.da|m.32|q.42|y.ca|1a.5o^1.3e|5.10|a.2v|f.56|p.27|v.2w|z.dv',
    '|19.45|1e.7w|1j.2q^f.56|p.27|x.2w|13.dv|1h.45|1o.7w|1v.2q^0.4a|f.56|p.27|x.2w|13.dv|1j.45|21.2q^1.c6',
    '^0.1v|0.78|6.dv|i.47|q.ca|y.8u|1e.7a|22.5p^0.52|6.dv|g.47|q.ca|y.8u|1g.7a|2a.5p^1.1m|1.9q|6.1h|c.e|i',
    '.bg|o.9o|16.52|1c.bi|1i.bv|1u.du|20.5p^1.1m|1.5y|6.1h|c.e|i.bg|o.5t|16.52|1c.12|1i.bv|1u.du|20.5p^1.',
    '1m|1.78|6.1h|c.e|i.bg|o.47|o.65|16.52|1c.5d|1i.bv|1u.du|20.5p^1.bj|f.1v|p.2v|z.7i|14.dv|19.2y|1o.8u^',
    '1.bj|f.1v|p.2v|z.6u|14.dv|19.2y|1o.8u^1.e|1.15|1.7v|1.da|9.h|r.7o|10.5t|20.5o|29.2q|2i.db^1.e|1.6b|1',
    '.7m|1.8p|9.38|r.39|10.52|20.3x|29.b3|2i.3k^1.b|1.e|1.2u|1.d0|9.27|r.3n|10.2y|19.5r|1r.4a|20.5n|29.7w',
    '|2i.5p^1.1v|7.c2|s.dv|16.8u|1d.7a|1y.4l|25.2q|2q.2p^1.dr|7.7r|j.68|p.8y|v.8u|1d.dv|1v.8v|21.5p^1.c6|',
    '9.0|d.9a|l.10|p.72|11.27|15.4n|19.6d^d.9a|m.10|r.72|16.27|1b.4n|1g.6d^0.39|m.10|r.72|19.27|1f.4n|1l.',
    '6d|1r.57^1.a3|7.3e|f.4k|h.44|v.3o|x.40|13.4|1b.45^0.6v|g.4k|j.44|q.3u|10.1q|13.40|1a.4|1k.46^0.1q|g.',
    '4k|j.44|q.3u|16.40|1b.46|1g.4|1t.97^1.8h|8.d9|f.82|i.1d|p.4i|t.1c|w.df|13.34|17.5o^0.78|f.82|j.1d|s.',
    '4i|x.1c|11.df|1a.34|1e.5o^0.f|f.82|j.1d|s.4i|x.1c|13.df|1g.34|1n.5o|1u.dd^1.c6|5.91|9.dk|p.6|t.ca|11',
    '.1a^9.dk|s.6|x.ca|17.1a^0.1q|s.6|x.ca|1d.1a^1.c6|9.9u|d.56|p.27|t.ca|x.bu|19.bv^0.d9|9.9u|d.56|s.27|',
    'x.ca|12.bu|1h.bv^1.c6|6.bo|g.1e^0.4j|e.0|q.ao|u.ds|10.3v|16.7s|1a.1f^1.c6|4.cm|c.10|g.b5|o.d8|10.27|',
    '14.2n|1c.di^c.10|i.b5|v.d8|1c.27|1i.2n|1w.di^c.10|i.b5|x.d8|1k.27|1s.2n|28.di^^^1.56|a.9p|f.ca|o.l|s',
    '.an|x.e|11.dv|1a.55^a.9p|f.ca|o.l|s.an|10.e|17.dv|1m.55^1.c6|f.ca|s.e|16.65|1a.5d^f.ca|s.e|1f.65|1m.',
    '5d^a.c6|f.1e^n.1v|q.9a|w.8s|z.62|12.42|18.8u|1b.6d|1e.1f^n.1v|q.4z|w.8s|12.bo|15.b|18.8u|1b.6t|1e.1f',
    '^1.1e|1.4z|1.bo^0.ao|4.4j|c.3v|g.4k|s.b|w.8j|14.n^1.cm|5.91|d.b5|j.7t|l.c2|p.3d|11.bu|15.2n|1d.cj^1.',
    'c6|b.91|f.d9|i.10|l.c2|o.f|r.2r|v.df|z.6m|12.h|19.5o|1d.dd^f.d9|i.10|l.c2|o.f|t.2r|z.df|15.6m|1a.h|1',
    'l.5o|1q.dd^1.c6|5.6f|k.6x|u.ca|z.84|19.b3^k.6x|y.ca|15.84|1j.b3|1q.85^1.7n|1.d9|f.da|k.e|p.15|v.7o|z',
    '.38^f.da|k.e|p.15|x.7o|13.38^i.4k|m.c2|w.2r|10.49^1.m|4.4z|c.81|g.5f|k.a9^0.86|c.81|g.5f|k.a9^1.8h|g',
    '.91|k.2s|w.56|1c.19^g.91|k.2s|w.56|1c.19|1k.5i^^19.4f|1j.2c|1t.1s^5.a3|h.6|k.4k|w.9h|11.ao|15.bs|1e.',
    '89^h.6|k.4k|w.9h|11.ao|19.15^^1.a3|3.3u|9.3|c.4k|i.10|l.d4|u.bs|10.7s^0.45|c.4k|i.10|l.d4|u.bs|12.7s',
    '^1.1v|1.c6|8.81|g.50|s.3m|w.5d|18.4l^g.50|s.3m|w.5d|1e.4l^^^^1.1o|1.5r|5.82|h.4i|t.9w|11.3a|19.d2^1.',
    '7r|5.ad|f.81|p.5f|z.bs|19.a9|1e.2c^1.a0|1.c6|c.2v|i.1h|p.10|u.ao|10.2w|16.2k|1i.ca|1o.2z^i.1h|r.10|y',
    '.ao|16.2w|1e.2k|1u.ca|22.2z^0.27|i.1h|r.10|y.ao|16.2w|1g.2k|20.ca|2a.2z^^^0.p|k.4e|10.16|1c.7a|1g.2y',
    '|1k.3n|1o.1q^1.c6|4.10|c.a0|g.2k|k.27|s.ca|14.39|18.2q^c.a0|g.2k|k.27|s.ca|18.39|1e.2q^1.8f|6.3v|9.8',
    'b|c.10|i.1e|l.d4|o.68|u.87|10.7s|13.26|16.ds|1c.27^9.8b|c.10|i.1e|l.d4|o.68|u.87|10.7s|13.26|18.ds|1',
    'i.27^1.7n|1.8f|4.m|g.6p|k.d4|o.bs|w.8d|18.as^g.6p|k.d4|o.bs|w.8d|1c.as^1.z|7.10|b.d6|r.4q|v.6e|15.27',
    '|1b.a5|1e.8o^1.8h|6.d9|h.4z|m.da|12.df|16.d1|19.19^m.da|16.df|1c.d1|1h.19^^1.8i|5.6f|f.5w|k.9a|p.5y|',
    '15.do|19.12^0.5v|f.5w|k.9a|p.5y|17.do|1d.12^i.78|o.5y|u.4k|16.49|1o.7s|1u.2c^c.3d|g.50|k.b5|y.47|14.',
    '2n|1s.du^i.dr|u.bg|10.68|1c.an|1i.8o^f.5k|p.bg|u.9m|z.35|14.ca|1b.39|1i.bi|1p.75|23.9s^c.72|g.d6|o.e',
    '|s.68|w.4n|14.an|1c.8o^c.c2|g.ag|s.cl|y.2n|14.6p|1a.co|1m.cj|1s.4o^c.1p|g.44|s.3z|y.6b|14.6p|1a.45|1',
    'm.3x|1s.5p^0.b^e.91|r.d2|u.1e|x.e|12.3u|17.ao|1d.d1^0.9a|a.91|p.6x|14.4n|1e.6c^0.5y|a.91|k.5w|p.10|u',
    '.5u|14.4g|1e.12^d.91|g.4j|j.68|m.4|r.7s|u.d1|14.ds|19.24^0.2r|f.5w|u.5y|18.ca|1f.39|1m.12|1t.ch^1.c6',
    '|f.cm|k.8s|14.2n|19.cv|1e.2q|1o.du|1t.5p^0.ao|c.3u|i.6|n.3s|16.8w|1r.1q^0.cv|j.b5|m.9o|p.8j|s.9m|v.2',
    'n|11.38|14.bi|17.du^g.7r|k.81|w.5f|16.a9|1c.4l^0.5f|f.5w|k.32|p.5y|u.4h|1p.a9|1w.12^1.m|5.cm|k.3d|u.',
    'ag|z.5f|1e.2n|1j.d2^1.1v|7.c2|l.8s|z.3m|1d.8u|1r.4l|1y.42|2c.7p^1.1v|7.c2|l.8s|z.3m|1d.8u|1r.4l|2c.7',
    'p^1.1v|7.c2|l.8s|z.3m|1d.8u|1k.d2|1r.4l|2c.7p^1.78|8.2v|g.e|o.ao|w.47|14.2w|1c.p|1k.8j|20.38|28.66|2',
    'g.9l^1.da|8.2v|g.e|o.ao|1c.p|1k.8j|1s.h|20.38|28.b4|2g.5o^1.40|6.78|c.e|i.3y|u.65|10.27|16.6b|1i.38|',
    '1o.5c|1u.bi|20.6y^1.8h|6.81|c.3o|i.bg|u.68|10.74|16.14|1i.dv|1o.5d|1u.52|20.4o|26.29^1.ad|7.2v|e.e|l',
    '.5f|s.ao|16.aa|1k.p|1r.2w|1y.38|25.ab^1.1v|c.q|i.8s|u.ao|10.8w|1i.8u|1o.7j|1u.4l^1.d9|o.1d|13.df|1a.',
    'da|1p.2o^1.d9|o.1d|13.df|1a.da|1p.2o^b.91|t.bs|12.7r|2l.2c^a.6x|1a.89|21.3i|2s.a6^1.a7|k.38|u.5r|14.',
    '3n|1o.4l|28.5p|2s.67',
  ].join('');
  const TA_NAME_RAW = [
    '妙蛙种子,妙蛙草,妙蛙花,小火龙,火恐龙,喷火龙,杰尼龟,卡咪龟,水箭龟,绿毛虫,铁甲蛹,巴大蝶,独角虫,铁壳蛹,大针蜂,波波,比比鸟,大比鸟,小拉达,拉达,烈雀,大嘴雀,阿柏蛇,阿柏怪,皮卡丘,雷丘',
    ',穿山鼠,穿山王,尼多兰,尼多娜,尼多后,尼多朗,尼多力诺,尼多王,皮皮,皮可西,六尾,九尾,胖丁,胖可丁,超音蝠,大嘴蝠,走路草,臭臭花,霸王花,派拉斯,派拉斯特,毛球,摩鲁蛾,地鼠,三地鼠,喵喵,',
    '猫老大,可达鸭,哥达鸭,猴怪,火暴猴,卡蒂狗,风速狗,蚊香蝌蚪,蚊香君,蚊香泳士,凯西,勇基拉,胡地,腕力,豪力,怪力,喇叭芽,口呆花,大食花,玛瑙水母,毒刺水母,小拳石,隆隆石,隆隆岩,小火马,烈焰',
    '马,呆呆兽,呆壳兽,小磁怪,三合一磁怪,大葱鸭,嘟嘟,嘟嘟利,小海狮,白海狮,臭泥,臭臭泥,大舌贝,刺甲贝,鬼斯,鬼斯通,耿鬼,大岩蛇,催眠貘,引梦貘人,大钳蟹,巨钳蟹,霹雳电球,顽皮雷弹,蛋蛋,椰蛋',
    '树,卡拉卡拉,嘎啦嘎啦,飞腿郎,快拳郎,大舌头,瓦斯弹,双弹瓦斯,独角犀牛,钻角犀兽,吉利蛋,蔓藤怪,袋兽,墨海马,海刺龙,角金鱼,金鱼王,海星星,宝石海星,魔墙人偶,飞天螳螂,迷唇姐,电击兽,鸭嘴火',
    '兽,凯罗斯,肯泰罗,鲤鱼王,暴鲤龙,拉普拉斯,百变怪,伊布,水伊布,雷伊布,火伊布,多边兽,菊石兽,多刺菊石兽,化石盔,镰刀盔,化石翼龙,卡比兽,急冻鸟,闪电鸟,火焰鸟,迷你龙,哈克龙,快龙,超梦,梦',
    '幻,菊草叶,月桂叶,大竺葵,火球鼠,火岩鼠,火暴兽,小锯鳄,蓝鳄,大力鳄,尾立,大尾立,咕咕,猫头夜鹰,芭瓢虫,安瓢虫,圆丝蛛,阿利多斯,叉字蝠,灯笼鱼,电灯怪,皮丘,皮宝宝,宝宝丁,波克比,波克基古',
    ',天然雀,天然鸟,咩利羊,茸茸羊,电龙,美丽花,玛力露,玛力露丽,树才怪,蚊香蛙皇,毽子草,毽子花,毽子棉,长尾怪手,向日种子,向日花怪,蜻蜻蜓,乌波,沼王,太阳伊布,月亮伊布,黑暗鸦,呆呆王,梦妖,',
    '未知图腾,果然翁,麒麟奇,榛果球,佛烈托斯,土龙弟弟,天蝎,大钢蛇,布鲁,布鲁皇,千针鱼,巨钳螳螂,壶壶,赫拉克罗斯,狃拉,熊宝宝,圈圈熊,熔岩虫,熔岩蜗牛,小山猪,长毛猪,太阳珊瑚,铁炮鱼,章鱼桶,',
    '信使鸟,巨翅飞鱼,盔甲鸟,戴鲁比,黑鲁加,刺龙王,小小象,顿甲,多边兽２型,惊角鹿,图图犬,无畏小子,战舞郎,迷唇娃,电击怪,鸭嘴宝宝,大奶罐,幸福蛋,雷公,炎帝,水君,幼基拉斯,沙基拉斯,班基拉斯,',
    '洛奇亚,凤王,时拉比,木守宫,森林蜥蜴,蜥蜴王,火稚鸡,力壮鸡,火焰鸡,水跃鱼,沼跃鱼,巨沼怪,土狼犬,大狼犬,蛇纹熊,直冲熊,刺尾虫,甲壳茧,狩猎凤蝶,盾甲茧,毒粉蛾,莲叶童子,莲帽小童,乐天河童,',
    '橡实果,长鼻叶,狡猾天狗,傲骨燕,大王燕,长翅鸥,大嘴鸥,拉鲁拉丝,奇鲁莉安,沙奈朵,溜溜糖球,雨翅蛾,蘑蘑菇,斗笠菇,懒人獭,过动猿,请假王,土居忍士,铁面忍者,脱壳忍者,咕妞妞,吼爆弹,爆音怪,幕',
    '下力士,铁掌力士,露力丽,朝北鼻,向尾喵,优雅猫,勾魂眼,大嘴娃,可可多拉,可多拉,波士可多拉,玛沙那,恰雷姆,落雷兽,雷电兽,正电拍拍,負电拍拍,电萤虫,甜甜萤,毒蔷薇,溶食兽,吞食兽,利牙鱼,巨牙',
    '鲨,吼吼鲸,吼鲸王,呆火驼,喷火驼,煤炭龟,跳跳猪,噗噗猪,晃晃斑,大颚蚁,超音波幼虫,沙漠蜻蜓,刺球仙人掌,梦歌仙人掌,青绵鸟,七夕青鸟,猫鼬斩,饭匙蛇,月石,太阳岩,泥泥鳅,鲶鱼王,龙虾小兵,铁螯',
    '龙虾,天秤偶,念力土偶,触手百合,摇篮百合,太古羽虫,太古盔甲,丑丑鱼,美纳斯,飘浮泡泡,变隐龙,怨影娃娃,诅咒娃娃,夜巡灵,彷徨夜灵,热带龙,风铃铃,阿勃梭鲁,小果然,雪童子,冰鬼护,海豹球,海魔狮',
    ',帝牙海狮,珍珠贝,猎斑鱼,樱花鱼,古空棘鱼,爱心鱼,宝贝龙,甲壳龙,暴飞龙,铁哑铃,金属怪,巨金怪,雷吉洛克,雷吉艾斯,雷吉斯奇鲁,拉帝亚斯,拉帝欧斯,盖欧卡,固拉多,烈空坐,基拉祈,代欧奇希斯,草',
    '苗龟,树林龟,土台龟,小火焰猴,猛火猴,烈焰猴,波加曼,波皇子,帝王拿波,姆克儿,姆克鸟,姆克鹰,大牙狸,大尾狸,圆法师,音箱蟀,小猫怪,勒克猫,伦琴猫,含羞苞,罗丝雷朵,头盖龙,战槌龙,盾甲龙,护城',
    '龙,结草儿,结草贵妇,绅士蛾,三蜜蜂,蜂女王,帕奇利兹,泳圈鼬,浮潜鼬,樱花宝,樱花儿,无壳海兔,海兔兽,双尾怪手,飘飘球,随风球,卷卷耳,长耳兔,梦妖魔,乌鸦头头,魅力喵,东施喵,铃铛响,臭鼬噗,坦',
    '克臭鼬,铜镜怪,青铜钟,盆才怪,魔尼尼,小福蛋,聒噪鸟,花岩怪,圆陆鲨,尖牙陆鲨,烈咬陆鲨,小卡比兽,利欧路,路卡利欧,沙河马,河马兽,钳尾蝎,龙王蝎,不良蛙,毒骷蛙,尖牙笼,荧光鱼,霓虹鱼,小球飞鱼',
    ',雪笠怪,暴雪王,玛狃拉,自爆磁怪,大舌舔,超甲狂犀,巨蔓藤,电击魔兽,鸭嘴炎兽,波克基斯,远古巨蜓,叶伊布,冰伊布,天蝎王,象牙猪,多边兽乙型,艾路雷朵,大朝北鼻,黑夜魔灵,雪妖女,洛托姆,由克希,',
    '艾姆利多,亚克诺姆,帝牙卢卡,帕路奇亚,席多蓝恩,雷吉奇卡斯,骑拉帝纳,克雷色利亚,霏欧纳,玛纳霏,达克莱伊,谢米,阿尔宙斯',
  ].join('');
  const TA_GYMS = [{"L":"Pierre","T":"rock","B":"Roche","team":[[74,14],[95,15]],"lv":[14,15]},{"L":"Ondine","T":"water","B":"Cascade","team":[[120,18],[54,19],[121,21]],"lv":[18,21]},{"L":"Major Bob","T":"electric","B":"Foudre","team":[[100,21],[25,18],[82,22],[26,24]],"lv":[18,24]},{"L":"Erika","T":"grass","B":"Prisme","team":[[114,24],[47,27],[103,26],[71,29],[45,29]],"lv":[24,29]},{"L":"Koga","T":"poison","B":"Âme","team":[[109,37],[42,38],[89,39],[49,38],[109,37],[110,43]],"lv":[37,43]},{"L":"Morgane","T":"psychic","B":"Marais","team":[[64,38],[122,37],[97,38],[121,38],[49,38],[65,43]],"lv":[37,43]},{"L":"Auguste","T":"fire","B":"Volcan","team":[[58,42],[77,40],[126,43],[38,42],[78,42],[59,47]],"lv":[40,47]},{"L":"Giovanni","T":"ground","B":"Terre","team":[[111,45],[51,42],[53,44],[31,44],[34,45],[112,50]],"lv":[42,50]},{"L":"Blue","T":"normal","B":"null","team":[[18,47],[65,47],[112,45],[103,45],[59,45],[9,53]],"lv":[45,53]},{"L":"Olga","T":"ice","B":"null","team":[[87,54],[91,53],[73,55],[80,54],[124,56],[131,56]],"lv":[53,56]},{"L":"Aldo","T":"fighting","B":"null","team":[[95,53],[107,55],[57,56],[106,55],[95,56],[68,58]],"lv":[53,58]},{"L":"Agatha","T":"ghost","B":"null","team":[[94,56],[42,56],[110,56],[93,55],[24,58],[94,60]],"lv":[55,60]},{"L":"Peter","T":"dragon","B":"null","team":[[130,58],[148,56],[117,58],[148,56],[142,60],[149,62]],"lv":[56,62]},{"L":"Blue","T":"normal","B":"Maître","team":[[18,59],[65,57],[112,59],[103,61],[59,61],[9,65]],"lv":[57,65]},{"L":"Albert","T":"flying","B":"Zéphyr","team":[[16,7],[17,9]],"lv":[7,9]},{"L":"Hector","T":"bug","B":"Essaim","team":[[11,14],[14,14],[123,16]],"lv":[14,16]},{"L":"Blanche","T":"normal","B":"Plaine","team":[[35,18],[162,18],[203,19],[241,20]],"lv":[18,20]},{"L":"Mortimer","T":"ghost","B":"Brume","team":[[92,21],[93,21],[200,22],[93,23],[94,25]],"lv":[21,25]},{"L":"Chuck","T":"fighting","B":"Choc","team":[[57,27],[67,27],[237,28],[106,28],[107,28],[62,30]],"lv":[27,30]},{"L":"Jasmine","T":"steel","B":"Minéral","team":[[81,30],[81,30],[227,32],[205,32],[82,33],[208,35]],"lv":[30,35]},{"L":"Frédo","T":"ice","B":"Glacier","team":[[86,27],[87,29],[215,29],[124,29],[91,30],[221,31]],"lv":[27,31]},{"L":"Admin Rocket","T":"dark","B":"null","team":[[228,38],[109,38],[24,39],[110,40],[42,41],[229,42]],"lv":[38,42]},{"L":"Sandra","T":"dragon","B":"Lever","team":[[130,37],[148,37],[148,37],[148,37],[117,38],[230,40]],"lv":[37,40]},{"L":"Silver","T":"dark","B":"null","team":[[215,34],[169,36],[82,35],[94,35],[65,35],[160,38]],"lv":[34,38]},{"L":"Clément","T":"psychic","B":"null","team":[[178,40],[203,41],[124,41],[103,41],[80,41],[178,42]],"lv":[40,42]},{"L":"Koga","T":"poison","B":"null","team":[[168,40],[49,41],[73,42],[205,43],[89,42],[169,44]],"lv":[40,44]},{"L":"Aldo","T":"fighting","B":"null","team":[[237,42],[106,42],[107,42],[95,43],[214,43],[68,46]],"lv":[42,46]},{"L":"Marion","T":"dark","B":"null","team":[[197,42],[45,42],[215,43],[198,44],[94,45],[229,47]],"lv":[42,47]},{"L":"Peter","T":"dragon","B":"Maître Johto","team":[[130,44],[149,47],[149,47],[142,46],[6,46],[149,50]],"lv":[44,50]},{"L":"Red","T":"normal","B":"Légende","team":[[25,100],[196,100],[143,100],[3,100],[6,100],[9,100]],"lv":[100,100]},{"L":"Roxanne","T":"rock","B":"Roche (Hoenn)","team":[[74,12],[299,15]],"lv":[12,15]},{"L":"Bastien","T":"fighting","B":"Poing","team":[[66,16],[307,16],[296,19]],"lv":[16,19]},{"L":"Voltère","T":"electric","B":"Dynamo","team":[[100,20],[309,20],[82,22],[310,24]],"lv":[20,24]},{"L":"Adriane","T":"fire","B":"Chaleur","team":[[322,24],[218,24],[323,26],[219,27],[324,29]],"lv":[24,29]},{"L":"Chef Max","T":"fire","B":"null","team":[[262,24],[42,24],[323,25]],"lv":[24,25]},{"L":"Norman","T":"normal","B":"Balance","team":[[327,27],[288,27],[335,28],[277,28],[264,29],[289,31]],"lv":[27,31]},{"L":"Alizée","T":"flying","B":"Plume","team":[[333,29],[357,29],[279,30],[227,31],[277,31],[334,33]],"lv":[29,33]},{"L":"Admin Aqua","T":"water","B":"null","team":[[262,34],[42,34],[319,36]],"lv":[34,36]},{"L":"Lévy et Tatia","T":"psychic","B":"Esprit","team":[[344,41],[178,41],[337,42],[338,42],[358,41],[282,42]],"lv":[41,42]},{"L":"Chef Arthur","T":"water","B":"null","team":[[262,41],[169,41],[319,43]],"lv":[41,43]},{"L":"Juan","T":"water","B":"Pluie","team":[[370,41],[340,41],[364,43],[342,43],[350,44],[230,46]],"lv":[41,46]},{"L":"Timmy","T":"psychic","B":"null","team":[[334,44],[301,43],[315,44],[82,41],[282,45]],"lv":[41,45]},{"L":"Damien","T":"dark","B":"null","team":[[262,46],[275,48],[332,46],[342,48],[302,47],[359,49]],"lv":[46,49]},{"L":"Spectra","T":"ghost","B":"null","team":[[356,48],[354,49],[302,50],[355,48],[354,49],[356,51]],"lv":[48,51]},{"L":"Glacia","T":"ice","B":"null","team":[[364,50],[362,50],[364,52],[362,52],[365,51],[365,53]],"lv":[50,53]},{"L":"Aragon","T":"dragon","B":"null","team":[[372,52],[334,54],[330,53],[230,53],[330,53],[373,55]],"lv":[52,55]},{"L":"Pierre Rochard","T":"steel","B":"Maître Hoenn","team":[[227,57],[344,55],[306,56],[346,56],[348,56],[376,58]],"lv":[55,58]},{"L":"Pierrick","T":"rock","B":"Charbon","team":[[74,12],[95,12],[408,14]],"lv":[12,14]},{"L":"Flo","T":"grass","B":"Forêt","team":[[420,19],[387,19],[407,22]],"lv":[19,22]},{"L":"Kiméra","T":"ghost","B":"Fantôme","team":[[355,24],[93,24],[429,26]],"lv":[24,26]},{"L":"Mélina","T":"fighting","B":"Pavé","team":[[307,28],[67,29],[448,32]],"lv":[28,32]},{"L":"Lovis","T":"water","B":"Palustre","team":[[130,33],[195,34],[419,37]],"lv":[33,37]},{"L":"Charles","T":"steel","B":"Mine","team":[[82,37],[208,38],[411,41]],"lv":[37,41]},{"L":"Mars","T":"poison","B":"null","team":[[42,37],[436,37],[432,39]],"lv":[37,39]},{"L":"Gladys","T":"ice","B":"Glaçon","team":[[215,40],[221,40],[460,42],[478,44]],"lv":[40,44]},{"L":"Saturne","T":"poison","B":"null","team":[[64,38],[436,38],[454,40]],"lv":[38,40]},{"L":"Hélio","T":"dark","B":"null","team":[[229,45],[430,48],[169,46],[130,46],[461,47]],"lv":[45,48]},{"L":"Tanguy","T":"electric","B":"Phare","team":[[135,46],[26,46],[405,48],[466,50]],"lv":[46,50]},{"L":"Louka","T":"normal","B":"null","team":[[398,48],[419,47],[407,48],[143,51],[214,49],[392,53]],"lv":[47,53]},{"L":"Aaron","T":"bug","B":"null","team":[[269,53],[267,53],[416,54],[214,54],[452,57]],"lv":[53,57]},{"L":"Terry","T":"ground","B":"null","team":[[340,55],[472,56],[76,56],[464,57],[450,59]],"lv":[55,59]},{"L":"Adrien","T":"fire","B":"null","team":[[229,58],[136,57],[78,58],[392,61],[467,57]],"lv":[57,61]},{"L":"Lucio","T":"psychic","B":"null","team":[[122,59],[203,59],[308,60],[65,60],[437,63]],"lv":[59,63]},{"L":"Cynthia","T":"dragon","B":"Maître Sinnoh","team":[[442,91],[407,92],[468,93],[448,93],[350,94],[445,95]],"lv":[91,95]},{"L":"Pluton","T":"electric","B":"null","team":[[101,63],[437,63],[435,63],[454,64],[462,65],[479,66]],"lv":[63,66]}];

  /* ====================== 模块：队伍分析与配队推荐 ====================== */
  /* 数据表来自游戏 bundle（app.js）的 POKEDEX / MOVES / TYPE_CHART / CHAPTERS，
     公式逐条复现战斗核心：V() 伤害、ka() 选招、Ft() 属性倍率、movePower/moveAcc。 */

  const TA_TYPES = ['normal', 'fire', 'water', 'electric', 'grass', 'ice', 'fighting', 'poison',
    'ground', 'flying', 'psychic', 'bug', 'rock', 'ghost', 'dragon', 'dark', 'steel', 'fairy'];
  const TA_TYPE_CN = {
    normal: '一般', fire: '火', water: '水', electric: '电', grass: '草', ice: '冰',
    fighting: '格斗', poison: '毒', ground: '地面', flying: '飞行', psychic: '超能', bug: '虫',
    rock: '岩石', ghost: '幽灵', dragon: '龙', dark: '恶', steel: '钢', fairy: '妖精',
  };
  const TA_TI = Object.fromEntries(TA_TYPES.map((t, i) => [t, i]));
  const TA_TC = '0123456789abcdefgh';
  const TA_ACC = [40, 150, 80];   // 游戏 ACC_CURVE：威力 40 → 100%，150 → 80%

  const TA_CHART = (() => {
    const out = TA_TYPES.map(() => new Array(18).fill(1));
    for (let a = 0; a < 18; a++) {
      for (let d = 0; d < 18; d++) {
        const c = TA_CHART_RAW[a * 18 + d];
        out[a][d] = c === '0' ? 0 : c === '1' ? 0.5 : c === '2' ? 1 : 2;
      }
    }
    return out;
  })();

  const TA_DEX = (() => {
    const out = {};
    const rows = TA_DEX_RAW.split(',');
    for (let i = 0; i < rows.length; i++) {
      out[i + 1] = [...rows[i]].map((c) => TA_TC.indexOf(c)).filter((x) => x >= 0);
    }
    return out;
  })();

  const TA_MVNAME_RAW = [
    'absorb:吸取|acid:溶解液|acid-armor:溶化|acid-spray:酸液炸弹|acrobatics:杂技|acupressure:点穴|aerial-ace:燕返|aeroblas',
    't:气旋攻击|after-you:您先请|agility:高速移动|air-cutter:空气利刃|air-slash:空气斩|ally-switch:交换场地|amnesia:瞬间失忆|ancien',
    't-power:原始之力|aqua-jet:水流喷射|aqua-ring:水流环|aqua-tail:水流尾|arm-thrust:猛推|aromatherapy:芳香治疗|aromatic-mist',
    ':芳香薄雾|assurance:恶意追击|astonish:惊吓|attack-order:攻击指令|attract:迷人|aura-sphere:波导弹|aurora-beam:极光束|aurora',
    '-veil:极光幕|autotomize:身体轻量化|axe-kick:下压踢|baby-doll-eyes:圆瞳|baton-pass:接棒|beat-up:围攻|belch:打嗝|belly-dr',
    'um:腹鼓|bind:绑紧|bite:咬住|blaze-kick:火焰踢|blizzard:暴风雪|block:挡路|body-press:扑击|body-slam:泰山压顶|bone-rush:骨棒',
    '乱打|bonemerang:骨头回力镖|boomburst:爆音波|bounce:弹跳|brave-bird:勇鸟猛攻|brick-break:劈瓦|brine:盐水|bubble-beam:泡沫光线',
    '|bug-bite:虫咬|bug-buzz:虫鸣|bulk-up:健美|bulldoze:重踏|bullet-punch:子弹拳|bullet-seed:种子机关枪|calm-mind:冥想|char',
    'ge:充电|charge-beam:充电光束|charm:撒娇|chatter:喋喋不休|clear-smog:清除之烟|close-combat:近身战|coil:盘蜷|comeuppance:复仇',
    '|confide:密语|confuse-ray:奇异之光|confusion:念力|conversion:纹理|conversion-2:纹理２|copycat:仿效|cosmic-power:宇宙力',
    '量|cotton-guard:棉花防守|cotton-spore:棉孢子|counter:双倍奉还|covet:渴望|crabhammer:蟹钳锤|cross-chop:十字劈|cross-poiso',
    'n:十字毒刃|crunch:咬碎|crush-claw:撕裂爪|crush-grip:捏碎|curse:诅咒|cut:居合斩|dark-pulse:恶之波动|dark-void:暗黑洞|dazzlin',
    'g-gleam:魔法闪耀|defend-order:防御指令|defense-curl:变圆|defog:清除浓雾|destiny-bond:同命|detect:看穿|dig:挖洞|disable:定',
    '身法|disarming-voice:魅惑之声|discharge:放电|dive:潜水|doom-desire:破灭之愿|double-edge:舍身冲撞|double-hit:二连击|double',
    '-kick:二连踢|double-team:影子分身|dragon-ascent:画龙点睛|dragon-breath:龙息|dragon-claw:龙爪|dragon-dance:龙之舞|drago',
    'n-pulse:龙之波动|dragon-rush:龙之俯冲|dragon-tail:龙尾|drain-punch:吸取拳|draining-kiss:吸取之吻|dream-eater:食梦|drill',
    '-peck:啄钻|drill-run:直冲钻|dual-chop:二连劈|dynamic-punch:爆裂拳|earth-power:大地之力|earthquake:地震|echoed-voice:回',
    '声|eerie-impulse:怪异电波|electric-terrain:电气场地|electro-ball:电球|ember:火花|encore:再来一次|endeavor:蛮干|endure:挺',
    '住|energy-ball:能量球|entrainment:找伙伴|eruption:喷火|explosion:大爆炸|extrasensory:神通力|extreme-speed:神速|facade',
    ':硬撑|fairy-wind:妖精之风|fake-out:击掌奇袭|fake-tears:假哭|false-swipe:点到为止|feather-dance:羽毛舞|feint:佯攻|fell-sti',
    'nger:致命针刺|final-gambit:搏命|fire-blast:大字爆炎|fire-fang:火焰牙|fire-punch:火焰拳|fire-spin:火焰旋涡|fissure:地裂|fla',
    'il:抓狂|flame-charge:蓄能焰袭|flame-wheel:火焰轮|flamethrower:喷射火焰|flare-blitz:闪焰冲锋|flash-cannon:加农光炮|flatter',
    ':吹捧|fling:投掷|fly:飞翔|focus-energy:聚气|focus-punch:真气拳|follow-me:看我嘛|force-palm:发劲|foul-play:欺诈|freeze-',
    'dry:冷冻干燥|frost-breath:冰息|fury-attack:乱击|fury-cutter:连斩|fury-swipes:乱抓|future-sight:预知未来|gastro-acid:',
    '胃液|giga-drain:终极吸取|giga-impact:终极冲击|glare:大蛇瞪眼|grass-knot:打草结|grassy-terrain:青草场地|gravity:重力|growl:叫',
    '声|growth:生长|guard-split:防守平分|guard-swap:防守互换|guillotine:断头钳|gunk-shot:垃圾射击|gust:起风|gyro-ball:陀螺球|hai',
    'l:冰雹|hammer-arm:臂锤|harden:变硬|haze:黑雾|head-smash:双刃头锤|headbutt:头锤|headlong-rush:突飞猛扑|heal-bell:治愈铃声|h',
    'eal-pulse:治愈波动|healing-wish:治愈之愿|heart-swap:心灵互换|heat-wave:热风|heavy-slam:重磅冲撞|helping-hand:帮助|hex:祸不',
    '单行|hidden-power:觉醒力量|high-horsepower:十万马力|high-jump-kick:飞膝踢|hone-claws:磨爪|horn-attack:角撞|horn-drill',
    ':角钻|howl:长嚎|hurricane:暴风|hydro-pump:水炮|hyper-beam:破坏光线|hyper-drill:强力钻|hyper-voice:巨声|hypnosis:催眠术|i',
    'ce-beam:冰冻光束|ice-fang:冰冻牙|ice-punch:冰冻拳|ice-shard:冰砾|icicle-spear:冰锥|icy-wind:冰冻之风|imprison:封印|incin',
    'erate:烧尽|inferno:炼狱|infestation:死缠烂打|ingrain:扎根|iron-defense:铁壁|iron-head:铁头|iron-tail:铁尾|judgment:制',
    '裁光砾|knock-off:拍落|laser-focus:磨砺|last-resort:珍藏|lava-plume:喷烟|leaf-blade:叶刃|leaf-storm:飞叶风暴|leaf-torn',
    'ado:青草搅拌器|leafage:树叶|leech-life:吸血|leech-seed:寄生种子|leer:瞪眼|lick:舌舔|life-dew:生命水滴|light-screen:光墙|liq',
    'uidation:水流裂破|lock-on:锁定|lovely-kiss:恶魔之吻|low-kick:踢倒|low-sweep:下盘踢|lunar-blessing:新月祈祷|lunar-dance:',
    '新月舞|lunge:猛扑|luster-purge:洁净光芒|mach-punch:音速拳|magic-room:魔法空间|magical-leaf:魔法叶|magma-storm:熔岩风暴|magn',
    'et-rise:电磁飘浮|magnetic-flux:磁场操控|mean-look:黑色目光|mega-drain:超级吸取|mega-kick:百万吨重踢|mega-punch:百万吨重拳|mega',
    'horn:超级角击|memento:临别礼物|metal-burst:金属爆炸|metal-claw:金属爪|metal-sound:金属音|meteor-mash:彗星拳|metronome:挥指|',
    'milk-drink:喝牛奶|mimic:模仿|mind-reader:心之眼|minimize:变小|mirror-coat:镜面反射|mist:白雾|mist-ball:薄雾球|moonblast',
    ':月亮之力|moonlight:月光|morning-sun:晨光|mud-shot:泥巴射击|mud-slap:掷泥|muddy-water:浊流|mystical-power:神秘之力|nasty',
    '-plot:诡计|night-shade:黑夜魔影|night-slash:暗袭要害|nuzzle:蹭蹭脸颊|octazooka:章鱼桶炮|origin-pulse:根源波动|outrage:逆鳞|o',
    'verheat:过热|pain-split:分担痛楚|parting-shot:抛下狠话|pay-day:聚宝功|payback:以牙还牙|peck:啄|perish-song:灭亡之歌|petal-',
    'blizzard:落英缤纷|petal-dance:花瓣舞|phantom-force:潜灵奇袭|pin-missile:飞弹针|play-nice:和睦相处|play-rough:嬉闹|pluck:',
    '啄食|poison-fang:剧毒牙|poison-gas:毒瓦斯|poison-jab:毒击|poison-powder:毒粉|poison-sting:毒针|poison-tail:毒尾|poun',
    'd:拍击|powder-snow:细雪|power-gem:力量宝石|power-split:力量平分|power-swap:力量互换|power-trick:力量戏法|power-trip:嚣张|p',
    'ower-whip:强力鞭打|precipice-blades:断崖之剑|present:礼物|protect:守住|psybeam:幻象光线|psych-up:自我暗示|psychic:精神强念|p',
    'sycho-boost:精神突进|psycho-cut:精神利刃|psycho-shift:精神转移|psyshock:精神冲击|psystrike:精神击破|quash:延后|quick-attac',
    'k:电光一闪|quick-guard:快速防守|quiver-dance:蝶舞|rage-fist:愤怒之拳|rage-powder:愤怒粉|raging-bull:怒牛|raging-fury:大愤',
    '慨|rain-dance:求雨|rapid-spin:高速旋转|razor-leaf:飞叶快刀|razor-shell:贝壳刃|recover:自我再生|recycle:回收利用|reflect:反射',
    '壁|reflect-type:镜面属性|rest:睡觉|retaliate:报仇|revenge:报复|reversal:起死回生|roar:吼叫|roar-of-time:时光咆哮|rock-bla',
    'st:岩石爆击|rock-polish:岩石打磨|rock-slide:岩崩|rock-smash:碎岩|rock-throw:落石|rock-tomb:岩石封锁|rock-wrecker:岩石炮|r',
    'ole-play:扮演|rollout:滚动|roost:羽栖|round:轮唱|sacred-fire:神圣之火|safeguard:神秘守护|sand-attack:泼沙|sand-tomb:流沙',
    '地狱|sandstorm:沙暴|scary-face:鬼面|scratch:抓|screech:刺耳声|seed-bomb:种子炸弹|seed-flare:种子闪光|seismic-toss:地球上投',
    '|self-destruct:自爆|shadow-ball:暗影球|shadow-claw:暗影爪|shadow-force:暗影潜袭|shadow-punch:暗影拳|shadow-sneak:影子',
    '偷袭|sheer-cold:绝对零度|shell-smash:破壳|shock-wave:电击波|simple-beam:单纯光束|sing:唱歌|sketch:写生|skill-swap:特性互换|',
    'sky-attack:神鸟猛击|slack-off:偷懒|slam:摔打|slash:劈开|sleep-powder:催眠粉|sleep-talk:梦话|sludge:污泥攻击|sludge-bomb',
    ':污泥炸弹|sludge-wave:污泥波|smack-down:击落|smart-strike:修长之角|smog:浊雾|smokescreen:烟幕|snarl:大声咆哮|snore:打鼾|sno',
    'wscape:雪景|soak:浸水|soft-boiled:生蛋|solar-beam:日光束|spacial-rend:亚空裂斩|spark:电光|spikes:撒菱|spiky-shield:尖刺',
    '防守|spit-up:喷出|spite:怨恨|splash:跃起|spore:蘑菇孢子|stealth-rock:隐形岩|steel-wing:钢翼|sticky-web:黏黏网|stockpile:',
    '蓄力|stomp:踩踏|stomping-tantrum:跺脚|stone-edge:尖石攻击|stored-power:辅助力量|storm-throw:山岚摔|strength:怪力|string',
    '-shot:吐丝|struggle:挣扎|struggle-bug:虫之抵抗|stun-spore:麻痹粉|submission:地狱翻滚|substitute:替身|sucker-punch:突袭|',
    'sunny-day:大晴天|super-fang:愤怒门牙|superpower:蛮力|supersonic:超音波|surf:冲浪|swagger:虚张声势|swallow:吞下|sweet-kis',
    's:天使之吻|sweet-scent:甜甜香气|swift:高速星星|switcheroo:掉包|swords-dance:剑舞|synthesis:光合作用|tackle:撞击|tail-glow:',
    '萤火|tail-whip:摇尾巴|tailwind:顺风|take-down:猛撞|take-heart:勇气填充|taunt:挑衅|tearful-look:泪眼汪汪|teeter-dance:摇晃',
    '舞|teleport:瞬间移动|thief:小偷|thrash:大闹一番|throat-chop:地狱突刺|thunder:打雷|thunder-fang:雷电牙|thunder-punch:雷电拳|',
    'thunder-shock:电击|thunder-wave:电磁波|thunderbolt:十万伏特|tickle:挠痒|torment:无理取闹|toxic:剧毒|toxic-spikes:毒菱|t',
    'oxic-thread:毒丝|transform:变身|tri-attack:三重攻击|trick:戏法|trick-room:戏法空间|triple-kick:三连踢|twin-beam:双光束|t',
    'wister:龙卷风|u-turn:急速折返|uproar:吵闹|vacuum-wave:真空波|venoshock:毒液冲击|vice-grip:夹住|vine-whip:藤鞭|vital-thro',
    'w:借力摔|volt-switch:伏特替换|water-gun:水枪|water-pulse:水之波动|water-spout:喷水|waterfall:攀瀑|wave-crash:波动冲|weat',
    'her-ball:气象球|whirlpool:潮旋|whirlwind:吹飞|wide-guard:广域防守|wild-charge:疯狂伏特|will-o-wisp:鬼火|wing-attack:翅',
    '膀攻击|wish:祈愿|withdraw:缩入壳中|wonder-room:奇妙空间|wood-hammer:木槌|work-up:自我激励|worry-seed:烦恼种子|wrap:紧束|x-sci',
    'ssor:十字剪|yawn:哈欠|zap-cannon:电磁炮|zen-headbutt:意念头锤',
  ].join('');

  const TA_MVNAME = (() => {
    const out = {};
    for (const item of TA_MVNAME_RAW.split('|')) {
      const sep = item.indexOf(':');
      if (sep > 0) out[item.slice(0, sep)] = item.slice(sep + 1);
    }
    return out;
  })();
  const TA_NAME = TA_NAME_RAW.split(',');

  const TA_MV = (() => {
    const out = {};
    for (const item of TA_MOVES_RAW.split('|')) {
      const sep = item.indexOf(':');
      if (sep < 0) continue;
      const body = item.slice(sep + 1);
      const t = TA_TC.indexOf(body[0]);
      const cat = body[body.length - 1];
      const p = parseInt(body.slice(1, -1), 10) || 0;
      if (t >= 0) out[item.slice(0, sep)] = { t, p, c: cat };
    }
    return out;
  })();

  const TA_MV_KEYS = Object.keys(TA_MV);

  const TA_LEARN = (() => {
    const out = {};
    const rows = TA_LEARN_RAW.split('^');
    const d36 = (s) => parseInt(s, 36);
    for (let i = 0; i < rows.length; i++) {
      const arr = [];
      if (rows[i]) {
        for (const part of rows[i].split('|')) {
          if (!part) continue;
          const dot = part.indexOf('.');
          const lv = d36(part.slice(0, dot));
          const idx = d36(part.slice(dot + 1));
          const key = TA_MV_KEYS[idx];
          if (key) arr.push([lv, key]);
        }
      }
      out[i + 1] = arr;
    }
    return out;
  })();

  /** 属性倍率：双属性相乘后夹在 [0, 4]（游戏 Ft()） */
  function taEff(atkType, defTypes) {
    if (!defTypes || !defTypes.length) return 1;
    let m = 1;
    for (const d of defTypes) m *= (TA_CHART[atkType] || [])[d] ?? 1;
    return Math.min(4, Math.max(0, m));
  }

  /** 六围（游戏 Yt / statsOf）：floor((floor(2*base*lv/100)+5)*mult) */
  function taStats(mon) {
    const base = BASE[mon.id];
    if (!base) return null;
    const lv = mon.level || 1;
    const mult = (mon.shiny ? 1.1 : 1) * (mon.statMult || 1);
    const f = (b) => Math.floor((Math.floor((2 * b * lv) / 100) + 5) * mult);
    return {
      hp: Math.floor((Math.floor((2 * base[0] * lv) / 100) + lv + 10) * mult),
      atk: f(base[1]), def: f(base[2]), spa: f(base[3]), spd: f(base[4]), spe: f(base[5]),
    };
  }

  /** 战斗血量（游戏 Se / maxHp）：HP 值 × min(2.5, 1+1.5*lv/100) */
  function taMaxHp(mon) {
    const st = taStats(mon);
    if (!st) return 1;
    const lv = mon.level || 1;
    const scale = Math.min(2.5, 1 + (1.5 * lv) / 100);
    return Math.max(1, Math.floor(st.hp * scale * (mon.hpMult || 1)));
  }

  /** 命中率（游戏 xa / moveAcc）：威力越高命中越低，线性插值 */
  function taAcc(key) {
    const mv = TA_MV[key];
    if (!mv || mv.p <= 0) return 100;
    const [lo, hi, mn] = TA_ACC;
    return 100 - (100 - mn) * Math.min(1, Math.max(0, (mv.p - lo) / (hi - lo)));
  }

  function taLearnOf(mon) {
    return TA_LEARN[mon.id] || [];
  }

  /**
   * 选招（游戏 ka / bestMoveAgainst）：在「当前等级已解锁 + 不在黑名单」的技能里，
   * 取 期望威力 × 命中 × STAB × 属性倍率 最大的一招。
   */
  function taBestMove(mon, defTypes) {
    const st = taStats(mon);
    if (!st) return null;
    const lv = mon.level || 1;
    const myTypes = TA_DEX[mon.id] || [];
    let best = null;
    let bestScore = 0;
    for (const [need, key] of taLearnOf(mon)) {
      if (need > lv) continue;
      const mv = TA_MV[key];
      if (!mv || mv.p <= 0) continue;
      const eff = taEff(mv.t, defTypes);
      if (eff === 0) continue;
      const phys = mv.c === 'p';
      const atk = phys ? st.atk : st.spa;
      const stab = myTypes.includes(mv.t) ? 1.5 : 1;
      const acc = taAcc(key) / 100;
      const score = mv.p * (atk / 50) * stab * eff * acc;
      if (score > bestScore) {
        bestScore = score;
        best = { key, type: mv.t, phys, power: mv.p, eff, stab, acc, score };
      }
    }
    return best;
  }

  /** 单次伤害（游戏 V）：含等级差 1.06^n、STAB、属性倍率、暴击期望 1.5×1/24 */
  function taDamage(att, def, mv, eff) {
    const a = taStats(att);
    const d = taStats(def);
    if (!a || !d) return 0;
    const atk = mv.phys ? a.atk : a.spa;
    const dfn = Math.max(1, mv.phys ? d.def : d.spd);
    const base = ((2 * (att.level || 1)) / 5 + 2) * mv.power * atk / dfn / 50 + 2;
    const gap = Math.pow(1.06, (att.level || 1) - (def.level || 1));
    const crit = 1 + (1 / 24) * 0.5;   // 暴击期望
    return base * mv.stab * eff * gap * crit;
  }

  /**
   * 一只宝可梦对一组敌人的完整评估
   * @param mon 原始宝可梦对象
   * @param enemies 敌人列表 [{id, level, w}]
   * @param benchLv 拉平基准等级（0 或不传则按真实等级评估）
   */
  function taEvaluate(mon, enemies, benchLv = 0) {
    const realLv = mon.level || 1;
    const evalLv = benchLv > 0 ? Math.max(realLv, benchLv) : realLv;
    // 用虚拟等级克隆对象，自动解锁该等级技能与拉平六围/伤害
    const vMon = evalLv === realLv ? mon : { ...mon, level: evalLv };

    const st = taStats(vMon);
    if (!st) return null;
    const myTypes = TA_DEX[vMon.id] || [];
    const myHp = taMaxHp(vMon);
    let offW = 0;      // 加权输出能力（含溢出收益，防 1.0 硬截断）
    let defW = 0;      // 加权生存能力（含被克制惩罚）
    let spdW = 0;      // 加权先手率
    let effW = 0;      // 加权克制倍率
    let wSum = 0;
    let worst = null;
    let top = null;
    const coveredIds = new Set(); // 记录该宝可梦能有效克制(>=2x)且打得动的敌人
    const weakToEnemies = new Set(); // 记录能克制该宝可梦的敌人

    for (const e of enemies) {
      const eTypes = TA_DEX[e.id] || [];
      const w = e.w || 1;
      wSum += w;
      const mv = taBestMove(vMon, eTypes);
      const eHp = taMaxHp(e);
      if (mv && (!top || e.w > top.w)) top = { w: e.w, key: mv.key, type: mv.type, power: mv.power, eff: mv.eff };

      let ko = 0;
      let effv = 0;
      if (mv) {
        const dmg = taDamage(vMon, e, mv, mv.eff) * mv.acc;
        const ratio = dmg / eHp;
        // 软上限：1击必杀得 0.85，2倍溢出得 1.0，避免逆属性靠等级擦边秒杀直接拿满分
        ko = ratio <= 1 ? ratio * 0.85 : Math.min(1, 0.85 + Math.min(1, ratio - 1) * 0.15);
        effv = mv.eff;
        if (effv >= 2 && ratio >= 0.65) coveredIds.add(e.id);
      }

      // 敌人反打：用敌人最优招打我方
      const emv = taBestMove(e, myTypes);
      const back = emv ? taDamage(e, vMon, emv, emv.eff) * emv.acc : 0;
      let survive = back > 0 ? Math.min(1, (myHp / back) / 3.5) : 1;
      // 防守端被克制惩罚：如果敌人有 2x/4x 克制我方的招式，大幅压低耐久评分
      if (emv && emv.eff >= 2) {
        survive *= (emv.eff >= 4 ? 0.45 : 0.72);
        weakToEnemies.add(e.id);
      }

      const eSpeed = (taStats(e) || {}).spe || 1;
      const first = st.spe >= eSpeed ? 1 : Math.pow(st.spe / eSpeed, 1.5);

      offW += w * ko;
      defW += w * survive;
      spdW += w * first;
      effW += w * effv;
      if (!worst || effv < worst.eff) worst = { id: e.id, eff: effv };
    }
    if (!wSum) wSum = 1;
    const offense = offW / wSum;
    const defense = defW / wSum;
    const speed = spdW / wSum;
    const effAvg = effW / wSum;

    // 调整权重：输出 35% + 耐久 25% + 先手 15% + 属性克制优势 25%
    const effScore = Math.min(1, effAvg / 2.2);
    let raw = offense * 0.35 + defense * 0.25 + speed * 0.15 + effScore * 0.25;

    // 养成成本微调：在拉平模式下，如果需要喂糖补级，最多扣减 6%（既优先同级现成怪，又不会埋没仓库神宠）
    const lvNeed = Math.max(0, evalLv - realLv);
    if (benchLv > 0 && lvNeed > 0) {
      raw -= Math.min(0.06, (lvNeed / 50) * 0.06);
    }

    const score = Math.max(1, Math.round(raw * 100));
    return {
      mon,
      evalLv,
      lvNeed,
      hp: myHp,
      stats: st,
      offense, defense, speed, effAvg,
      score,
      worst,
      top,
      types: myTypes,
      coveredIds,
      weakToEnemies,
      grade: score >= 78 ? 'S' : score >= 65 ? 'A' : score >= 52 ? 'B' : score >= 40 ? 'C' : 'D',
    };
  }

  /** 队伍整体评分 + 属性覆盖 */
  function taScoreTeam(teamMons, enemies, benchLv = 0) {
    if (!teamMons.length) return null;
    const evals = teamMons.map((m) => taEvaluate(m, enemies, benchLv)).filter(Boolean);
    if (!evals.length) return null;
    const avg = evals.reduce((a, e) => a + e.score, 0) / evals.length;
    let coverCount = 0;
    for (const e of enemies) {
      let bestEff = 0;
      for (const ev of evals) {
        const vMon = ev.evalLv ? { ...ev.mon, level: ev.evalLv } : ev.mon;
        const mv = taBestMove(vMon, TA_DEX[e.id] || []);
        if (mv) bestEff = Math.max(bestEff, mv.eff);
      }
      if (bestEff >= 2) coverCount++;
    }
    const coverRate = enemies.length ? coverCount / enemies.length : 0;
    const score = Math.round(avg * (0.72 + 0.28 * coverRate));
    const grade = score >= 78 ? 'S' : score >= 65 ? 'A' : score >= 52 ? 'B' : score >= 40 ? 'C' : 'D';
    return { evals, score, grade, avg: Math.round(avg), coverRate };
  }

  /**
   * 贪心配队：兼顾单兵战力、新增敌人克制覆盖面（coverGain）、避免属性与弱点扎堆
   */
  function taSuggestTeam(cands, enemies, size = 6, benchLv = 0) {
    // 同一图鉴编号（或同进化链）只保留评分最高的一只，防止推荐 3 只暴鲤龙
    const rawPool = cands.map((m) => ({ m, ev: taEvaluate(m, enemies, benchLv) })).filter((x) => x.ev);
    if (!rawPool.length) return null;
    rawPool.sort((a, b) => b.ev.score - a.ev.score);

    const bestBySpecies = new Map();
    for (const item of rawPool) {
      if (!bestBySpecies.has(item.m.id)) bestBySpecies.set(item.m.id, item);
    }
    const pool = [...bestBySpecies.values()];

    const chosen = [];
    const usedTypes = new Set();
    const usedUids = new Set();
    const coveredEnemies = new Set();
    const teamWeakCount = {}; // 统计队伍共同惧怕的敌人

    while (chosen.length < size && chosen.length < pool.length) {
      let best = null;
      let bestGain = -Infinity;
      for (const cand of pool) {
        if (usedUids.has(cand.m.uid)) continue;
        const ev = cand.ev;

        // 1. 新增克制覆盖奖励：如果能克制当前队伍还没搞定的敌人，大幅加分
        let newCoverBonus = 0;
        for (const eid of ev.coveredIds) {
          if (!coveredEnemies.has(eid)) {
            const eObj = enemies.find((x) => x.id === eid);
            newCoverBonus += 10 * ((eObj && eObj.w) ? Math.min(2, eObj.w * 4) : 1);
          }
        }

        // 2. 属性重复惩罚（提高到 10 分，避免同系扎堆）
        const overlap = ev.types.filter((t) => usedTypes.has(t)).length;
        const dupPenalty = overlap * 10;

        // 3. 弱点重叠惩罚：如果这只怪怕的敌人，队伍里已经有 2 只以上也怕，扣分
        let weakPenalty = 0;
        for (const wid of ev.weakToEnemies) {
          if ((teamWeakCount[wid] || 0) >= 2) weakPenalty += 6;
        }

        const gain = ev.score + newCoverBonus - dupPenalty - weakPenalty;
        if (gain > bestGain) { bestGain = gain; best = cand; }
      }
      if (!best) break;
      chosen.push(best);
      usedUids.add(best.m.uid);
      best.ev.types.forEach((t) => usedTypes.add(t));
      best.ev.coveredIds.forEach((eid) => coveredEnemies.add(eid));
      best.ev.weakToEnemies.forEach((wid) => { teamWeakCount[wid] = (teamWeakCount[wid] || 0) + 1; });
    }
    const teamMons = chosen.map((c) => c.m);
    return { team: teamMons, evals: chosen.map((c) => c.ev), summary: taScoreTeam(teamMons, enemies, benchLv) };
  }

  /** 培养价值：满级潜力 + 进化后种族值提升 */
  function taPotential(mon) {
    const cur = taStats(mon);
    if (!cur) return null;
    const lv = mon.level || 1;
    const base = BASE[mon.id];
    const baseTotal = base.reduce((a, b) => a + b, 0);
    // 满级（100）六围
    const f100 = (b) => Math.floor((Math.floor((2 * b * 100) / 100) + 5) * 1);
    const total100 = Math.floor((Math.floor((2 * base[0] * 100) / 100) + 100 + 10))
        + f100(base[1]) + f100(base[2]) + f100(base[3]) + f100(base[4]) + f100(base[5]);
    const curTotal = cur.hp + cur.atk + cur.def + cur.spa + cur.spd + cur.spe;
    // 进化后种族值（在同 id 序列里找 id+1 且 base 提升）
    const nxt = BASE[mon.id + 1];
    const evoGain = nxt ? Math.max(0, nxt.reduce((a, b) => a + b, 0) - baseTotal) : 0;
    return {
      baseTotal, total100, curTotal, evoGain,
      growth: Math.round((1 - curTotal / total100) * 100),
      lv,
    };
  }

  /** 培养建议：种族值潜力 + 等级空间 + 同级战力，挑出最该练的 */
  function taTrainSuggest(mons, enemies, n = 3, benchLv = 0) {
    const scored = [];
    for (const m of mons) {
      const pot = taPotential(m);
      if (!pot) continue;
      const ev = taEvaluate(m, enemies, benchLv);
      const lvGap = 1 - Math.min(1, (m.level || 1) / 100);
      const v = (pot.baseTotal / 620) * 0.45 + lvGap * 0.2 + ((ev ? ev.score : 0) / 100) * 0.25 + Math.min(0.1, pot.evoGain / 500);
      scored.push({ mon: m, pot, ev, v });
    }
    scored.sort((a, b) => b.v - a.v);
    return scored.slice(0, n);
  }

  /** 当前区域敌人池：优先读右侧「此处出没」，退回徽章等级区间 */
  function taEnemyPool() {
    const cells = $$('.zone-cell[data-id]');
    const pool = [];
    for (const cell of cells) {
      const id = +cell.dataset.id;
      if (!id || !BASE[id]) continue;
      const title = cell.getAttribute('title') || '';
      const lm = title.match(/Lv\.(\d+)\s*[-–]\s*(\d+)/);
      const lv = lm ? Math.round((+lm[1] + +lm[2]) / 2) : 5;
      const pm = cell.innerText.match(/(\d+)%/);
      const w = pm ? +pm[1] / 100 : 0.1;
      pool.push({ id, level: lv, w: Math.max(0.02, w) });
    }
    if (pool.length) return pool;
    // 退路：用当前章节等级区间随便造一个典型敌人
    const band = chapterBand();
    if (band) return [{ id: 19, level: Math.round((band.lo + band.hi) / 2), w: 1 }];
    return [];
  }

  /** 下一枚道馆：从徽章栏读区域 + 章节号，映射到 TA_GYMS */
  function taNextGym() {
    const el = $('#chapter-btn');
    if (!el) return null;
    const txt = (el.innerText || '').replace(/\s+/g, ' ');
    const rm = txt.match(/(关都|城都|丰缘|神奥)\s*·\s*第\s*(\d+)\s*章/);
    if (!rm) return null;
    const base = { '关都': 0, '城都': 14, '丰缘': 30, '神奥': 47 }[rm[1]];
    if (base == null) return null;
    const idx = base + (+rm[2] - 1);
    const g = TA_GYMS[idx];
    if (!g) return null;
    return {
      region: rm[1], chapter: +rm[2], idx,
      leader: g.L, type: g.T, badge: g.B, team: g.team,
      lv: g.lv,
      enemies: g.team.map(([id, level]) => ({ id, level, w: 1 })),
    };
  }

  let taMode = 'norm'; // 'norm': 同级选优(默认) | 'gym': 备战下一道馆 | 'raw': 当前真实等级

  /** 分析入口：候选池 + 敌人池 + 推荐 */
  function taAnalyze(opts = {}) {
    const save = S.save;
    if (!save) return null;
    const mons = (save.mons || []).filter((m) => m && m.id && BASE[m.id]);
    if (!mons.length) return null;

    const gym = taNextGym();
    const mode = opts.mode || taMode || 'norm';
    const enemies = mode === 'gym' && gym ? gym.enemies : (opts.enemies || taEnemyPool());
    if (!enemies.length) return null;

    const team = (save.team || []).map((u) => mons.find((m) => m.uid === u)).filter(Boolean);

    // 计算拉平基准等级：取「敌方最高级」与「当前主力队中位等级」中的较大值
    const enemyMaxLv = Math.max(...enemies.map((e) => e.level || 1), 10);
    const teamLvs = team.map((m) => m.level || 1).sort((a, b) => a - b);
    const teamMedLv = teamLvs.length ? teamLvs[Math.floor(teamLvs.length / 2)] : enemyMaxLv;
    const benchLv = mode === 'raw' ? 0 : (mode === 'gym' && gym ? gym.lv[1] : Math.max(enemyMaxLv, teamMedLv));

    const cur = taScoreTeam(team, enemies, benchLv);
    const sug = taSuggestTeam(mons, enemies, 6, benchLv);
    return { mode, benchLv, enemies, team, cur, sug, total: mons.length, gym, train: taTrainSuggest(mons, enemies, 4, benchLv) };
  }

  /* ---------- 配队面板 UI ---------- */

  const TA_GRADE_COLOR = { S: '#f6c344', A: '#c084fc', B: '#60a5fa', C: '#94a3b8', D: '#64748b' };
  const TA_ROLE = (st) => {
    if (!st) return '未知';
    const bulk = st.hp + st.def + st.spd;
    const atk = Math.max(st.atk, st.spa);
    if (atk > bulk * 0.62) return '输出';
    if (bulk > atk * 1.75) return '坦克';
    return '平衡';
  };

  let taPanel = null;
  let taCache = null;

  function taMonName(mon) {
    return TA_NAME[mon.id - 1] || `#${mon.id}`;
  }

  function taSprite(mon) {
    return `assets/pokemon/${mon.id}.png`;
  }

  function taRowHtml(ev, rank, inTeamSet) {
    const m = ev.mon;
    const color = TA_GRADE_COLOR[ev.grade] || '#94a3b8';
    const role = TA_ROLE(ev.stats);
    const types = ev.types.map((t) => TA_TYPE_CN[TA_TYPES[t]] || '').join('/');
    const isNew = !inTeamSet.has(String(m.uid));
    const lvTag = ev.lvNeed > 0
        ? `<span title="当前 Lv.${m.level}，喂糖拉到 Lv.${ev.evalLv} 后的同级战力" style="font-size:10px;color:#fbbf24">Lv.${m.level}→${ev.evalLv}</span>`
        : `<span style="font-size:10px;color:#6b7488">Lv.${m.level}</span>`;

    return `
      <div class="ta-item" data-uid="${m.uid}" style="display:flex;align-items:center;gap:8px;padding:6px 4px;border-bottom:1px solid rgba(255,255,255,.05)">
        <b style="width:16px;color:#6b7488;font-size:11px">${rank}</b>
        <img src="${taSprite(m)}" alt="" style="width:34px;height:34px;image-rendering:pixelated;flex:none">
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:5px">
            <b style="font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(taMonName(m))}</b>
            ${lvTag}
            <span style="font-size:10px;padding:0 4px;border-radius:4px;background:rgba(255,255,255,.07);color:#9aa4b8">${types}</span>
            ${isNew ? '<span style="font-size:9.5px;padding:0 4px;border-radius:4px;background:rgba(74,222,128,.16);color:#4ade80">替补推荐</span>' : ''}
            ${m.shiny ? '<span style="font-size:10px">✨</span>' : ''}
          </div>
          <div style="font-size:10px;color:#6b7488;margin-top:2px">
            ${role} · 输出${Math.round(ev.offense * 100)} 耐久${Math.round(ev.defense * 100)} 先手${Math.round(ev.speed * 100)}
          </div>
          ${ev.top ? `<div style="font-size:10px;color:#7f8ba3;margin-top:1px">
            主攻 ${esc(TA_MVNAME[ev.top.key] || ev.top.key)} · ${TA_TYPE_CN[TA_TYPES[ev.top.type]]} ${ev.top.power}${ev.top.eff >= 2 ? ` · <b style="color:#8ee98e">克制×${ev.top.eff}</b>` : ''}
            ${ev.worst && ev.worst.eff < 1 ? `<span style="color:#f87171"> · 被${TA_TYPE_CN[TA_TYPES[(TA_DEX[ev.worst.id] || [0])[0]]]}抗</span>` : ''}
          </div>` : ''}
        </div>
        <div style="text-align:right;flex:none">
          <b style="color:${color};font-size:14px">${ev.score}</b>
          <div style="font-size:9px;color:${color};letter-spacing:.5px">${ev.grade}</div>
        </div>
      </div>`;
  }

  function taPanelHtml(res) {
    const g = res.gym;
    const inTeamSet = new Set((res.team || []).map((m) => String(m.uid)));
    const enemyNames = res.enemies.slice(0, 6).map((e) => {
      const t = (TA_DEX[e.id] || []).map((x) => TA_TYPE_CN[TA_TYPES[x]]).join('/');
      return `<span style="display:inline-flex;align-items:center;gap:3px;padding:1px 5px;border-radius:5px;background:rgba(255,255,255,.06);font-size:10px">
        <img src="assets/pokemon/${e.id}.png" style="width:18px;height:18px;image-rendering:pixelated">${t} Lv.${e.level}</span>`;
    }).join('');

    const sum = res.sug && res.sug.summary;
    const curSum = res.cur;
    const gradeColor = TA_GRADE_COLOR[(sum && sum.grade) || 'D'];
    const rows = (res.sug ? res.sug.evals : []).map((ev, i) => taRowHtml(ev, i + 1, inTeamSet)).join('');

    let trainHtml = '';
    if (res.train && res.train.length) {
      const sugUids = new Set((res.sug ? res.sug.team : []).map((m) => String(m.uid)));
      const items = res.train.filter((t) => !sugUids.has(String(t.mon.uid))).slice(0, 3);
      if (items.length) {
        trainHtml = `
        <div style="margin-top:8px;padding:7px 8px;border-radius:8px;background:rgba(96,165,250,.07);border:1px solid rgba(96,165,250,.18)">
          <div style="font-size:11px;color:#60a5fa;font-weight:600;margin-bottom:4px">值得培养</div>
          ${items.map((t) => `<div style="display:flex;align-items:center;gap:6px;font-size:11px;color:#c9d1e0;padding:2px 0">
            <img src="assets/pokemon/${t.mon.id}.png" style="width:22px;height:22px;image-rendering:pixelated">
            <b style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(taMonName(t.mon))}</b>
            <span style="color:#6b7488;font-size:10px">Lv.${t.mon.level}</span>
            <span style="color:#8b93a7;font-size:10px">种族值 ${t.pot.baseTotal}</span>
            <span style="color:#60a5fa;font-size:10px">${t.pot.growth}% 成长空间</span>
          </div>`).join('')}
        </div>`;
      }
    }

    const gymHtml = g ? `
      <div style="margin-top:8px;padding:7px 8px;border-radius:8px;background:rgba(255,203,5,.07);border:1px solid rgba(255,203,5,.2)">
        <div style="font-size:11px;color:#ffcb05;font-weight:600">下一道馆 · ${esc(g.region)}第${g.chapter}章</div>
        <div style="font-size:11px;color:#9aa4b8;margin-top:3px">
          ${esc(g.leader)} · ${TA_TYPE_CN[g.type] || g.type}系 · Lv.${g.lv[0]}–${g.lv[1]}
        </div>
        <div style="display:flex;gap:4px;margin-top:5px;flex-wrap:wrap">
          ${g.team.map(([id, lv]) => `<span style="display:inline-flex;align-items:center;gap:2px;font-size:10px;color:#c9d1e0">
            <img src="assets/pokemon/${id}.png" style="width:20px;height:20px;image-rendering:pixelated">${lv}</span>`).join('')}
        </div>
      </div>` : '';

    const tabBtn = (m, label) => {
      const on = res.mode === m;
      return `<button data-tamode="${m}" style="flex:1;padding:4px 6px;border-radius:6px;border:1px solid ${on ? '#ffcb05' : '#2c3346'};background:${on ? 'rgba(255,203,5,.15)' : 'transparent'};color:${on ? '#ffcb05' : '#9aa4b8'};cursor:pointer;font-size:11px;font-weight:${on ? '700' : '400'}">${label}</button>`;
    };

    return `
      <div style="display:flex;align-items:center;gap:8px;padding:9px 11px;border-bottom:1px solid rgba(255,255,255,.07);background:linear-gradient(90deg,rgba(255,203,5,.16),transparent)">
        <b style="font-size:13px">配队推荐</b>
        <span style="font-size:10.5px;color:#8b93a7">${res.benchLv ? `同级拉平 Lv.${res.benchLv}` : '按当前实际等级'}</span>
        <span style="flex:1"></span>
        <button id="ta-close" style="all:unset;cursor:pointer;color:#9aa4b8;padding:0 4px">×</button>
      </div>
      <div style="padding:9px 11px;max-height:68vh;overflow:auto">
        <div style="display:flex;gap:6px;margin-bottom:8px">
          ${tabBtn('norm', '同级选优（当前野怪）')}
          ${tabBtn('gym', '备战道馆')}
          ${tabBtn('raw', '当前即战力')}
        </div>

        <div style="font-size:11px;color:#8b93a7;margin-bottom:4px">
          ${res.mode === 'gym' && g ? `目标道馆：${esc(g.leader)}（${TA_TYPE_CN[g.type] || g.type}系）` : `当前区域敌人 · ${res.enemies.length} 种`}
        </div>
        <div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:8px">${enemyNames}</div>

        <div style="display:flex;align-items:center;gap:8px;padding:7px 9px;border-radius:8px;background:rgba(255,255,255,.04);margin-bottom:8px">
          <div style="text-align:center">
            <div style="font-size:20px;font-weight:800;color:${gradeColor};line-height:1">${sum ? sum.grade : '—'}</div>
            <div style="font-size:9px;color:#6b7488;margin-top:2px">推荐队</div>
          </div>
          <div style="flex:1">
            <div style="font-size:11px;color:#c9d1e0">推荐队 <b style="color:${gradeColor}">${sum ? sum.score : 0}</b> 分
              <span style="color:#6b7488">· 克制覆盖 ${sum ? Math.round(sum.coverRate * 100) : 0}%</span></div>
            <div style="font-size:11px;color:#8b93a7;margin-top:2px">当前队 <b style="color:#c9d1e0">${curSum ? curSum.score : 0}</b> 分
              <span style="color:#6b7488">· 克制覆盖 ${curSum ? Math.round(curSum.coverRate * 100) : 0}%</span></div>
          </div>
          <button id="ta-apply" style="padding:5px 9px;border-radius:7px;border:1px solid rgba(255,203,5,.45);background:rgba(255,203,5,.12);color:#ffcb05;cursor:pointer;font-size:11px">高亮推荐</button>
        </div>

        <div style="font-size:11px;color:#8b93a7;margin-bottom:2px">推荐阵容（从库存 ${res.total} 只中选出）</div>
        ${rows || '<div style="font-size:11px;color:#6b7488;padding:8px 0">没有可用候选</div>'}
        ${gymHtml}
        ${trainHtml}
      </div>`;
  }

  function renderTaPanel() {
    if (!taPanel) return;
    const res = taCache;
    if (!res) {
      taPanel.innerHTML = `<div style="padding:14px;font-size:12px;color:#9aa4b8">还没有数据（等游戏跑一会儿，或先进入有野怪的区域）</div>`;
      return;
    }
    taPanel.innerHTML = taPanelHtml(res);
    const close = taPanel.querySelector('#ta-close');
    if (close) close.onclick = () => { taPanel.style.display = 'none'; };
    const apply = taPanel.querySelector('#ta-apply');
    if (apply) apply.onclick = () => taHighlight(res);
    taPanel.querySelectorAll('button[data-tamode]').forEach((btn) => {
      btn.onclick = () => {
        taMode = btn.dataset.tamode;
        taRefresh();
      };
    });
  }

  /** 自动提醒：当前队伍明显落后于最优解时提示一次（区域/等级变化后触发） */
  function taAutoWatch() {
    if (!S.cfg || !S.cfg.teamAdvisor) return;
    if (typeof taAnalyze !== 'function') return;
    let res;
    try { res = taAnalyze({ mode: 'norm' }); } catch (e) { return; }
    if (!res || !res.sug || !res.cur) return;
    const zoneKey = res.enemies.map((e) => e.id + ':' + e.level).join(',');
    if (zoneKey !== S.lastAdvisorZone) {
      S.lastAdvisorZone = zoneKey;
      S.lastAdvisorWarn = 0;
      S.lastAdvisorGap = 0;
      return;
    }
    const gap = res.sug.summary.score - res.cur.score;
    const cooled = now() - (S.lastAdvisorWarn || 0) > 10 * 60000;
    if (gap < 12 || !cooled) return;
    if (gap <= (S.lastAdvisorGap || 0) + 5) return;
    S.lastAdvisorWarn = now();
    S.lastAdvisorGap = gap;
    const inTeam = new Set((res.team || []).map((m) => String(m.uid)));
    const best = res.sug.evals.find((ev) => !inTeam.has(String(ev.mon.uid))) || res.sug.evals[0];
    const who = best ? `，可换上 ${taMonName(best.mon)}（${best.score} 分 ${best.grade}）` : '';
    log('info', `配队建议：当前队伍 ${res.cur.score} 分，本区域最优 ${res.sug.summary.score} 分${who}。点 HUD「配队」查看。`);
  }

  function openTeamAdvisor() {
    if (!taPanel) {
      taPanel = document.createElement('div');
      taPanel.id = 'pcauto-ta';
      taPanel.style.cssText =
          'position:fixed;z-index:2147483001;top:60px;left:50%;transform:translateX(-50%);width:380px;' +
          'font:12px/1.45 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#e8ecf4;' +
          'background:rgba(18,20,28,.97);border:1px solid rgba(255,203,5,.3);border-radius:12px;' +
          'box-shadow:0 16px 44px rgba(0,0,0,.55);backdrop-filter:blur(10px);overflow:hidden;';
      document.documentElement.appendChild(taPanel);
    }
    taPanel.style.display = '';
    taRefresh();
    return taPanel;
  }

  function taRefresh() {
    try {
      taCache = taAnalyze();
    } catch (e) {
      taCache = null;
    }
    renderTaPanel();
  }

  /** 在队伍 / 电脑格子上标出推荐顺序，不自动改动阵容 */
  function taHighlight(res) {
    $$('.pcauto-ta-mark').forEach((e) => e.remove());
    if (!res || !res.sug) return;
    const order = new Map(res.sug.team.map((m, i) => [String(m.uid), i + 1]));
    let n = 0;
    const done = new Set();
    const cands = $$('.slot[data-uid], .pc-cell[data-uid], .tr-row[data-uid]')
        .filter((n) => n.getBoundingClientRect().width > 0);
    for (const node of cands) {
      const uid = String(node.dataset.uid);
      if (done.has(uid)) continue;
      const k = order.get(uid);
      if (!k) continue;
      done.add(uid);
      const mark = document.createElement('span');
      mark.className = 'pcauto-ta-mark';
      mark.textContent = k;
      mark.style.cssText = 'position:absolute;left:2px;top:2px;z-index:7;min-width:14px;height:14px;' +
          'border-radius:7px;background:#ffcb05;color:#12141c;font:700 10px/14px system-ui;text-align:center;padding:0 3px';
      node.style.position = 'relative';
      node.appendChild(mark);
      n++;
    }
    log('info', n ? `已标出推荐的 ${n} 只（黄色序号 = 上阵优先级）` : '当前界面没有可标记的宝可梦，先打开「队伍/电脑」');
    // 标记在队伍格子上，面板留着会挡住，1.2 秒后自动收起
    if (n) setTimeout(() => { if (taPanel) taPanel.style.display = 'none'; }, 1200);
  }

  /* ====================== 工具 ====================== */

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const now = () => Date.now();
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const fmt = (n) => {
    n = Math.round(n || 0);
    return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e4 ? (n / 1e3).toFixed(1) + 'k' : String(n);
  };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ---- 存储与解析的统一兜底：任何异常都退回默认值，绝不让脚本在初始化阶段崩掉 ---- */

  function safeParse(raw, fallback) {
    try { const v = JSON.parse(raw); return v == null ? fallback : v; } catch { return fallback; }
  }
  function lsGet(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  }
  function lsSet(key, val) {
    try { localStorage.setItem(key, val); return true; } catch { return false; }
  }

  /** 所有定时任务的统一兜底：单次异常不会让这条定时器变成植物人，且会在日志里喊一声 */
  function safeInterval(name, fn, ms) {
    let warnedAt = 0;
    return setInterval(() => {
      try {
        fn();
      } catch (e) {
        if (now() - warnedAt > 60000) {
          warnedAt = now();
          try { log('warn', `内部任务「${name}」异常：${(e && e.message) || e}`); } catch { /* 忽略 */ }
        }
      }
    }, ms);
  }

  /** 真实可见性：keepAlive 开启后 document.hidden 被伪装，必须读原始描述符 */
  function isRealHidden() {
    const d = S.realDescs && S.realDescs.descH;
    if (d && typeof d.get === 'function') {
      try { return !!d.get.call(PAGE_DOC); } catch { /* 回落 */ }
    }
    return !!document.hidden;
  }

  /** 同时派发 pointer/mouse/click，兼容只监听 pointerdown 的控件 */
  function fire(el) {
    if (!el || el.disabled) return false;
    const r = el.getBoundingClientRect();
    // 不传 view：脚本在油猴沙箱里时，沙箱 window 或 unsafeWindow 当作 view 都可能让事件构造直接抛错
    const opt = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
    try {
      el.dispatchEvent(new PointerEvent('pointerdown', opt));
      el.dispatchEvent(new PointerEvent('pointerup', opt));
      el.dispatchEvent(new MouseEvent('click', opt));
      return true;
    } catch (e) {
      try { el.click(); return true; } catch (_) { return false; }
    }
  }

  function readSaveRaw() { return lsGet(SAVE_KEY); }
  function readSave() { return safeParse(readSaveRaw(), null); }
  function readCfg() {
    const saved = safeParse(lsGet(CFG_KEY), {}) || {};
    return {
      ...DEFAULTS,
      ...saved,
      berryFamilies: { ...DEFAULTS.berryFamilies, ...(saved.berryFamilies || {}) },
      pushEvents: { ...DEFAULTS.pushEvents, ...(saved.pushEvents || {}) },
    };
  }
  function defaultCfg() {
    return { ...DEFAULTS, berryFamilies: { ...DEFAULTS.berryFamilies }, pushEvents: { ...DEFAULTS.pushEvents } };
  }
  function writeCfg(c) { lsSet(CFG_KEY, JSON.stringify(c)); }

  /* ====================== 运行状态 ====================== */

  const S = {
    cfg: readCfg(),
    bootAt: now(),
    save: null,
    saveRaw: '',           // 上次 parse 过的原始字符串，用于跳过没必要的 JSON.parse
    saveMissWarned: false,
    teamCache: null,       // { src: S.save, val }
    monMapCache: null,     // { src: S.save, map }
    baseline: null,        // {at, caught, battles, money, dex}
    sessionEarned: 0,      // 本次会话累计净赚金钱（忽略消费负增量）
    win: [],               // 滑动窗口样本
    rate: { catch: 0, battle: 0, money: 0 },
    avg: { catch: 0, battle: 0, money: 0 },
    shinyKeys: new Set(safeParse(lsGet(SHINY_KEY), []) || []),
    shinyPrimed: false,    // 首轮扫描只登记不通知，避免记录被裁剪后老闪光「复活」
    shinySession: 0,
    events: [],
    logDirty: true,
    lastProgressAt: now(),
    lastNodeKey: '',
    lastBadgeKey: '',
    modalKey: '',
    modalSince: 0,
    modalHandledAt: 0,
    unknownModal: '',
    lastEvoAt: 0,
    evoFail: 0,
    evoBefore: 0,
    lastTick: 0,
    lastTickAt: now(),
    lastActivityAt: now(),
    lastLogText: '',
    lastStartAt: 0,
    phase: -1,
    phaseAt: 0,
    phaseCatch: { 0: 0, 1: 0, 2: 0 },     // 本次会话各相位捕获数
    lastCatchAt: now(),
    lastCatchCount: -1,
    hiddenSince: 0,
    hiddenTotalMs: 0,
    prevTick: 0,
    keepAliveOn: null,
    berryAt: {},
    powerWarn: '',
    powerWarnAt: 0,
    speedPrev: null,
    speedAt: 0,            // 上次主动点击速度按钮的时间（冷却，防止 350ms 连点）
    deaths: null,
    deathStreak: 0,
    deathWarnAt: 0,
    switchAt: 0,
    speedRatio: null,
    berryIntentAt: 0,
    realDescs: null,
    lastTapAt: 0,
    evoIntentAt: 0,
    lastChoiceAt: 0,
    userAt: 0,
    eventKey: '',
    lastSaveAt: 0,
    lastNotifyKey: '',
    stalled: false,
    pausedByUser: false,
    lastEvoCount: null,
    lastDex: null,
    lastBackupAt: 0,
    restoring: false,
    // 离开战报用的累计计数（只增不减），战报 = 两个快照之差
    tally: { caught: 0, battles: 0, money: 0, evolutions: 0, dexNew: 0, berries: 0, deaths: 0, manual: 0, stalls: 0, shinies: [], badges: [], events: [] },
    bootSnap: null,
    awaySnap: null,
    awayLastSeen: 0,
    pushAt: {},            // 每类推送上次发送时间
    pushTimes: [],         // 最近一小时的推送时间，用于总量限流
    pushErrAt: 0,
  };

  function log(kind, msg) {
    S.events.unshift({ t: new Date().toLocaleTimeString('zh-CN', { hour12: false }), kind, msg });
    if (S.events.length > 80) S.events.pop();
    S.logDirty = true;
    if (S.cfg.logToConsole) console.log('[AutoFarm]', kind, msg);
    scheduleHud();
  }

  /* ====================== 声音 / 通知 ====================== */

  let sfxCtx = null;
  function beep(kind = 'info') {
    if (!S.cfg.sound) return;
    try {
      sfxCtx = sfxCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (sfxCtx.state === 'suspended') sfxCtx.resume();
      const t0 = sfxCtx.currentTime;
      const notes = kind === 'rare' ? [880, 1175, 1568] : kind === 'warn' ? [520, 392] : [740];
      notes.forEach((f, i) => {
        const o = sfxCtx.createOscillator(), g = sfxCtx.createGain();
        o.type = kind === 'rare' ? 'triangle' : 'sine';
        o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t0 + i * 0.13);
        g.gain.exponentialRampToValueAtTime(0.14, t0 + i * 0.13 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.13 + 0.12);
        o.connect(g).connect(sfxCtx.destination);
        o.start(t0 + i * 0.13); o.stop(t0 + i * 0.13 + 0.14);
      });
    } catch { /* 忽略 */ }
  }

  function notify(title, body, tag) {
    if (!S.cfg.notify) return;
    try {
      if (!('Notification' in window) || Notification.permission !== 'granted') return;
      const n = new Notification(title, { body, tag, silent: true });
      setTimeout(() => n.close(), 9000);
    } catch { /* 忽略 */ }
  }

  /* ====================== 模块：地图上的道具 / 化石选择 ====================== */

  function handleItemChoice() {
    const box = document.querySelector('.item-choice');
    if (!box) return false;
    if (document.querySelector('.modal')) return false;      // 有弹窗时先处理弹窗
    if (userBusy(1800)) return true;                          // 玩家自己在选
    if (now() - (S.lastChoiceAt || 0) < 900) return true;

    const items = $$('.ic-item', box);
    if (!items.length) return true;
    const picked = items.find((i) => i.classList.contains('on'));
    if (!picked) { S.lastChoiceAt = now(); fire(items[0]); return true; }

    const go = box.querySelector('.ic-go');
    if (go && !go.disabled) {
      S.lastChoiceAt = now();
      const label = go.textContent.trim();
      fire(go);
      log('info', '自动选择：' + label);
      S.lastProgressAt = now();
    }
    return true;
  }

  /* ====================== 模块：过场动画 ====================== */

  function handleCutscene() {
    const tap = document.querySelector('.rc-fx .rc-tap, .lk-fx .rc-tap, .cinema .rc-tap');
    if (!tap) return false;
    if (now() - (S.lastTapAt || 0) < 1500) return true;
    S.lastTapAt = now();
    fire(tap);
    S.lastProgressAt = now();
    return true;
  }

  /* ====================== 模块：自动开始游戏 ====================== */

  function ensureStarted() {
    const go = document.querySelector('.ti-go');
    if (go && go.offsetParent !== null) {
      if (now() - (S.lastStartAt || 0) > 6000) {
        S.lastStartAt = now();
        fire(go);
        log('info', '检测到标题画面，自动进入游戏');
        setTimeout(() => { S.lastProgressAt = now(); S.lastTickAt = now(); }, 1500);
      }
      return true;
    }
    return false;
  }

  /* ====================== 模块：速度 ====================== */

  /**
   * @param force 失败后的死磕模式会强制重设一次（忽略玩家让路窗口）
   * 冷却是必须的：这里靠 class 'on' 判断是否已选中，万一游戏改版换了选中态的表示方式，
   * 没有冷却就会变成每 350ms 点一次速度按钮，永不停歇。
   */
  function ensureSpeed(force = false) {
    if (!force && userBusy(8000)) return;   // 玩家刚动过界面，别抢着改速度
    if (now() - (S.speedAt || 0) < 3000) return;
    const btns = $$('#speed-btns button');
    if (!btns.length) return;
    const want = String(S.cfg.speed);
    const target = btns.find((b) => b.dataset.speed === want) || btns[btns.length - 1];
    if (target && !target.classList.contains('on')) {
      S.speedAt = now();
      fire(target);
    }
  }

  /* ====================== 模块：弹窗托管 ====================== */

  function findModal() {
    return $('#modal-root .modal') || $('.modal-root.open .modal') || $('body > .modal');
  }

  function pickContinue(modal) {
    return $$('button, .btn', modal).find((b) => {
      const t = b.textContent.trim();
      if (b.offsetParent === null || t.length > 14 || DENY.test(t)) return false;
      return /^(继续|太棒了|好的|明白了|知道了|OK|Okay|Continue|Continuer|Super|Génial|Bravo|Weiter|Continuar|계속|続ける|はい)[\s!！。.~～]*$/i.test(t);
    });
  }

  /**
   * 统一的「需要您亲自点一下」提醒。
   * 之前 DANGER 分支把 S.lastNotifyKey 当作「已处理」标记来用，结果和末尾的告警条件撞车，
   * 导致最需要提醒的那一类弹窗反而从不响铃。现在 lastNotifyKey 只负责通知去重。
   */
  function warnManual(m, sig, why, delay = 6000) {
    if (now() - S.modalSince < delay) return;   // 先留时间给玩家自己处理
    if (S.lastNotifyKey === sig) return;        // 同一个弹窗只提醒一次
    S.lastNotifyKey = sig;
    S.unknownModal = (m.innerText || '').trim().slice(0, 200) || '（无文字弹窗）';
    log('warn', `需要手动处理${why ? `（${why}）` : ''}：` + S.unknownModal.slice(0, 36));
    beep('warn');
    notify("Poke'Catch 需要一次点击", S.unknownModal.slice(0, 120), 'pcauto-modal');
    S.tally.manual++;
    pushSend('manual', "Poke'Catch 卡在弹窗", S.unknownModal.slice(0, 120));
    scheduleHud();
  }

  function handleModals() {
    const m = findModal();
    if (!m) {
      if (S.unknownModal) { S.unknownModal = ''; scheduleHud(); }
      S.modalKey = ''; S.modalSince = 0;
      return;
    }
    const sig = (m.className || '') + '|' + m.innerText.slice(0, 60);
    if (sig !== S.modalKey) { S.modalKey = sig; S.modalSince = now(); }
    if (now() - S.modalHandledAt < 700) return;  // 冷却，避免连点

    const cls = m.className || '';
    const text = m.innerText || '';

    // 0) 玩家正在操作（点开详情/翻背包）：一律不插手
    if (userBusy(2500)) {
      if (S.unknownModal) { S.unknownModal = ''; scheduleHud(); }
      return;
    }

    // 0.5) 不可逆操作 / 详情卡：绝不自动点击，但必须提醒您，否则挂机会静默卡死在这里
    if (DANGER.test(text)) {
      warnManual(m, sig, '含不可逆操作，需您亲自确认');
      return;
    }

    // 0.6) 树果替换确认（ot-dlg）：脚本发起的选「替换」；玩家自己点的给 10 秒，超时「保留」关闭防卡死
    if (/ot-dlg/.test(cls)) {
      const pickBtn = (re) => $$('button, .btn', m).find((b) => !b.disabled && re.test(b.textContent || ''));
      const swapBtn = pickBtn(/替换|Remplacer|Replace|Reemplazar|Ersetzen/i);
      const keepBtn = pickBtn(/保留|Garder|Keep|Mantener|Behalten/i);
      if (now() - (S.berryIntentAt || 0) < 10000 && swapBtn) {
        fire(swapBtn);
        S.modalHandledAt = now();
        S.lastProgressAt = now();
        log('item', '树果替换已确认');
        return;
      }
      if (keepBtn) {
        if (now() - (S.userAt || 0) < 10000) return;   // 玩家正在选，别抢
        fire(keepBtn);
        S.modalHandledAt = now();
        S.lastProgressAt = now();
        log('item', '树果替换弹窗已自动关闭（保留原增益）');
        return;
      }
      if (swapBtn) { fire(swapBtn); S.modalHandledAt = now(); return; }
      return;
    }

    // 1) 捕获图鉴卡 / 进化回顾卡：只有存在「继续」类按钮才关闭
    if (/dexcard-modal|oc-modal/.test(cls) && S.cfg.autoDex) {
      const btn = pickContinue(m);
      if (btn) { fire(btn); S.modalHandledAt = now(); S.lastProgressAt = now(); return; }
      // 玩家自己打开的详情/背包卡片：不乱点，但开着超过 20 秒说明是忘了关 —— 挂机已经停了，得提醒
      if (/mon-modal|bag-modal|evt-|sup-modal/.test(cls)) { warnManual(m, sig, '详情卡未关闭，挂机已暂停', 20000); return; }
      // 其余（如多标签提示 tab-modal）继续往下走通用规则
    }

    // 2) 礼物 / 单选类：先选一个再确认
    const picks = $$('.lk-slot.pick', m);
    if (picks.length && S.cfg.autoGift) {
      if (!picks.some((p) => p.classList.contains('on'))) { fire(picks[0]); S.modalHandledAt = now(); return; }
      const go = $$('.lk-go, .btn.primary, .btn.gold', m).find((b) => !b.disabled);
      if (go) { fire(go); S.modalHandledAt = now(); S.lastProgressAt = now(); return; }
    }

    // 2.4) 自己发起的树果替换确认：选「替换」
    if (now() - (S.berryIntentAt || 0) < 8000 && /Remplacer ta baie|替换|Replace your berry|Berry/i.test(text)) {
      const swapBtn = $$('button, .btn', m).find((b) => !b.disabled && /^\s*(替换|Remplacer|Replace|Reemplazar|Ersetzen)/i.test(b.textContent));
      if (swapBtn) { fire(swapBtn); S.modalHandledAt = now(); return; }
    }

    // 2.5) 自己发起的进化确认
    if (now() - (S.evoIntentAt || 0) < 5000) {
      const evoBtn = $$('button, .btn', m).find((b) => !b.disabled && /^\s*(进化|Évoluer|Evolve|Faire évoluer)/i.test(b.textContent));
      if (evoBtn) { fire(evoBtn); S.modalHandledAt = now(); S.lastProgressAt = now(); return; }
    }

    // 3) 普通确认弹窗（按钮 ≤ 3 且在安全名单）
    const btns = $$('button', m).filter((b) => b.offsetParent !== null && !b.disabled);
    const safe = btns.filter((b) => {
      const t = b.textContent.trim();
      return SAFE_EXACT.includes(t) && !DENY.test(t);
    });
    if (S.cfg.autoModal && safe.length && btns.length <= 3) {
      fire(safe[0]);
      S.modalHandledAt = now();
      S.lastProgressAt = now();
      return;
    }

    // 4) 无法识别：停留 6 秒后提醒
    warnManual(m, sig, '');
  }

  /* ====================== 模块：进化 ====================== */

  function maybeEvolve() {
    if (!S.cfg.autoEvo || userBusy(4000)) return;
    // evoFail 为 0 时基准间隔为 1 倍 evoEverySec，失败后按 1.8^n 指数退避。
    // 上限压到 4 次（约 5 分钟）：游戏不一定即时写盘，5 秒后的核对本身可能误判，
    // 退避到十几分钟会让一次误判就把自动进化沉睡掉。
    const mult = Math.pow(1.8, Math.min(4, S.evoFail || 0));
    const gap = Math.round(S.cfg.evoEverySec * 1000 * mult);
    if (now() - S.lastEvoAt < gap) return;

    const btn = $('#pc-evo-all');
    if (!btn || btn.disabled) return;
    const n = parseInt(((btn.textContent.match(/[（(]\s*(\d+)/) || btn.textContent.match(/(\d+)/) || [])[1]) || '0', 10);
    if (n <= 0) { S.evoFail = 0; return; }
    S.lastEvoAt = now();
    S.evoIntentAt = now();
    S.evoBefore = (S.save && S.save.stats && S.save.stats.evolutions) || 0;
    fire(btn);
    log('evo', `尝试进化 ×${n}`);
    // 5 秒后核对结果，连续失败则指数退避
    setTimeout(() => {
      try {
        const cur = readSave();
        const evo = (cur && cur.stats && cur.stats.evolutions) || 0;
        if (evo > (S.evoBefore || 0)) {
          S.evoFail = 0;
          log('evo', '进化成功');
        } else {
          S.evoFail = Math.min(4, (S.evoFail || 0) + 1);
          if (S.evoFail === 1) log('info', '暂无可进化（该种类已拥有），稍后再试');
        }
      } catch { /* 忽略 */ }
    }, 5000);
  }

  /* ====================== 模块：保存 ====================== */

  function maybeSave() {
    if (!S.cfg.autoSave) return;
    if (now() - S.lastSaveAt < S.cfg.saveEveryMin * 60000) return;
    const btn = $('#save-btn');
    if (btn) { S.lastSaveAt = now(); fire(btn); }
  }

  /* ====================== 模块：存档备份 ====================== */

  function hashStr(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36) + ':' + s.length;
  }
  function bakList() { const v = gmGet(BAK_INDEX, []); return Array.isArray(v) ? v : []; }

  function saveSummary(save) {
    const st = (save && save.stats) || {};
    return {
      dex: Object.keys((save && save.dex) || {}).length,
      caught: st.caught || 0,
      money: (save && save.money) || 0,
      chapter: ((save && save.adv && save.adv.chapter) || 0) + 1,
      mons: ((save && save.mons) || []).length,
    };
  }

  /** kind：auto（定时）/ manual（手动）/ pre（恢复前自动留底） */
  function backupNow(kind = 'auto') {
    if (!HAS_GM) return { ok: false, msg: '当前脚本管理器不支持 GM 存储' };
    const raw = readSaveRaw();
    const save = raw ? safeParse(raw, null) : null;
    if (!save) return { ok: false, msg: '读不到有效存档' };
    const hash = hashStr(raw);
    const list = bakList();
    if (kind === 'auto' && list.length && list[0].hash === hash) return { ok: false, same: true, msg: '存档没有变化' };
    const id = now().toString(36) + Math.random().toString(36).slice(2, 6);
    if (!gmSet(BAK_PREFIX + id, raw)) return { ok: false, msg: '写入失败（存储可能已满）' };
    list.unshift({ id, at: now(), kind, hash, size: raw.length, sum: saveSummary(save) });
    // 自动备份按 backupKeep 轮换；手动和恢复前备份另外最多留 5 份，互不挤占
    const keepAuto = clamp(S.cfg.backupKeep | 0, 1, 30);
    let autoN = 0, otherN = 0;
    const kept = [];
    for (const b of list) {
      const keep = b.kind === 'auto' ? ++autoN <= keepAuto : ++otherN <= 5;
      if (keep) kept.push(b); else gmDel(BAK_PREFIX + b.id);
    }
    gmSet(BAK_INDEX, kept);
    return { ok: true, msg: `已备份（${Math.round(raw.length / 1024)} KB）` };
  }

  function maybeBackup() {
    if (!S.cfg.backup || !HAS_GM || S.restoring) return;
    if (now() - S.lastBackupAt < clamp(S.cfg.backupEveryMin, 5, 720) * 60000) return;
    S.lastBackupAt = now();
    const r = backupNow('auto');
    if (!r.ok && !r.same) log('warn', '自动备份失败：' + r.msg);
  }

  function isGameSave(save) {
    return !!save && typeof save === 'object' && !Array.isArray(save) && ('mons' in save || 'adv' in save);
  }

  function restoreRaw(raw, label) {
    if (!HAS_GM) { log('warn', '当前脚本管理器不支持 GM 存储，无法恢复'); return; }
    const save = safeParse(raw, null);
    if (!isGameSave(save)) { log('warn', '恢复失败：内容不是 Poke\'Catch 存档'); return; }
    const s = saveSummary(save);
    if (!confirm(`确定要把存档恢复到「${label}」吗？\n\n该存档：第 ${s.chapter} 章 · 图鉴 ${s.dex} · 捕获 ${s.caught} · ₽${s.money}\n\n当前存档会先自动备份一份，然后页面会刷新。`)) return;
    const pre = backupNow('pre');
    if (!pre.ok && !confirm(`当前存档备份失败（${pre.msg}），仍要继续恢复吗？`)) return;
    if (!gmSet(RESTORE_KEY, { label, sum: s })) { log('warn', '恢复失败：无法写入油猴存储'); return; }
    S.restoring = true;
    S.pausedByUser = true;
    // 游戏在 beforeunload 里会把内存里的存档再写一遍；pagehide 在它之后触发，
    // 所以在这里写回备份，才不会被游戏盖掉
    addEventListener('pagehide', () => { lsSet(SAVE_KEY, raw); });
    location.reload();
  }

  function stamp(t) {
    const d = new Date(t), p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  }

  function downloadText(name, text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function importSaveFile() {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.json,application/json';
    inp.onchange = () => {
      const f = inp.files && inp.files[0];
      if (!f) return;
      if (f.size > 20 * 1024 * 1024) { log('warn', '导入失败：文件太大，不像存档'); return; }
      f.text().then((txt) => restoreRaw(txt, '文件 ' + f.name)).catch(() => log('warn', '导入失败：读不了文件'));
    };
    inp.click();
  }

  /* ====================== 模块：手机推送 ====================== */

  // 每类推送的冷却；闪光和徽章每次都推。另有总量上限：每小时最多 20 条
  const PUSH_COOLDOWN = { shiny: 0, badge: 0, event: 5 * 60000, stall: 10 * 60000, manual: 10 * 60000, death: 15 * 60000 };

  function pushSecret() {
    const v = gmGet(PUSH_SECRET_KEY, null);
    return v && typeof v === 'object' ? v : {};
  }

  /** 您不在电脑前：标签页在后台，或 5 分钟没有真实操作 */
  function userAway() { return isRealHidden() || now() - (S.userAt || 0) > 5 * 60000; }

  function httpBase(s, fallback) {
    try {
      const u = new URL(String(s || '').trim() || fallback);
      return /^https?:$/.test(u.protocol) ? u.origin + u.pathname.replace(/\/+$/, '') : null;
    } catch { return null; }
  }

  function buildPushReq(type, sec, title, body) {
    const json = { 'Content-Type': 'application/json' };
    if (type === 'bark') {
      const base = httpBase(sec.server, 'https://api.day.app');
      const key = String(sec.key || '').trim();
      if (!base || !/^[\w-]{6,}$/.test(key)) return null;
      return { url: base + '/push', headers: json, data: JSON.stringify({ device_key: key, title, body, group: "Poke'Catch" }) };
    }
    if (type === 'ntfy') {
      const base = httpBase(sec.server, 'https://ntfy.sh');
      const topic = String(sec.topic || '').trim();
      if (!base || !/^[\w-]{1,64}$/.test(topic)) return null;
      const headers = { ...json };
      const token = String(sec.token || '').trim();
      if (token) headers.Authorization = 'Bearer ' + token;
      // 用 JSON 方式发布：标题放在 HTTP 头里不支持中文
      return { url: base, headers, data: JSON.stringify({ topic, title, message: body }) };
    }
    if (type === 'telegram') {
      const token = String(sec.token || '').trim();
      const chat = String(sec.chat || '').trim();
      if (!/^\d+:[\w-]{20,}$/.test(token) || !/^(-?\d+|@\w{4,})$/.test(chat)) return null;
      return { url: `https://api.telegram.org/bot${token}/sendMessage`, headers: json, data: JSON.stringify({ chat_id: chat, text: `${title}\n${body}`, disable_web_page_preview: true }) };
    }
    return null;
  }

  /** 永不 reject。force=true 用于「发送测试」，跳过开关、冷却和离开判断 */
  function pushSend(kind, title, body, force = false) {
    return new Promise((resolve) => {
      const done = (ok, msg) => resolve({ ok, msg });
      if (!force) {
        if (!S.cfg.push || !S.cfg.pushEvents?.[kind]) return done(false, 'off');
        if (S.cfg.pushOnlyAway && !userAway()) return done(false, 'present');
        if (now() - (S.pushAt[kind] || 0) < (PUSH_COOLDOWN[kind] ?? 10 * 60000)) return done(false, 'cooldown');
        S.pushTimes = S.pushTimes.filter((t) => now() - t < 3600000);
        if (S.pushTimes.length >= 20) return done(false, 'rate');
      }
      if (typeof GM_xmlhttpRequest !== 'function') return done(false, '脚本管理器不支持 GM_xmlhttpRequest');
      const req = buildPushReq(S.cfg.pushType, pushSecret()[S.cfg.pushType] || {}, title, body);
      if (!req) return done(false, '推送配置不完整或格式不对');
      S.pushAt[kind] = now();
      S.pushTimes.push(now());
      // 报错信息里绝不带 URL：Telegram 的 URL 里有 token
      const fail = (why) => {
        if (force || now() - S.pushErrAt > 10 * 60000) { S.pushErrAt = now(); log('warn', '推送失败：' + why); }
        done(false, why);
      };
      try {
        GM_xmlhttpRequest({
          method: 'POST', url: req.url, headers: req.headers, data: req.data, timeout: 15000,
          onload: (r) => (r.status >= 200 && r.status < 300 ? done(true, 'ok') : fail('HTTP ' + r.status)),
          onerror: () => fail('网络错误'),
          ontimeout: () => fail('超时'),
        });
      } catch { fail('请求异常'); }
    });
  }

  /* ====================== 模块：离开战报 ====================== */

  function hiddenMsNow() { return S.hiddenTotalMs + (S.hiddenSince ? now() - S.hiddenSince : 0); }

  /** 往战报流水里记一件事（闪光、徽章、活动） */
  function tallyEvent(listKey, text) {
    const arr = S.tally[listKey];
    arr.push({ at: now(), text });
    if (arr.length > 100) arr.shift();
  }

  function tallySnap() {
    const t = S.tally;
    return {
      at: now(), hiddenMs: hiddenMsNow(), dexNew: t.dexNew,
      caught: t.caught, battles: t.battles, money: t.money, evolutions: t.evolutions,
      berries: t.berries, deaths: t.deaths, manual: t.manual, stalls: t.stalls,
    };
  }

  function reportSince(snap) {
    const c = tallySnap();
    const since = (k) => S.tally[k].filter((x) => x.at >= snap.at).map((x) => x.text);
    const d = (k) => Math.max(0, (c[k] || 0) - (snap[k] || 0));
    return {
      durMs: c.at - snap.at, hiddenMs: d('hiddenMs'), dex: d('dexNew'),
      caught: d('caught'), battles: d('battles'), money: d('money'), evolutions: d('evolutions'),
      berries: d('berries'), deaths: d('deaths'), manual: d('manual'), stalls: d('stalls'),
      shinies: since('shinies'), badges: since('badges'), events: since('events'),
    };
  }

  function fmtDur(ms) {
    const m = Math.round(ms / 60000);
    return m >= 60 ? `${Math.floor(m / 60)} 小时 ${m % 60} 分` : `${m} 分钟`;
  }

  function showReport(rep, title) {
    $('#pcauto-report')?.remove();
    const rows = [
      ['时长', fmtDur(rep.durMs)],
      rep.hiddenMs > 60000 && ['其中后台停摆', fmtDur(rep.hiddenMs), '#f87171'],
      ['捕获', fmt(rep.caught), '#8ee98e'],
      rep.dex && ['新图鉴', '+' + rep.dex, '#8ee98e'],
      ['战斗', fmt(rep.battles)],
      ['赚到', '₽ ' + fmt(rep.money), '#ffcb05'],
      rep.evolutions && ['进化', String(rep.evolutions)],
      rep.berries && ['吃树果', String(rep.berries)],
      rep.deaths && ['挑战失败', String(rep.deaths), '#f59e0b'],
      rep.manual && ['卡在弹窗等您处理', rep.manual + ' 次', '#f59e0b'],
      rep.stalls && ['停滞告警', rep.stalls + ' 次', '#f59e0b'],
    ].filter(Boolean);
    const list = (label, arr, color) => arr.length
        ? `<div style="margin-top:6px"><span style="color:#8b93a7">${label}</span><div style="color:${color};font-size:12px">${arr.slice(-12).map(esc).join('<br>')}${arr.length > 12 ? `<br>…共 ${arr.length} 条` : ''}</div></div>` : '';

    const box = document.createElement('div');
    box.id = 'pcauto-report';
    box.style.cssText = 'position:fixed;inset:0;z-index:2147483002;background:rgba(6,8,14,.6);display:flex;align-items:center;justify-content:center';
    box.innerHTML = `<div style="width:300px;max-height:80vh;overflow:auto;background:#12141c;border:1px solid rgba(255,203,5,.32);border-radius:14px;padding:14px 16px;color:#e8ecf4;font:13px/1.6 system-ui,-apple-system,'PingFang SC',sans-serif;box-shadow:0 24px 70px rgba(0,0,0,.65)">
      <b style="font-size:15px">${esc(title)}</b>
      <div style="margin-top:8px">${rows.map(([k, v, color]) => `<div style="display:flex;justify-content:space-between"><span style="color:#8b93a7">${k}</span><b style="color:${color || '#e8ecf4'}">${esc(v)}</b></div>`).join('')}</div>
      ${list('✨ 闪光', rep.shinies, '#f472b6')}
      ${list('🏅 徽章', rep.badges, '#ffcb05')}
      ${list('⚡ 活动', rep.events, '#93c5fd')}
      <button id="pcauto-report-ok" style="width:100%;margin-top:12px;padding:8px;border-radius:9px;border:0;background:#ffcb05;color:#12141c;font-weight:700;cursor:pointer">知道了</button>
    </div>`;
    document.documentElement.appendChild(box);
    $('#pcauto-report-ok', box).onclick = () => box.remove();
    box.onclick = (e) => { if (e.target === box) box.remove(); };
  }

  /** 您回到电脑前（真实操作或切回标签页）时调用 */
  function markPresent() {
    const t = now();
    if (t - S.awayLastSeen < 1000) return;   // 节流，避免每次按键都拍快照
    const gone = t - S.awayLastSeen;
    if (S.cfg.awayReport && S.awaySnap && S.awayLastSeen && gone >= clamp(S.cfg.awayMin, 1, 1440) * 60000) {
      const rep = reportSince(S.awaySnap);
      log('info', `离开 ${fmtDur(rep.durMs)}：捕获 ${rep.caught}，闪光 ${rep.shinies.length}，₽${fmt(rep.money)}`);
      showReport(rep, '离开期间战报');
    }
    S.awaySnap = tallySnap();
    S.awayLastSeen = t;
  }

  // 战报流水存在页面 localStorage：自动刷新后能接上。只接 10 分钟内的，避免关掉页面一晚后把旧数据当成新的
  function saveTally() {
    lsSet(TALLY_KEY, JSON.stringify({ at: now(), tally: S.tally, awaySnap: S.awaySnap, awayLastSeen: S.awayLastSeen }));
  }
  function loadTally() {
    const p = safeParse(lsGet(TALLY_KEY), null);
    if (!p || !p.tally || now() - (p.at || 0) > 10 * 60000) return;
    S.tally = { ...S.tally, ...p.tally };
    for (const k of ['shinies', 'badges', 'events']) if (!Array.isArray(S.tally[k])) S.tally[k] = [];
    S.awaySnap = p.awaySnap || null;
    S.awayLastSeen = p.awayLastSeen || 0;
  }

  /* ====================== 模块：采样统计 ====================== */

  function detectShiny(save) {
    const pool = [
      ...(save.mons || []),
      ...((save.pension && save.pension.mons) || []).map((p) => p && p.mon).filter(Boolean),
    ];
    const priming = !S.shinyPrimed;      // 本次会话第一次扫描
    let added = 0;
    for (const mon of pool) {
      if (!mon || !mon.shiny) continue;
      const key = String(mon.id) + ':' + String(mon.uid || '');
      if (S.shinyKeys.has(key)) continue;
      S.shinyKeys.add(key);
      added++;
      // 首轮只登记不通知：持久化记录有上限会被裁剪，否则老闪光会在重载后被当成新发现重报一遍
      if (priming) continue;
      S.shinySession++;
      const name = mon.name || ('No.' + mon.id);
      log('shiny', `✨ 闪光 ${name} Lv.${mon.level || '?'}`);
      beep('rare');
      notify('✨ 发现闪光宝可梦', `${name} Lv.${mon.level || '?'}`, 'pcauto-shiny');
      tallyEvent('shinies', `${new Date().toLocaleTimeString('zh-CN', { hour12: false })} ${name} Lv.${mon.level || '?'}`);
      pushSend('shiny', '✨ 发现闪光宝可梦', `${name} Lv.${mon.level || '?'}`);
    }
    S.shinyPrimed = true;
    // 写盘挪出循环：原先每发现一只就序列化整个集合一次
    if (added) lsSet(SHINY_KEY, JSON.stringify([...S.shinyKeys].slice(-4000)));
  }

  function applyRates(sample) {
    const w = S.win;
    if (w.length > 0) {
      const prev = w[w.length - 1];
      const dm = (sample.money || 0) - (prev.money || 0);
      if (dm > 0) S.sessionEarned += dm;
    }
    w.push(sample);
    // 窗口 300 个样本 × 2 秒 ≈ 10 分钟。原先 45 个样本只有 90 秒，外推出来的「每小时」抖动极大。
    while (w.length > 300) w.shift();
    const first = w[0];
    const spanH = Math.max(1 / 3600, (sample.at - first.at) / 3600000);

    // 修复：只累计相邻样本的正向增长，避免花钱消费导致极差虚高
    const posDelta = (key) => {
      let sum = 0;
      for (let i = 1; i < w.length; i++) {
        const diff = (w[i][key] || 0) - (w[i - 1][key] || 0);
        if (diff > 0) sum += diff;
      }
      return sum;
    };
    S.rate.catch = Math.round(posDelta('caught') / spanH);
    S.rate.battle = Math.round(posDelta('battles') / spanH);
    S.rate.money = Math.round(posDelta('money') / spanH);

    const b = S.baseline;
    if (b) {
      const h = Math.max(1 / 3600, (sample.at - b.at) / 3600000);
      S.avg.catch = Math.round((sample.caught - b.caught) / h);
      S.avg.battle = Math.round((sample.battles - b.battles) / h);
      S.avg.money = Math.round(S.sessionEarned / h);
    }
  }

  function sample() {
    const raw = readSaveRaw();
    if (!raw) {
      // 存档 key 写死在 SAVE_KEY，游戏一旦升版就会静默失效（HUD 全是 0 且毫无提示）
      if (!S.saveMissWarned && now() - S.bootAt > 30000) {
        S.saveMissWarned = true;
        log('warn', `读不到存档（${SAVE_KEY}），游戏可能更新了存档格式，统计与树果功能将不可用`);
      }
      return;
    }
    // 存档内容没变就不重新 parse：几百只宝可梦的存档每 2 秒全量 parse 一次是白烧 CPU
    if (raw !== S.saveRaw) {
      const parsed = safeParse(raw, null);
      if (!parsed) return;
      S.saveRaw = raw;
      S.save = parsed;
      detectShiny(parsed);
    }
    const save = S.save;
    if (!save) return;
    S.saveMissWarned = false;
    const st = save.stats || {};
    const point = {
      at: now(),
      caught: st.caught || 0,
      battles: st.battles || 0,
      money: save.money || 0,
      dex: Object.keys(save.dex || {}).length,
    };
    if (!S.baseline) S.baseline = { ...point };

    // 战报累计：只加相邻采样的正增量（花钱、恢复存档导致的减少不算）
    const prevPt = S.win[S.win.length - 1];
    const evoNow = st.evolutions || 0;
    if (prevPt) {
      const t = S.tally;
      t.caught += Math.max(0, point.caught - prevPt.caught);
      t.battles += Math.max(0, point.battles - prevPt.battles);
      t.money += Math.max(0, point.money - prevPt.money);
      if (S.lastEvoCount != null) t.evolutions += Math.max(0, evoNow - S.lastEvoCount);
    }
    S.lastEvoCount = evoNow;
    // 新图鉴按增量累计：快照里直接存图鉴总数的话，启动时还没采样，第一份战报会显示「新图鉴 +400」
    if (S.lastDex != null && point.dex > S.lastDex) S.tally.dexNew += point.dex - S.lastDex;
    if (S.lastDex == null || point.dex > S.lastDex) S.lastDex = point.dex;

    const adv = save.adv || {};
    // 用 lastTick 判断世界是否在推进（游戏每步都会刷新）
    if (save.lastTick && save.lastTick !== S.lastTick) {
      S.lastTick = save.lastTick;
      S.lastTickAt = now();
    }
    const nodeKey = `${adv.chapter || 0}:${adv.node || 0}`;
    if (nodeKey !== S.lastNodeKey) {
      if (S.lastNodeKey) S.lastProgressAt = now();
      S.lastNodeKey = nodeKey;
      S.stalled = false;
    }
    // 相位切换
    const ph = phaseInfo();
    if (ph.idx !== S.phase) {
      const prev = S.phase;
      S.phase = ph.idx;
      S.phaseAt = now();
      if (prev >= 0 && S.cfg.phaseNotify) {
        log('phase', `${ph.icon} 进入${ph.name}时段`);
        if (ph.idx === 2) {
          beep('rare');
          notify('🌙 夜晚开始', '夜间限定宝可梦开始出没（20:00–07:59）', 'pcauto-phase');
        } else if (ph.idx === 0) {
          beep('info');
          notify('🌅 早晨开始', '早晨时段：08:00–09:59', 'pcauto-phase');
        }
      }
    }

    // 后台停摆计时
    const realHidden = isRealHidden();
    if (realHidden && !S.hiddenSince) S.hiddenSince = now();
    if (!realHidden && S.hiddenSince) {
      const gapMs = now() - S.hiddenSince;
      S.hiddenTotalMs += gapMs;
      S.hiddenSince = 0;
      if (gapMs > 60000) {
        const mins = Math.round(gapMs / 60000);
        log('warn', `标签页在后台 ${mins} 分钟，游戏这期间是停摆的`);
      }
    }

    // 离线/补算检测：单次采样里 lastTick 突然前进
    if (S.prevTick && save.lastTick) {
      const jump = save.lastTick - S.prevTick;
      if (jump > 30000) {
        const mins = Math.round(jump / 60000);
        const p2 = phaseInfo();
        log('info', `补算了约 ${mins} 分钟（按 ${p2.icon}${p2.name} 的时段结算）`);
        if (mins >= 30) notify('离线补偿结算', `补算 ${mins} 分钟，按当前时段「${p2.name}」计算`, 'pcauto-catchup');
      }
    }
    if (save.lastTick) S.prevTick = save.lastTick;

    // 实际倍率：游戏内时间推进 / 真实时间（后台或卡顿时会明显低于 2.5）
    if (S.speedPrev && save.lastTick) {
      const dtReal = (point.at - S.speedPrev.at) / 1000;
      const dtGame = (save.lastTick - S.speedPrev.tick) / 1000;
      if (dtReal >= 1.5 && !S.hiddenSince && dtGame > 0.05) {
        const ratio = dtGame / dtReal;
        S.speedRatio = S.speedRatio == null ? ratio : S.speedRatio * 0.7 + ratio * 0.3;
      }
    }
    S.speedPrev = { at: point.at, tick: save.lastTick };

    // 分相位捕获统计
    if (S.lastCatchCount >= 0) {
      const d = point.caught - S.lastCatchCount;
      if (d > 0) {
        S.phaseCatch[ph.idx] = (S.phaseCatch[ph.idx] || 0) + d;
        S.lastCatchAt = now();
        S.lastProgressAt = now();
        S.evoFail = 0;      // 抓到新怪可能解锁了新的进化路线，解除进化退避
      }
    }
    S.lastCatchCount = point.caught;

    const badgeKey = (adv.badges || []).join(',');
    if (badgeKey !== S.lastBadgeKey) {
      if (S.lastBadgeKey) {
        const idx = (adv.badges || []).length;
        log('badge', `🏅 获得第 ${idx} 枚徽章`);
        beep('rare');
        notify('🏅 新徽章', `已获得 ${idx} 枚徽章`, 'pcauto-badge');
        tallyEvent('badges', `第 ${idx} 枚徽章`);
        pushSend('badge', '🏅 新徽章', `已获得 ${idx} 枚徽章`);
      }
      S.lastBadgeKey = badgeKey;
    }

    applyRates(point);
    deathWatch(save);
    watchEvent();
    scheduleHud();
  }

  /* ====================== 模块：活动 / 传说提醒 ====================== */

  function watchEvent() {
    const adv = (S.save && S.save.adv) || {};
    let key = '', label = '';
    if (adv.event) {
      key = 'event:' + (adv.event.id || '') + ':' + (adv.event.seq || '');
      label = (adv.event.raid ? '集体团体战' : '传说活动') + ' · No.' + (adv.event.id || '?');
    } else if (adv.zone) {
      key = 'zone:' + (adv.zone.id || '');
      label = '特殊区域 No.' + (adv.zone.foe || adv.zone.id || '?');
    }
    if (!key || key === S.eventKey) return;
    const first = !S.eventKey;
    S.eventKey = key;
    if (first) return;
    log('event', '⚡ ' + label);
    beep('rare');
    notify("⚡ 限时活动", label + ' 已开放，尽快前往', 'pcauto-event');
    tallyEvent('events', label);
    pushSend('event', '⚡ 限时活动', label + ' 已开放');
  }

  /* ====================== 模块：后台保活（实验） ====================== */


  function getDocDesc(name) {
    const W = PAGE_WIN;
    return (W.Document && Object.getOwnPropertyDescriptor(W.Document.prototype, name))
        || (W.HTMLDocument && Object.getOwnPropertyDescriptor(W.HTMLDocument.prototype, name))
        || Object.getOwnPropertyDescriptor(PAGE_DOC, name);
  }

  function ensureRealDescs() {
    if (!S.realDescs) {
      S.realDescs = { descH: getDocDesc('hidden'), descV: getDocDesc('visibilityState') };
    }
    return S.realDescs;
  }

  async function setKeepAlive(on) {
    if (on && !S.keepAliveOn) {
      ensureRealDescs();
      try {
        Object.defineProperty(PAGE_DOC, 'hidden', { configurable: true, get: () => false });
      } catch { /* 忽略 */ }
      try {
        Object.defineProperty(PAGE_DOC, 'visibilityState', { configurable: true, get: () => 'visible' });
      } catch { /* 忽略 */ }
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        const kaCtx = new AC();
        await kaCtx.resume();
        const osc = kaCtx.createOscillator();
        const gain = kaCtx.createGain();
        gain.gain.value = 0.0001;      // 近乎无声，仅用于让标签保持"有音频输出"
        osc.frequency.value = 55;
        osc.connect(gain).connect(kaCtx.destination);
        osc.start();
        S.keepAudio = { ac: kaCtx, osc };
      } catch { /* 无音频也可继续 */ }
      S.keepAliveOn = true;
      log('info', '后台保活已开启：解除了定时器节流，但 requestAnimationFrame 在后台仍会被浏览器完全停止');
    } else if (!on && S.keepAliveOn) {
      if (S.keepAudio) { try { S.keepAudio.osc.stop(); S.keepAudio.ac.close(); } catch { /* 忽略 */ } S.keepAudio = null; }
      if (S.realDescs?.descH) {
        try { Object.defineProperty(PAGE_DOC, 'hidden', { configurable: true, get: S.realDescs.descH.get }); } catch { /* 忽略 */ }
        try { Object.defineProperty(PAGE_DOC, 'visibilityState', { configurable: true, get: S.realDescs.descV.get }); } catch { /* 忽略 */ }
      }
      S.keepAliveOn = false;
      log('info', '后台保活已关闭');
    }
  }

  /* ====================== 模块：自动吃树果（维持增益） ====================== */

  function buffState(save) {
    const out = {};
    const now_ = now();
    for (const [family, b] of Object.entries(save.buffs || {})) {
      if (!b || !b.until) continue;
      const left = b.until - now_;
      if (left <= 0) continue;
      out[family] = { key: b.key, left, leftMin: Math.round(left / 60000) };
    }
    return out;
  }

  function useBerry(key) {
    // 背包格子在 #bag-panel 里，事件委托挂在 #bag-panel 上，隐藏状态也能触发
    const cell = document.querySelector(`#bag-panel .bag-cell[data-k="${key}"]`);
    if (!cell) return false;
    S.berryIntentAt = now();
    fire(cell);
    return true;
  }

  function autoBerry() {
    if (!S.cfg.autoBerry) return;
    if (userBusy(2000)) return;
    const openModal = document.querySelector('.modal');
    if (openModal && !/mon-modal|bag-modal/.test(openModal.className || '')) return;
    if (isRealHidden() && !S.keepAliveOn) return;

    const save = S.save;
    if (!save) return;
    const items = save.items || {};
    const buffs = buffState(save);
    const lead = Math.max(5, S.cfg.berryLeadMin) * 60000;
    const reserve = Math.max(0, S.cfg.berryReserve | 0);

    // 优先级：闪光 > 图鉴 > 稀有 > 捕获(高rank优先) > 经验 > 金钱
    const order = Object.keys(BERRY_BUFFS).sort((a, b) => BERRY_BUFFS[b].rank - BERRY_BUFFS[a].rank);
    for (const key of order) {
      const meta = BERRY_BUFFS[key];
      if (!S.cfg.berryFamilies?.[meta.family]) continue;
      const have = items[key] || 0;
      if (have <= reserve) continue;
      if (now() - (S.berryAt[key] || 0) < 60000) continue;      // 每种一分钟一次

      const cur = buffs[meta.family];
      if (cur && cur.left >= lead) continue;                     // 还够用
      // 同族已有更高 rank 的增益：一律不吃低阶（这是「替换你的树果？」弹窗的唯一来源）
      if (cur && cur.key !== key) {
        const curRank = BERRY_BUFFS[cur.key]?.rank || 0;
        if (curRank > meta.rank) continue;
      }
      // 快到叠加上限就别浪费
      if (cur && cur.key === key && cur.left + BUFF_MIN_MS > BUFF_STACK * BUFF_MIN_MS) continue;

      if (useBerry(key)) {
        S.berryAt[key] = now();
        log('item', `使用 ${key} → ${meta.label} ×${meta.mult}（剩 ${cur ? cur.leftMin : 0} 分钟）`);
        S.tally.berries++;
        return;
      }
    }
  }

  /* ====================== 模块：队伍战力与胜率 ====================== */

  function teamStats(save) {
    const team = (save.team || []).map((u) => (save.mons || []).find((m) => m.uid === u)).filter(Boolean);
    if (!team.length) return null;
    const lv = team.map((m) => m.level || 1);
    const avg = Math.round(lv.reduce((a, b) => a + b, 0) / lv.length);
    const alive = team.filter((m) => (m.hp == null || m.hp > 0)).length;
    const st = save.stats || {};
    const battles = st.battles || 0;
    const wins = st.wins || 0;
    const winRate = battles > 0 ? Math.round((wins / battles) * 100) : null;
    return { avg, min: Math.min(...lv), max: Math.max(...lv), alive, size: team.length, battles, wins, winRate };
  }

  /** teamStats 对每个队员都要 mons.find()，是 O(队伍×库存)；存档引用未变时复用结果 */
  function teamStatsCached() {
    if (S.teamCache && S.teamCache.src === S.save) return S.teamCache.val;
    const val = S.save ? teamStats(S.save) : null;
    S.teamCache = { src: S.save, val };
    return val;
  }

  function chapterBand() {
    const txt = ($('#chapter-btn .ac-lvl') || {}).textContent || '';
    const m = txt.match(/(\d+)\s*[–\-~]\s*(\d+)/);
    return m ? { lo: +m[1], hi: +m[2] } : null;
  }

  function speedGuard() {
    if (S.speedRatio == null) return;
    if (S.speedRatio >= 1.8) { S.slowWarnAt = 0; return; }
    if (now() - (S.slowWarnAt || 0) < 25 * 60000) return;
    S.slowWarnAt = now();
    const why = isRealHidden() ? '页面在后台' : '设备可能跟不上（战斗渲染卡顿）';
    log('warn', `实际倍率只有 ${S.speedRatio.toFixed(1)}x（目标 2.5x）：${why}`);
  }

  function powerGuard() {
    if (!S.cfg.powerGuard) return;
    const save = S.save;
    if (!save) return;
    const t = teamStatsCached();
    if (!t) return;
    const band = chapterBand();
    const lowHp = t.alive < t.size;
    let problem = '';
    const node = save.adv && save.adv.nodes && save.adv.nodes[save.adv.node];
    const isGym = node && node.type === 'gym';
    if (isGym && t.alive <= Math.ceil(t.size / 2)) problem = `即将开打道馆，但只有 ${t.alive}/${t.size} 只还能战斗`;
    else if (t.winRate != null && t.battles > 30 && t.winRate < 85) problem = `胜率偏低（${t.winRate}%，${t.battles - t.wins} 场翻车）`;
    else if (band && t.avg < band.lo - 1) problem = `队伍均级 ${t.avg} 低于本章建议 ${band.lo}–${band.hi}`;
    else if (lowHp && t.alive <= Math.ceil(t.size / 2)) problem = `队伍 ${t.size} 只里只有 ${t.alive} 只能战斗`;
    if (!problem) { S.powerWarn = ''; return; }
    if (now() - (S.powerWarnAt || 0) < 20 * 60000) return;
    S.powerWarnAt = now();
    S.powerWarn = problem;
    log('warn', '战力提示：' + problem);
    beep('warn');
    notify('对战状态提示', problem + '（可回退章节刷级或补血）', 'pcauto-power');
  }

  /* ====================== 操作：一键喂经验糖 ====================== */

  async function feedAllCandy() {
    if (S.feeding) return '正在执行中';
    const save = S.save || {};
    const allowRare = !!S.cfg.useRareCandy;
    const candyTotal = Object.entries(save.items || {})
        .filter(([k]) => (allowRare ? /-candy$/ : /^exp-candy-/).test(k))
        .reduce((a, [, v]) => a + v, 0);
    if (!candyTotal) return allowRare ? '没有经验糖' : '没有普通经验糖（已保护神奇糖果）';

    S.feeding = true;
    log('info', '正在一键喂糖（短暂切换至队伍界面）…');
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const gotoScreen = (key) => {
      if (!/^[a-z-]+$/.test(key)) return;
      const tab = document.querySelector(`#tabs button[data-screen="${key}"]`);
      if (tab) fire(tab);
    };
    // 记住您原本在哪一屏，结束后送回去，而不是一律丢到冒险页
    const prevId = (document.querySelector('.screen.active') || {}).id || '';
    const prevKey = prevId.replace(/^screen-/, '') || 'adventure';
    let fed = 0;
    try {
      gotoScreen('team');
      await sleep(800);
      const slots = [...document.querySelectorAll('#team-slots .slot.filled')];
      for (const slot of slots) {
        const rect = slot.getBoundingClientRect();
        if (!rect.width) continue;
        fire(slot);
        await sleep(650);
        const m = document.querySelector('.modal.mon-modal');
        if (!m) continue;
        // 糖果按钮顺序：exp-candy-s(0) / m(1) / xl(2) / big(3) / rare-candy(4)
        const btns = [...m.querySelectorAll('.dc-candy')];
        const order = allowRare ? [3, 2, 1, 0, 4] : [3, 2, 1, 0];
        let guard = 0;
        while (guard++ < 60) {
          const btn = order.map((i) => btns[i]).find((b) => b && !b.disabled);
          if (!btn) break;
          const qtyBefore = btn.querySelector('i')?.textContent;
          fire(btn);
          fed++;
          await sleep(500);
          const qtyAfter = btn.querySelector('i')?.textContent;
          if (qtyBefore === qtyAfter) break;   // 没吃掉就换下一只，避免死循环
        }
        const close = m.querySelector('.dc-x');
        if (close) fire(close);
        await sleep(350);
      }
    } catch { /* 忽略 */ }
    finally {
      gotoScreen(prevKey);
      S.feeding = false;
      S.lastProgressAt = now();
      S.lastActivityAt = now();
    }
    if (fed === 0) {
      return '没有可喂的目标（可能已达本章等级上限）';
    }
    return `共使用 ${fed} 颗`;
  }

  /* ====================== 模块：道馆 / 四天王死磕统计 ====================== */

  function deathWatch(save) {
    const deaths = (save.adv && save.adv.deaths) || {};
    const total = Object.values(deaths).reduce((a, b) => a + (b || 0), 0);
    if (S.deaths == null) { S.deaths = total; return; }
    if (total > S.deaths) {
      const d = total - S.deaths;
      S.deaths = total;
      S.deathStreak = (S.deathStreak || 0) + d;
      S.tally.deaths += d;
      log('warn', `挑战失败 ×${d}（累计 ${total} 次），已自动退回继续`);
      if (S.cfg.grindMode) {
        // 死磕模式：失败后确保继续跑（游戏本身会自动重走路线），这里只按「您配置的」速度重设一次。
        // 原先取 #speed-btns 的最后一个按钮，会把手动设的 ×1 强行拉到最快。
        ensureSpeed(true);
      }
    } else if (total < S.deaths) {
      S.deaths = total;
    }
    // 连续失败过多 → 战力告警
    if (S.deathStreak >= 3 && now() - (S.deathWarnAt || 0) > 15 * 60000) {
      S.deathWarnAt = now();
      log('warn', `已连续失败 ${S.deathStreak} 次，建议回退章节或补血`);
      notify('连败提醒', `连续 ${S.deathStreak} 次挑战失败，可能战力不足`, 'pcauto-death');
      pushSend('death', '连败提醒', `连续 ${S.deathStreak} 次挑战失败，可能战力不足`);
    }
    if (S.deathStreak && now() - (S.deathWarnAt || 0) > 30 * 60000) S.deathStreak = 0;
  }

  /* ====================== 模块：残血自动换人 ====================== */

  /**
   * 血条百分比。必须确认宽度确实是百分比单位：
   * 若游戏换成 px 宽度（如 "0px"），parseFloat 会得到一个很小的数，
   * 于是每只宝可梦都被当成残血，残血换人会每 4 秒抢一次操作。
   */
  function hpPct(row) {
    const bar = row && row.querySelector('.tr-hp i');
    const w = (bar && bar.style && bar.style.width) || '';
    if (!/%\s*$/.test(w)) return 100;      // 读不到百分比 → 视为健康，宁可不换人
    const v = parseFloat(w);
    return Number.isFinite(v) ? clamp(v, 0, 100) : 100;
  }

  function autoSwitch() {
    if (!S.cfg.autoSwitch) return;
    if (userBusy(3000) || S.feeding) return;
    if (now() - (S.switchAt || 0) < 4000) return;
    const rail = document.querySelector('#team-rail');
    if (!rail) return;
    const rows = [...rail.querySelectorAll('.tr-row')];
    if (rows.length < 2) return;
    const acting = rail.querySelector('.tr-row.acting');
    if (!acting) return;
    const curHp = hpPct(acting);
    if (curHp > (S.cfg.switchAtHp || 30)) return;          // 还没到危险线
    // 找一个健康的替补
    const bench = rows
        .filter((r) => r !== acting)
        .map((r) => ({ row: r, hp: hpPct(r) }))
        .filter((x) => x.hp > 55)
        .sort((a, b) => b.hp - a.hp)[0];
    if (!bench) return;
    S.switchAt = now();
    fire(bench.row);
    log('battle', `残血换人（${Math.round(curHp)}% → ${Math.round(bench.hp)}%）`);
  }

  /* ====================== 模块：游戏城无人值守 ====================== */

  function casinoAuto() {
    if (!S.cfg.casinoAuto) return;
    const scr = document.querySelector('#screen-casino');
    if (!scr || !scr.classList.contains('active')) return;      // 只在游戏城页面
    if (userBusy(2500)) return;
    const save = S.save || {};
    const money = save.money || 0;
    const floor = (S.cfg.casinoFloor ?? 50000);
    const auto = scr.querySelector('.cs-slots .cs-auto') || scr.querySelector('.cs-auto');
    if (!auto) return;
    const on = auto.classList.contains('on');

    // 金钱保护：低于阈值自动停
    if (money < floor) {
      if (on) { fire(auto); log('warn', `游戏城自动已关闭（金钱 ${money} < ${floor}）`); }
      return;
    }
    if (!on) { fire(auto); log('info', '游戏城自动模式已开启'); }
  }

  /* ====================== 模块：夜间守护 ====================== */

  function nightGuard() {
    if (!S.cfg.nightGuard || S.phase !== 2) return;
    if (now() - S.lastCatchAt < 12 * 60000) return;
    if (now() - (S.nightWarnedAt || 0) < 30 * 60000) return;
    S.nightWarnedAt = now();

    const save = S.save;
    const node = save?.adv?.nodes?.[save?.adv?.node];
    const indoor = nodeIndoor(node);
    const msg = indoor
        ? `当前是夜里，但场景「${node?.name || '室内'}」属于室内 —— 昼夜权重无效，夜间限定宝可梦不会出现`
        : '夜间已 12 分钟没有新捕获，检查窗口是否被切到后台或卡在弹窗';
    log('warn', msg);
    beep('warn');
    notify('🌙 夜间挂机检查', msg.slice(0, 110), 'pcauto-night');
  }

  /* ====================== 模块：停滞检测 ====================== */

  /**
   * 三路信号取「最近的那一个」（即 idle 取最小值）：
   *  - worldIdle：存档里的 lastTick 变化，取决于游戏多久写一次 localStorage
   *  - actIdle  ：#battle-log 文本变化，纯走路/捕获期间它根本不变
   *  - progIdle ：脚本自己确认的推进（关掉弹窗、点过场、选道具、换节点、抓到怪）
   * 前两路会在「游戏明明在跑」时同时静默，progIdle 是最可靠的一路，必须参与判定，
   * 否则 stallReload 会在一切正常时把页面刷掉。
   */
  function getIdleSec() {
    const t = now();
    const worldIdle = t - (S.lastTickAt || t);
    const actIdle = t - (S.lastActivityAt || t);
    const progIdle = t - (S.lastProgressAt || t);
    return Math.max(0, Math.round(Math.min(worldIdle, actIdle, progIdle) / 1000));
  }

  function stallCheck() {
    // 正在跑一键喂糖这类长任务：不算停滞
    if (S.feeding) { S.lastActivityAt = now(); S.lastProgressAt = now(); S.stalled = false; return; }
    // 玩家正在看面板/详情：不算停滞，也不报警
    if (userBusy(5000)) { S.lastActivityAt = now(); S.stalled = false; return; }
    const idle = getIdleSec();
    const limit = S.cfg.stallSec;
    if (idle > limit && !S.stalled) {
      S.stalled = true;
      const realHidden = isRealHidden();
      log('warn', realHidden ? '页面在后台：游戏已暂停，请切回标签页' : `已 ${idle} 秒无进展`);
      beep('warn');
      notify('挂机可能已停止', realHidden ? '标签页在后台，游戏会暂停' : '较长时间没有新进展', 'pcauto-stall');
      S.tally.stalls++;
      pushSend('stall', '挂机可能已停止', realHidden ? '标签页在后台，游戏已暂停' : `已 ${idle} 秒没有进展`);
      if (S.cfg.stallReload && !realHidden) {
        // 刷新前必须先存档：默认 5 分钟才自动保存一次，直接 reload 最坏会吃掉 5 分钟进度
        log('warn', '按设置：先保存存档，3 秒后自动刷新');
        const sb = $('#save-btn');
        if (sb) fire(sb);
        setTimeout(() => location.reload(), 3000);
      }
    }
    if (idle < 25) S.stalled = false;
  }

  /* ====================== HUD（局部更新改造） ====================== */

  let hud, hudBody, hudStats, hudLogs, hudPauseBtn, hudDot, hudTitle;

  /** 把保存的坐标夹回当前视口内 */
  function applyHudPos() {
    if (!hud || S.cfg.hudX == null) return;
    const x = clamp(S.cfg.hudX, 0, Math.max(0, innerWidth - 140));
    const y = clamp(S.cfg.hudY == null ? 64 : S.cfg.hudY, 0, Math.max(0, innerHeight - 60));
    hud.style.left = x + 'px';
    hud.style.top = y + 'px';
    hud.style.right = 'auto';
  }

  /** HUD 刷新节流：renderHud 会重建整块 innerHTML，日志和采样都会触发它 */
  let hudTimer = 0, hudRenderAt = 0;
  function scheduleHud() {
    if (!hud || hudTimer) return;
    const wait = Math.max(0, 900 - (now() - hudRenderAt));
    hudTimer = setTimeout(() => {
      hudTimer = 0;
      hudRenderAt = now();
      try { renderHud(); } catch { /* 忽略 */ }
    }, wait);
  }

  function buildHud() {
    hud = document.createElement('div');
    hud.id = 'pcauto-hud';
    hud.style.cssText =
        'position:fixed;z-index:2147483000;top:64px;right:14px;width:252px;' +
        'font:12px/1.45 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#e8ecf4;' +
        'background:rgba(18,20,28,.94);border:1px solid rgba(255,203,5,.32);border-radius:12px;' +
        'box-shadow:0 10px 30px rgba(0,0,0,.45);backdrop-filter:blur(8px);overflow:hidden;user-select:none;';

    hud.innerHTML = `
      <div id="pcauto-head" style="display:flex;align-items:center;gap:6px;padding:7px 9px;cursor:move;
           background:linear-gradient(90deg,rgba(255,203,5,.18),transparent);border-bottom:1px solid rgba(255,255,255,.06)">
        <span id="pcauto-dot" style="width:8px;height:8px;border-radius:50%;background:#4ade80;box-shadow:0 0 6px #4ade80;flex:none"></span>
        <b id="pcauto-title" style="font-size:12px;letter-spacing:.3px">挂机助手</b>
        <span style="flex:1"></span>
        <button id="pcauto-toggle" title="折叠/展开" style="all:unset;cursor:pointer;padding:0 4px;color:#9aa4b8">–</button>
        <button id="pcauto-gear" title="设置" style="all:unset;cursor:pointer;padding:0 4px;color:#9aa4b8">⚙</button>
      </div>
      <div id="pcauto-body" style="padding:8px 10px 9px">
        <div id="pcauto-stats"></div>
        <div style="height:1px;background:rgba(255,255,255,.07);margin:6px 0"></div>
        <div id="pcauto-logs" style="max-height:92px;overflow:auto;color:#9aa4b8;font-size:11px;line-height:1.55"></div>
        <div style="display:flex;gap:6px;margin-top:8px">
          <button id="pcauto-pause" style="flex:1;padding:5px;border-radius:7px;border:1px solid #2c3346;background:transparent;color:#9aa4b8;cursor:pointer;font-size:11px">暂停</button>
          <button id="pcauto-team" style="flex:1;padding:5px;border-radius:7px;border:1px solid rgba(255,203,5,.35);background:rgba(255,203,5,.1);color:#ffcb05;cursor:pointer;font-size:11px">配队</button>
          <button id="pcauto-diag" style="flex:1;padding:5px;border-radius:7px;border:1px solid #2c3346;background:transparent;color:#9aa4b8;cursor:pointer;font-size:11px">诊断</button>
        </div>
      </div>`;
    document.documentElement.appendChild(hud);

    hudBody = hud.querySelector('#pcauto-body');
    hudStats = hud.querySelector('#pcauto-stats');
    hudLogs = hud.querySelector('#pcauto-logs');
    hudPauseBtn = hud.querySelector('#pcauto-pause');
    hudDot = hud.querySelector('#pcauto-dot');
    hudTitle = hud.querySelector('#pcauto-title');

    // 存的是绝对坐标：换到小屏或缩小窗口后面板会跑到视口外，只能清 localStorage 才能找回来
    applyHudPos();
    if (S.cfg.hudCollapsed) hudBody.style.display = 'none';

    hud.querySelector('#pcauto-toggle').onclick = () => {
      S.cfg.hudCollapsed = !S.cfg.hudCollapsed;
      hudBody.style.display = S.cfg.hudCollapsed ? 'none' : 'block';
      writeCfg(S.cfg);
    };
    hud.querySelector('#pcauto-gear').onclick = openSettings;
    hudPauseBtn.onclick = () => { S.pausedByUser = !S.pausedByUser; renderHud(); };
    hud.querySelector('#pcauto-diag').onclick = dumpDiag;
    hud.querySelector('#pcauto-team').onclick = () => openTeamAdvisor();

    const head = hud.querySelector('#pcauto-head');
    let drag = null;
    head.addEventListener('pointerdown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      const r = hud.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      head.setPointerCapture?.(e.pointerId);
    });
    head.addEventListener('pointermove', (e) => {
      if (!drag) return;
      hud.style.left = clamp(e.clientX - drag.dx, 0, innerWidth - 140) + 'px';
      hud.style.top = clamp(e.clientY - drag.dy, 0, innerHeight - 60) + 'px';
      hud.style.right = 'auto';
    });
    // pointercancel 也要收尾，否则 drag 卡在非 null，之后鼠标一碰标题栏面板就跟着跑
    const endDrag = () => {
      if (!drag) return;
      drag = null;
      const r = hud.getBoundingClientRect();
      S.cfg.hudX = Math.round(r.left);
      S.cfg.hudY = Math.round(r.top);
      writeCfg(S.cfg);
    };
    head.addEventListener('pointerup', endDrag);
    head.addEventListener('pointercancel', endDrag);
    addEventListener('resize', applyHudPos);
  }

  function renderHud() {
    if (!hud) return;
    hudRenderAt = now();
    hud.style.display = S.cfg.hud ? '' : 'none';
    if (!S.cfg.hud) return;

    const save = S.save;
    const adv = (save && save.adv) || {};
    const dex = save ? Object.keys(save.dex || {}).length : 0;
    const dexCap = dex <= 151 ? 151 : dex <= 251 ? 251 : 493;
    const idle = getIdleSec();
    const running = S.cfg.enabled && !S.pausedByUser && idle < S.cfg.stallSec;
    const speedLabel = esc(($('#speed-btns .on') || {}).textContent || '—');

    hudDot.style.background = !S.cfg.enabled || S.pausedByUser ? '#64748b' : running ? '#4ade80' : '#f59e0b';
    hudDot.style.boxShadow = `0 0 6px ${hudDot.style.background}`;
    hudTitle.textContent = !S.cfg.enabled || S.pausedByUser ? '已暂停' : running ? '挂机中' : '疑似停滞';
    hudPauseBtn.textContent = S.pausedByUser ? '继续' : '暂停';

    const row = (k, v, color) =>
        `<div style="display:flex;justify-content:space-between;gap:8px"><span style="color:#8b93a7">${k}</span><b style="color:${color || '#e8ecf4'}">${v}</b></div>`;
    const sep = '<div style="height:1px;background:rgba(255,255,255,.07);margin:6px 0"></div>';

    const ph = phaseInfo();
    const realHidden = isRealHidden();
    const node = adv.nodes && adv.nodes[adv.node];
    const indoor = nodeIndoor(node);
    const hiddenMin = S.hiddenSince ? Math.round((now() - S.hiddenSince) / 60000) : 0;
    const phaseColor = ph.idx === 2 ? '#93c5fd' : ph.idx === 0 ? '#fcd34d' : '#ffcb05';

    hudStats.innerHTML = `
      <div style="display:flex;align-items:center;gap:6px;padding:2px 0 5px;border-bottom:1px solid rgba(255,255,255,.06);margin-bottom:5px">
        <span style="font-size:13px">${ph.icon}</span>
        <b style="color:${phaseColor}">${ph.name}</b>
        <span style="color:#6b7488;font-size:10.5px;white-space:nowrap">剩 ${ph.left}</span>
        <span style="flex:1"></span>
        <span title="${indoor ? '室内场景：昼夜权重不生效，夜间限定宝可梦不会出现' : '室外场景：昼夜权重生效'}"
              style="font-size:10.5px;white-space:nowrap;padding:1px 6px;border-radius:6px;background:${indoor ? 'rgba(148,163,184,.18)' : 'rgba(74,222,128,.15)'};color:${indoor ? '#94a3b8' : '#4ade80'}">${indoor ? '室内·昼夜无效' : '室外·昼夜生效'}</span>
      </div>
      ${realHidden ? (S.keepAliveOn ? `<div style="margin-bottom:6px;padding:5px 7px;border-radius:7px;background:rgba(245,158,11,.16);color:#fbbf24;font-size:11px;line-height:1.45">
        ⏱ 标签页在后台，保活已解除定时器节流。但 requestAnimationFrame 在后台会被浏览器完全停止，若游戏主循环用的是它，这里依然是停摆的 —— 请对照下面的「实际倍率」确认。</div>`
        : `<div style="margin-bottom:6px;padding:5px 7px;border-radius:7px;background:rgba(239,68,68,.16);color:#f87171;font-size:11px;line-height:1.45">
        ⚠ 标签页在后台${hiddenMin ? ` ${hiddenMin} 分钟` : ''}，游戏处于停摆状态。回到窗口才会用离线补偿结算（按回来时的时段）。</div>`) : ''}
      ${row('速度', `${speedLabel}${S.speedRatio != null ? ` · 实际 ${S.speedRatio.toFixed(1)}x` : ''}`, S.speedRatio != null && S.speedRatio < 1.8 ? '#f59e0b' : undefined)}
      ${row('进度', `${(adv.chapter || 0) + 1} 章 · ${esc(($('#tl-count') || {}).textContent || ((adv.node || 0) + 1))}`)}
      ${row('图鉴', `${dex} / ${dexCap}`)}
      ${row('队伍 · 库存', `${(save?.team || []).length} · ${(save?.mons || []).length}`)}
      ${sep}
      ${row('捕获 /时', `${fmt(S.rate.catch)}${S.avg.catch ? ` <span style="color:#6b7488;font-weight:400">均 ${fmt(S.avg.catch)}</span>` : ''}`, '#8ee98e')}
      ${row('战斗 /时', `${fmt(S.rate.battle)}${S.avg.battle ? ` <span style="color:#6b7488;font-weight:400">均 ${fmt(S.avg.battle)}</span>` : ''}`)}
      ${row('金钱 /时', `₽ ${fmt(S.rate.money)}${S.avg.money ? ` <span style="color:#6b7488;font-weight:400">均 ${fmt(S.avg.money)}</span>` : ''}`, '#ffcb05')}
      ${sep}
      ${(() => {
      const bfs = buffState(S.save || {});
      const icons = { shiny: '🌟', dex: '📖', rare: '✨', capture: '🎯', xp: '⭐', money: '💰' };
      const list = Object.values(bfs);
      if (!list.length) return row('增益', '无（有树果会自动用）', '#6b7488');
      return `<div style="display:flex;flex-wrap:wrap;gap:4px;padding:3px 0">${list.map((b) => {
        const meta = BERRY_BUFFS[b.key] || {};
        const soon = b.leftMin <= 5;
        return `<span title="${esc(b.key)} 剩余 ${b.leftMin} 分钟" style="font-size:10.5px;padding:1px 5px;border-radius:5px;background:${soon ? 'rgba(245,158,11,.18)' : 'rgba(255,255,255,.07)'};color:${soon ? '#fbbf24' : '#c7d0e0'}">${icons[meta.family] || '•'}${esc(meta.label || b.key)}×${meta.mult || ''} ${b.leftMin}m</span>`;
      }).join('')}</div>`;
    })()}
      ${(() => {
      const t = teamStatsCached();
      if (!t) return '';
      const band = chapterBand();
      const bad = (t.winRate != null && t.winRate < 85) || (band && t.avg < band.lo - 1);
      return row('战力', `均级 ${t.avg} · 存活 ${t.alive}/${t.size}${t.winRate != null ? ` · 胜率 ${t.winRate}%` : ''}`, bad ? '#f59e0b' : undefined);
    })()}
      ${S.powerWarn ? `<div style="margin-top:4px;padding:5px 7px;border-radius:7px;background:rgba(245,158,11,.13);color:#fbbf24;font-size:11px">⚔ ${esc(S.powerWarn)}</div>` : ''}
      ${row('挑战失败', `${S.deaths ?? 0} 次${S.deathStreak ? `（连败 ${S.deathStreak}）` : ''}`, S.deathStreak >= 3 ? '#f59e0b' : undefined)}
      ${row('闪光', String(S.shinySession), S.shinySession ? '#f472b6' : undefined)}
      ${row('夜间捕获', String(S.phaseCatch[2] || 0), (ph.idx === 2 && !(S.phaseCatch[2] > 0)) ? '#f59e0b' : '#93c5fd')}
      ${row('无进展', idle + ' 秒', idle > 90 ? '#f59e0b' : undefined)}
      ${row('运行', ((now() - S.bootAt) / 60000).toFixed(0) + ' 分钟')}
      ${S.unknownModal ? `<div style="margin-top:6px;padding:6px;border-radius:8px;background:rgba(245,158,11,.13);color:#fbbf24;font-size:11px">需手动点击：${esc(S.unknownModal.slice(0, 64))}</div>` : ''}`;

    if (S.logDirty) {
      S.logDirty = false;
      hudLogs.innerHTML = S.events.slice(0, 20).map((e) => `<div><span style="color:#5b6478">${e.t}</span> ${esc(e.msg)}</div>`).join('') || '<div>等待事件…</div>';
    }
  }

  function dumpDiag() {
    const save = S.save || {};
    const adv = save.adv || {};
    const ph = phaseInfo();
    const node = save.adv && save.adv.nodes && save.adv.nodes[save.adv.node];
    const info = {
      version: VERSION,
      href: location.href,
      phase: `${ph.icon} ${ph.name}（剩 ${ph.left}）`,
      scene: node ? `${node.name} · bg=${node.bg} · ${nodeIndoor(node) ? '室内（昼夜无效）' : '室外（昼夜生效）'}` : '未知',
      hidden: isRealHidden(),
      hiddenTotalMin: Math.round(S.hiddenTotalMs / 60000),
      phaseCatch: S.phaseCatch,
      keepAlive: !!S.keepAliveOn,
      speedBtn: ($('#speed-btns .on') || {}).textContent,
      chapter: adv.chapter, node: adv.node, pending: adv.pending && adv.pending.type,
      badges: (adv.badges || []).length,
      dex: Object.keys(save.dex || {}).length,
      mons: (save.mons || []).length,
      modal: S.unknownModal || null,
      rates: S.rate,
      idleSec: getIdleSec(),
    };
    const text = JSON.stringify(info, null, 2);
    const fallback = () => log('info', '诊断：' + text.replace(/\s+/g, ' ').slice(0, 120));
    try {
      // writeText 返回 Promise，光靠 try/catch 接不住被拒绝的情况（无权限 / 非安全上下文）
      const p = navigator.clipboard?.writeText(text);
      if (p && typeof p.then === 'function') {
        p.then(() => log('info', '诊断信息已复制到剪贴板')).catch(fallback);
      } else {
        fallback();
      }
    } catch {
      fallback();
    }
  }

  /* ====================== 设置面板 ====================== */

  function openSettings() {
    const old = $('#pcauto-settings');
    if (old) { old.remove(); return; }

    const box = document.createElement('div');
    box.id = 'pcauto-settings';
    box.style.cssText = 'position:fixed;inset:0;z-index:2147483001;background:rgba(6,8,14,.72);display:flex;align-items:center;justify-content:center;backdrop-filter:blur(3px)';
    const chk = (k, label) => `<label style="display:flex;align-items:center;gap:8px;padding:6px 0;cursor:pointer">
        <input type="checkbox" data-k="${k}" ${S.cfg[k] ? 'checked' : ''} style="accent-color:#ffcb05;width:15px;height:15px">
        <span>${label}</span></label>`;
    const num = (k, label, min = 5, max = 900, step = 1) => `<label style="display:flex;align-items:center;gap:8px;padding:6px 0;justify-content:space-between">
        <span>${label}</span>
        <input type="number" data-k="${k}" value="${S.cfg[k]}" min="${min}" max="${max}" step="${step}" style="width:86px;background:#1b2030;color:#e8ecf4;border:1px solid #2c3346;border-radius:6px;padding:3px 6px"></label>`;
    const group = (t) => `<div style="color:#8b93a7;font-size:11px;letter-spacing:.5px;margin:12px 0 2px">${t}</div>`;
    const smallBtn = 'flex:1;padding:5px 6px;border-radius:7px;border:1px solid #2c3346;background:transparent;color:#c7d0e0;cursor:pointer;font-size:11.5px';

    box.innerHTML = `<div style="width:352px;max-height:84vh;overflow:auto;background:#12141c;border:1px solid rgba(255,203,5,.28);border-radius:14px;padding:16px 18px;color:#e8ecf4;font:13px/1.5 system-ui,-apple-system,'PingFang SC',sans-serif;box-shadow:0 24px 70px rgba(0,0,0,.65)">
      <div style="display:flex;align-items:center;margin-bottom:4px">
        <b style="font-size:15px">挂机助手</b>
        <span style="flex:1"></span>
        <span style="color:#5b6478;font-size:11px">v${VERSION}</span>
      </div>
      <div style="color:#6b7488;font-size:11px;margin-bottom:6px">Poke'Catch AutoFarm · 配置自动保存</div>

      ${group('总控')}
      ${chk('enabled', '启用自动化')}
      <label style="display:flex;align-items:center;gap:8px;padding:6px 0;justify-content:space-between">
        <span>战斗速度</span>
        <select data-k="speed" style="background:#1b2030;color:#e8ecf4;border:1px solid #2c3346;border-radius:6px;padding:3px 6px">
          <option value="1" ${S.cfg.speed == 1 ? 'selected' : ''}>×1 原速</option>
          <option value="2" ${S.cfg.speed == 2 ? 'selected' : ''}>×2 加速</option>
          <option value="4" ${S.cfg.speed == 4 ? 'selected' : ''}>×3 最快（推荐）</option>
        </select></label>

      ${group('弹窗托管')}
      ${chk('autoDex', '自动关闭捕获图鉴卡')}
      ${chk('autoModal', '自动确认提示类弹窗')}
      ${chk('autoGift', '自动选择礼物 / 单选')}

      ${group('收益优化')}
      ${chk('autoEvo', '自动进化')}
      ${num('evoEverySec', '进化检查间隔（秒）', 5, 600, 5)}
      ${chk('autoSave', '定期保存存档')}
      ${num('saveEveryMin', '保存间隔（分钟）', 1, 120, 1)}

      ${group('昼夜与挂机连续性')}
      ${chk('phaseNotify', '昼夜时段切换提醒（夜间限定怪）')}
      ${chk('nightGuard', '夜间长时间零捕获告警（含室内判定）')}
      ${chk('keepAlive', '后台保活（实验：切走标签页仍继续挂机）')}

      ${group('消耗品自动化')}
      ${chk('autoBerry', '自动吃树果（维持增益）')}
      ${num('berryLeadMin', '剩余不足多少分钟补一颗', 5, 180, 5)}
      ${num('berryReserve', '每种保留几颗不吃', 0, 99, 1)}
      <div style="display:flex;flex-wrap:wrap;gap:8px;padding:4px 0" id="pcauto-berry-fam"></div>
      ${chk('useRareCandy', '一键喂糖包含神奇糖果（Rare Candy）')}
      ${chk('powerGuard', '战力 / 胜率告警')}
      ${chk('teamAdvisor', '配队建议提醒（队伍明显落后时日志提示）')}

      ${group('对战辅助')}
      ${chk('grindMode', '道馆 / 四天王死磕（失败后自动继续）')}
      ${chk('autoSwitch', '残血自动换人（会覆盖手动操作）')}
      ${num('switchAtHp', '血量低于多少 % 换人', 5, 90, 5)}

      ${group('多玩法')}
      ${chk('casinoAuto', '游戏城：进入后自动挂老虎机（消耗金钱）')}
      ${num('casinoFloor', '金钱低于多少 ₽ 停手', 0, 100000000, 1000)}

      ${group('界面增强')}
      ${chk('showGrades', '队伍 / PC 显示 S/A/B/C 评分角标')}

      ${group('提醒与保护')}
      ${chk('notify', '桌面通知（闪光 / 停滞）')}
      ${chk('sound', '提示音')}
      ${chk('wakeLock', '保持屏幕常亮')}
      ${chk('stallReload', '长时间停滞自动刷新')}
      ${num('stallSec', '判定停滞（秒）', 15, 1800, 5)}

      ${group('存档备份')}
      ${HAS_GM ? '' : '<div style="color:#f87171;font-size:11px">当前脚本管理器不支持 GM 存储，备份不可用</div>'}
      ${chk('backup', '定期自动备份存档')}
      ${num('backupEveryMin', '备份间隔（分钟）', 5, 720, 5)}
      ${num('backupKeep', '自动备份保留几份', 1, 30, 1)}
      <div style="display:flex;gap:6px;padding:4px 0">
        <button id="pcauto-bak-now" style="${smallBtn}">立即备份</button>
        <button id="pcauto-bak-export" style="${smallBtn}">导出当前存档</button>
        <button id="pcauto-bak-import" style="${smallBtn}">从文件恢复</button>
      </div>
      <div id="pcauto-bak-list" style="font-size:11.5px"></div>

      ${group('离开战报')}
      ${chk('awayReport', '回到电脑前时弹出离开期间战报')}
      ${num('awayMin', '离开超过多少分钟才弹', 1, 1440, 1)}
      <div style="display:flex;gap:6px;padding:4px 0">
        <button id="pcauto-rep-session" style="${smallBtn}">查看本次会话战报</button>
      </div>

      ${group('手机推送')}
      ${chk('push', '启用手机推送')}
      ${chk('pushOnlyAway', '只在我不在电脑前时推送（后台或 5 分钟没操作）')}
      <label style="display:flex;align-items:center;gap:8px;padding:6px 0;justify-content:space-between">
        <span>推送服务</span>
        <select data-k="pushType" style="background:#1b2030;color:#e8ecf4;border:1px solid #2c3346;border-radius:6px;padding:3px 6px">
          <option value="ntfy" ${S.cfg.pushType === 'ntfy' ? 'selected' : ''}>ntfy</option>
          <option value="bark" ${S.cfg.pushType === 'bark' ? 'selected' : ''}>Bark（iOS）</option>
          <option value="telegram" ${S.cfg.pushType === 'telegram' ? 'selected' : ''}>Telegram</option>
        </select></label>
      <div id="pcauto-push-fields"></div>
      <div style="display:flex;flex-wrap:wrap;gap:8px;padding:4px 0" id="pcauto-push-ev"></div>
      <div style="display:flex;gap:6px;padding:4px 0">
        <button id="pcauto-push-save" style="${smallBtn}">保存推送配置</button>
        <button id="pcauto-push-test" style="${smallBtn}">发送测试</button>
      </div>
      <div style="color:#5b6478;font-size:11px;line-height:1.5">推送地址和密钥只存在油猴存储里，游戏页面读不到，也不会出现在日志和诊断信息中。</div>

      <div style="display:flex;gap:8px;margin-top:14px">
        <button id="pcauto-feed" style="flex:1;padding:9px;border-radius:9px;border:1px solid #2c3346;background:transparent;color:#c7d0e0;cursor:pointer">一键喂经验糖</button>
      </div>

      <div style="display:flex;gap:8px;margin-top:10px">
        <button id="pcauto-close" style="flex:1;padding:9px;border-radius:9px;border:0;background:#ffcb05;color:#12141c;font-weight:700;cursor:pointer">完成</button>
        <button id="pcauto-reset" style="padding:9px 12px;border-radius:9px;border:1px solid #2c3346;background:transparent;color:#9aa4b8;cursor:pointer">恢复默认</button>
      </div>
      <div style="margin-top:10px;color:#5b6478;font-size:11px;line-height:1.5">提示：请让游戏标签页保持在前台（可用「保持屏幕常亮」），后台标签会被浏览器挂起导致挂机中断。</div>
    </div>`;

    document.documentElement.appendChild(box);

    const famBox = box.querySelector('#pcauto-berry-fam');
    if (famBox) {
      const fams = [['shiny', '闪光 🌟'], ['dex', '图鉴 📖'], ['rare', '稀有 ✨'], ['capture', '捕获 🎯'], ['xp', '经验 ⭐'], ['money', '金钱 💰']];
      famBox.innerHTML = fams.map(([k, label]) =>
          `<label style="display:flex;align-items:center;gap:4px;font-size:12px;color:#c7d0e0;cursor:pointer"><input type="checkbox" data-fam="${k}" ${S.cfg.berryFamilies?.[k] ? 'checked' : ''} style="accent-color:#ffcb05">${label}</label>`).join('');
      famBox.querySelectorAll('input[data-fam]').forEach((el) => {
        el.onchange = () => {
          S.cfg.berryFamilies = S.cfg.berryFamilies || {};
          S.cfg.berryFamilies[el.dataset.fam] = el.checked;
          writeCfg(S.cfg);
        };
      });
    }

    // 修复：仅绑定带有 data-k 的复选框，避免覆盖 data-fam
    $$('input[type=checkbox][data-k]', box).forEach((el) => {
      el.onchange = () => {
        S.cfg[el.dataset.k] = el.checked;
        writeCfg(S.cfg);
        if (el.dataset.k === 'keepAlive') setKeepAlive(el.checked);
        if (el.dataset.k === 'showGrades' && el.checked) paintBadges();
        if (el.dataset.k === 'notify' && el.checked && Notification.permission === 'default') Notification.requestPermission?.();
        renderHud();
      };
    });

    // 修复：按每个数值输入框各自的 min/max 边界进行 clamp
    $$('input[type=number][data-k]', box).forEach((el) => {
      el.onchange = () => {
        const k = el.dataset.k;
        const min = el.min !== '' ? +el.min : 0;
        const max = el.max !== '' ? +el.max : 1e9;
        const val = Number(el.value);
        S.cfg[k] = clamp(Number.isFinite(val) ? val : min, min, max);
        el.value = S.cfg[k];
        writeCfg(S.cfg);
      };
    });

    $$('select[data-k]', box).forEach((el) => {
      el.onchange = () => {
        const k = el.dataset.k;
        // pushType 是字符串；原来一律转数字，会把它变成 NaN
        S.cfg[k] = k === 'pushType' ? el.value : +el.value;
        writeCfg(S.cfg);
        if (k === 'pushType') renderPushFields();
      };
    });

    /* ---- 存档备份 ---- */
    const bakBox = $('#pcauto-bak-list', box);
    const kindName = { auto: '自动', manual: '手动', pre: '恢复前' };
    function renderBakList() {
      if (!bakBox) return;
      const list = bakList();
      if (!list.length) { bakBox.innerHTML = '<div style="color:#6b7488">还没有备份</div>'; return; }
      bakBox.innerHTML = list.map((b) => {
        const s = b.sum || {};
        return `<div style="display:flex;align-items:center;gap:6px;padding:3px 0;border-bottom:1px solid rgba(255,255,255,.05)">
          <span style="flex:1;color:#c7d0e0">${esc(new Date(b.at).toLocaleString('zh-CN', { hour12: false }))}
            <span style="color:#6b7488">· ${esc(kindName[b.kind] || b.kind)} · 第${esc(s.chapter ?? '?')}章 图鉴${esc(s.dex ?? '?')}</span></span>
          <button data-bak-restore="${esc(b.id)}" style="all:unset;cursor:pointer;color:#ffcb05;padding:0 3px">恢复</button>
          <button data-bak-dl="${esc(b.id)}" style="all:unset;cursor:pointer;color:#9aa4b8;padding:0 3px">下载</button>
        </div>`;
      }).join('');
      $$('[data-bak-restore]', bakBox).forEach((el) => {
        el.onclick = () => {
          const b = bakList().find((x) => x.id === el.dataset.bakRestore);
          const raw = b && gmGet(BAK_PREFIX + b.id, null);
          if (!raw) { log('warn', '这份备份的数据丢失了'); return; }
          restoreRaw(raw, new Date(b.at).toLocaleString('zh-CN', { hour12: false }) + ' 的备份');
        };
      });
      $$('[data-bak-dl]', bakBox).forEach((el) => {
        el.onclick = () => {
          const b = bakList().find((x) => x.id === el.dataset.bakDl);
          const raw = b && gmGet(BAK_PREFIX + b.id, null);
          if (raw) downloadText(`pokecatch-backup-${stamp(b.at)}.json`, raw);
        };
      });
    }
    renderBakList();
    $('#pcauto-bak-now', box).onclick = () => {
      const r = backupNow('manual');
      log(r.ok ? 'info' : 'warn', (r.ok ? '' : '备份失败：') + r.msg);
      renderBakList();
    };
    $('#pcauto-bak-export', box).onclick = () => {
      const raw = readSaveRaw();
      if (!raw) { log('warn', '读不到存档，无法导出'); return; }
      downloadText(`pokecatch-save-${stamp(now())}.json`, raw);
    };
    $('#pcauto-bak-import', box).onclick = importSaveFile;

    /* ---- 离开战报 ---- */
    $('#pcauto-rep-session', box).onclick = () => {
      box.remove();
      showReport(reportSince(S.bootSnap || tallySnap()), '本次会话战报');
    };

    /* ---- 手机推送 ---- */
    const PUSH_FIELDS = {
      ntfy: [['server', '服务器（留空用 ntfy.sh）', 'text', 'https://ntfy.sh'], ['topic', '主题 topic', 'text', '起一个别人猜不到的名字'], ['token', '访问令牌（可选）', 'password', '']],
      bark: [['server', '服务器（留空用官方）', 'text', 'https://api.day.app'], ['key', '设备 Key', 'password', 'Bark App 里显示的那串']],
      telegram: [['token', 'Bot Token', 'password', '123456:ABC...'], ['chat', 'Chat ID', 'text', '数字 ID 或 @频道名']],
    };
    function renderPushFields() {
      const wrap = $('#pcauto-push-fields', box);
      if (!wrap) return;
      const type = S.cfg.pushType;
      const sec = pushSecret()[type] || {};
      wrap.innerHTML = (PUSH_FIELDS[type] || []).map(([k, label, inputType, ph]) =>
          `<label style="display:flex;align-items:center;gap:8px;padding:4px 0;justify-content:space-between">
          <span style="white-space:nowrap">${esc(label)}</span>
          <input data-sec="${k}" type="${inputType}" value="${esc(sec[k] || '')}" placeholder="${esc(ph)}" autocomplete="off"
            style="width:170px;background:#1b2030;color:#e8ecf4;border:1px solid #2c3346;border-radius:6px;padding:3px 6px"></label>`).join('');
    }
    renderPushFields();
    const evBox = $('#pcauto-push-ev', box);
    if (evBox) {
      const evs = [['shiny', '闪光'], ['event', '限时活动'], ['stall', '停滞'], ['manual', '卡弹窗'], ['badge', '徽章'], ['death', '连败']];
      evBox.innerHTML = evs.map(([k, label]) =>
          `<label style="display:flex;align-items:center;gap:4px;font-size:12px;color:#c7d0e0;cursor:pointer"><input type="checkbox" data-pev="${k}" ${S.cfg.pushEvents?.[k] ? 'checked' : ''} style="accent-color:#ffcb05">${label}</label>`).join('');
      $$('input[data-pev]', evBox).forEach((el) => {
        el.onchange = () => {
          S.cfg.pushEvents = { ...(S.cfg.pushEvents || {}), [el.dataset.pev]: el.checked };
          writeCfg(S.cfg);
        };
      });
    }
    function savePushFields() {
      const all = pushSecret();
      const cur = {};
      $$('#pcauto-push-fields input[data-sec]', box).forEach((el) => { cur[el.dataset.sec] = el.value.trim(); });
      all[S.cfg.pushType] = cur;
      return gmSet(PUSH_SECRET_KEY, all);
    }
    $('#pcauto-push-save', box).onclick = () => {
      const ok = savePushFields();
      log(ok ? 'info' : 'warn', ok ? '推送配置已保存' : '推送配置保存失败（GM 存储不可用）');
    };
    $('#pcauto-push-test', box).onclick = async () => {
      savePushFields();
      const r = await pushSend('test', "Poke'Catch 推送测试", '收到这条说明推送配置正确 ✅', true);
      log(r.ok ? 'info' : 'warn', r.ok ? '测试推送已发送，请看手机' : '测试推送失败：' + r.msg);
    };

    const feedBtn = $('#pcauto-feed', box);
    if (feedBtn) feedBtn.onclick = async () => {
      box.remove();
      const r = await feedAllCandy();
      log('item', '喂糖结果：' + r);
    };
    $('#pcauto-close', box).onclick = () => box.remove();
    $('#pcauto-reset', box).onclick = () => {
      S.cfg = defaultCfg();
      writeCfg(S.cfg);
      box.remove();
      log('info', '已恢复默认设置');
    };
    box.onclick = (e) => { if (e.target === box) box.remove(); };
  }

  /* ====================== 主循环 ====================== */

  let wakeLock = null;
  async function requestWakeLock() {
    if (!S.cfg.wakeLock || isRealHidden()) return;
    try {
      if ('wakeLock' in navigator && !wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        // 系统可能主动释放（息屏、切应用）；置空后由 visibilitychange / 下一次检查重新申请
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      }
    } catch { /* 忽略 */ }
  }

  /** 玩家最近是否在真实操作（合成事件 isTrusted=false，不会误判） */
  function userBusy(ms = 2500) {
    return now() - (S.userAt || 0) < ms;
  }

  function touchActivity() {
    const el = document.querySelector('#battle-log');
    const txt = el ? el.innerText : '';
    if (txt && txt !== S.lastLogText) {
      S.lastLogText = txt;
      S.lastActivityAt = now();
      S.lastProgressAt = now();
    }
  }

  let tickN = 0;
  function tick() {
    if (!S.cfg.enabled || S.pausedByUser) return;
    if (S.feeding) return;   // 正在执行一键操作，别抢
    try {
      tickN++;
      // 高频（350ms）：需要抢时间的。innerText 会强制 reflow，所以这一组要尽量短。
      touchActivity();
      if (ensureStarted()) return;
      handleCutscene();
      handleModals();
      handleItemChoice();
      autoSwitch();
      // 低频（约 2 秒）：本身就带长冷却的模块，没必要每 350ms 查一遍 DOM
      if (tickN % 6 === 0) {
        ensureSpeed();
        casinoAuto();
        autoBerry();
        maybeEvolve();
        maybeSave();
      }
    } catch { /* 静默 */ }
  }

  function start() {
    if (document.getElementById('pcauto-hud')) return;
    buildHud();
    renderHud();
    log('info', `挂机助手 v${VERSION} 已启动`);
    if (restoredFrom) {
      // 用章节、图鉴、捕获数核对：游戏启动后会马上再存档（lastTick 变化），不能比较整个字符串
      const cur = saveSummary(readSave());
      const want = restoredFrom.sum;
      const ok = !!want && cur.chapter === want.chapter && cur.dex === want.dex && cur.caught === want.caught;
      log(ok ? 'info' : 'warn', ok ? `存档已恢复到「${restoredFrom.label}」`
          : `存档恢复可能没有生效（${restoredFrom.label}）。如果登录了云存档，游戏可能用云端存档覆盖了本地`);
      if (ok) beep('info');
    }
    if (!HAS_GM) log('warn', '脚本管理器没有提供 GM 存储，存档备份和手机推送不可用');

    // 战报：刷新后 10 分钟内能接上之前的统计
    loadTally();
    S.bootSnap = tallySnap();
    if (!S.awaySnap) { S.awaySnap = tallySnap(); S.awayLastSeen = now(); }

    // 挂到页面的 window 上，控制台里才能访问
    try { PAGE_WIN.__pcauto = { S, version: VERSION, sample, tick, openSettings, setKeepAlive, phaseInfo, nodeIndoor, feedAllCandy, backupNow, openTeamAdvisor, taAnalyze, taSuggestTeam, taEnemyPool, taNextGym }; } catch { /* 忽略 */ }
    ensureRealDescs();   // 先存下原始描述符，之后无论保活开没开，isRealHidden() 都能读到真值
    startGradeWatcher();
    safeInterval('tick', tick, TICK_MS);
    safeInterval('sample', sample, 2000);
    safeInterval('stallCheck', stallCheck, 5000);
    safeInterval('nightGuard', nightGuard, 60000);
    safeInterval('powerGuard', powerGuard, 120000);
    safeInterval('teamAdvisor', taAutoWatch, 60000);
    safeInterval('speedGuard', speedGuard, 60000);
    // 唤醒锁可能被系统释放，定期补申请
    safeInterval('wakeLock', requestWakeLock, 60000);
    safeInterval('backup', maybeBackup, 60000);
    safeInterval('tally', saveTally, 30000);
    // 首次备份等游戏读完档、跑出第一次采样之后再做
    setTimeout(() => { try { maybeBackup(); } catch { /* 忽略 */ } }, 20000);

    requestWakeLock();
    if (S.cfg.keepAlive) setKeepAlive(true).catch(() => {});

    // 注册在 window 的捕获阶段：事件路径是 window(捕获) → document → ...，
    // 挂在 document 上拦不住游戏挂在 window 上的监听。
    PAGE_WIN.addEventListener('visibilitychange', (e) => {
      if (!isRealHidden()) {
        markPresent();
        requestWakeLock();
        S.lastProgressAt = now();
        S.lastTickAt = now();
      } else if (!S.keepAliveOn) {
        log('warn', '标签页切到后台，游戏将暂停');
      }
      if (S.keepAliveOn) {
        e.stopImmediatePropagation();
      }
    }, true);

    // 关闭/刷新标签页前存一次档
    addEventListener('pagehide', () => {
      try { saveTally(); } catch { /* 忽略 */ }
      if (!S.cfg.autoSave || S.restoring) return;   // 恢复存档时绝不能再存一次，会把恢复覆盖掉
      const sb = $('#save-btn');
      if (sb) { try { fire(sb); } catch { /* 忽略 */ } }
    });

    // 玩家真实操作后短暂让路（合成事件 isTrusted=false 不计入）
    const markUser = (e) => {
      if (!e.isTrusted) return;
      S.userAt = now();
      try { markPresent(); } catch { /* 忽略 */ }
    };
    ['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach((ev) =>
        addEventListener(ev, markUser, { capture: true, passive: true }));

    // 快捷键：Alt+P 暂停/继续，Alt+H 隐藏面板
    // 用 e.code：macOS 上 Option+P 的 e.key 是「π」，按 e.key 判断永远不会触发
    addEventListener('keydown', (e) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      const tgt = e.target;
      if (tgt && (tgt.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(tgt.tagName || ''))) return;
      if (e.code === 'KeyP') { e.preventDefault(); S.pausedByUser = !S.pausedByUser; renderHud(); }
      else if (e.code === 'KeyH') { e.preventDefault(); S.cfg.hud = !S.cfg.hud; writeCfg(S.cfg); renderHud(); }
    });
  }

  // 等待游戏渲染出战斗界面后再启动
  const waiter = setInterval(() => {
    if (document.getElementById('app') && document.getElementById('speed-btns')) {
      clearInterval(waiter);
      start();
    }
  }, 500);
})();