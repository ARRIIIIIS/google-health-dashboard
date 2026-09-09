// clawd-pet 全量状态：从官方仓库同步的 148 个 SVG（clawd-*.svg）
// 用 Vite glob 把每个 SVG 作为原始字符串读入，运行时注入 iframe。
// 顺序沿用官方 pets.ts：emotions → activities → working → seasonal → http-status
export const CLAW_SLUGS = [
  // Emotions
  'clawd-angry', 'clawd-bored', 'clawd-celebrating', 'clawd-confused', 'clawd-cool',
  'clawd-crying', 'clawd-dizzy', 'clawd-embarrassed', 'clawd-facepalm', 'clawd-grumpy',
  'clawd-happy', 'clawd-hopeful', 'clawd-jealous', 'clawd-laughing', 'clawd-love',
  'clawd-mindblown', 'clawd-praying', 'clawd-scared', 'clawd-shrug', 'clawd-sick',
  'clawd-sad', 'clawd-smile', 'clawd-evil', 'clawd-surprised', 'clawd-yawning',
  'clawd-hallucinating', 'clawd-skeptical',
  // Activities
  'clawd-astronaut', 'clawd-battery-low', 'clawd-birthday', 'clawd-bowling',
  'clawd-camping', 'clawd-charging', 'clawd-chef', 'clawd-clapping', 'clawd-climbing',
  'clawd-coding', 'clawd-coffee', 'clawd-crab-walking', 'clawd-crafting',
  'clawd-dancing', 'clawd-detective', 'clawd-disconnected', 'clawd-dj',
  'clawd-driving', 'clawd-drumming', 'clawd-eating', 'clawd-error',
  'clawd-fire', 'clawd-fishing', 'clawd-flexing', 'clawd-flying',
  'clawd-gaming', 'clawd-gardening', 'clawd-gift', 'clawd-going-away',
  'clawd-ice-cream', 'clawd-idea', 'clawd-idle-living', 'clawd-king',
  'clawd-lifting', 'clawd-loading', 'clawd-magic', 'clawd-mail',
  'clawd-meditating', 'clawd-money', 'clawd-music', 'clawd-ninja',
  'clawd-notification', 'clawd-painting', 'clawd-peeking', 'clawd-photography',
  'clawd-pirate', 'clawd-podcast', 'clawd-rainbow', 'clawd-reading',
  'clawd-rocket', 'clawd-running', 'clawd-security', 'clawd-shipping',
  'clawd-singing', 'clawd-skateboard', 'clawd-sleeping', 'clawd-snow',
  'clawd-star', 'clawd-static-base', 'clawd-studying', 'clawd-superhero',
  'clawd-surfing', 'clawd-swimming', 'clawd-telescope', 'clawd-time-travel',
  'clawd-trophy', 'clawd-umbrella', 'clawd-waving', 'clawd-yoga',
  // Working
  'clawd-working-beacon', 'clawd-working-building', 'clawd-working-carrying',
  'clawd-working-conducting', 'clawd-working-confused', 'clawd-working-debugger',
  'clawd-working-deploying', 'clawd-working-juggling', 'clawd-working-meeting',
  'clawd-working-merging', 'clawd-working-oncall', 'clawd-working-overheated',
  'clawd-working-pairing', 'clawd-working-pushing', 'clawd-working-reviewing',
  'clawd-working-sweeping', 'clawd-working-testing', 'clawd-working-thinking',
  'clawd-working-typing', 'clawd-working-wizard',
  'clawd-working-context-full', 'clawd-working-tool-calling', 'clawd-working-rubber-duck',
  'clawd-working-firefighting', 'clawd-working-rollback',
  // Seasonal
  'clawd-valentine', 'clawd-halloween', 'clawd-christmas', 'clawd-new-year',
  'clawd-spring', 'clawd-summer', 'clawd-autumn', 'clawd-winter', 'clawd-thanksgiving',
  // HTTP Status
  'clawd-200', 'clawd-201', 'clawd-204', 'clawd-301',
  'clawd-400', 'clawd-401', 'clawd-402', 'clawd-403', 'clawd-404', 'clawd-408', 'clawd-410',
  'clawd-418', 'clawd-429', 'clawd-451',
  'clawd-500', 'clawd-502', 'clawd-503', 'clawd-504',
];

// 将每个 SVG 作为原始字符串读入：{ 'clawd-happy': '<svg ...>', ... }
const rawModules = import.meta.glob('./*.svg', { query: '?raw', eager: true, import: 'default' });
const CLAW = {};
for (const path in rawModules) {
  const name = path.split('/').pop().replace('.svg', '');
  CLAW[name] = rawModules[path];
}

// 仅保留 pets.ts 里声明、且文件确实存在的 slug，顺序不变
export const CLAW_ORDER = CLAW_SLUGS.filter((s) => CLAW[s]);
export { CLAW };
