// 上下文圆环 — web 版,渲染和 cicy-code TeamPanel CtxRing 一致的 SVG 环。
// react-native-web 没有为 unstable_createElement 发布类型,经 any 取用。
const { unstable_createElement: ce } = require('react-native-web') as {
  unstable_createElement: (...args: any[]) => any;
};

export function ctxRingColor(pct: number): string {
  return pct > 80 ? '#b91c1c' : pct > 50 ? '#ca8a04' : '#71717a';
}

export function CtxRing({ pct, size = 12 }: { pct: number; size?: number }) {
  const r = 4.5;
  const c = 2 * Math.PI * r;
  const color = ctxRingColor(pct);
  // 注意:unstable_createElement 的签名是 (type, props, options) —— 不接受
  // varargs children,孩子必须放进 props.children(否则渲染出空 <svg>)。
  return ce('svg', {
    width: size,
    height: size,
    viewBox: '0 0 12 12',
    style: { transform: 'rotate(-90deg)', flexShrink: 0 },
    children: [
      // 亮暗两套主题都可见的中性轨道色
      ce('circle', { key: 'track', cx: 6, cy: 6, r, fill: 'none', stroke: 'rgba(127,127,127,0.28)', strokeWidth: 2.5 }),
      ce('circle', {
        key: 'progress',
        cx: 6,
        cy: 6,
        r,
        fill: 'none',
        stroke: color,
        strokeWidth: 2.5,
        strokeDasharray: `${Math.max(0.5, (pct / 100) * c)} ${c}`,
        strokeLinecap: 'round',
      }),
    ],
  });
}
